import Anthropic from '@anthropic-ai/sdk';
import type { Acceptance, Artifact, EvidenceBundle, EvidenceItem } from '../types.js';

const MODEL = process.env.GROUNDING_MODEL ?? 'claude-sonnet-4-6';

// F1: upgrade the grounding route from a single key-claim + lexical-overlap gate to claim
// DECOMPOSITION + per-claim ENTAILMENT + deterministic aggregation (RAGAS-faithfulness style).
//   1. decompose the answer into atomic claims (LLM)
//   2. score each claim against the sources: entailed | not_entailed | contradicted (pluggable scorer)
//   3. require a verbatim-locatable span per entailed claim (deterministic anchor, not the LLM's word)
//   4. aggregate: any contradiction => fail; all entailed+located => pass; otherwise => abstain
// The scorer is pluggable: default is the LLM; an optional in-process NLI model (transformers.js)
// can be enabled with GROUNDING_NLI=true (best-effort dynamic import, falls back to the LLM).

export type EntailLabel = 'entailed' | 'not_entailed' | 'contradicted';
export interface ClaimVerdict { claim: string; label: EntailLabel; span: string; score: number }

function normalize(s: string): string { return s.toLowerCase().replace(/\s+/g, ' ').trim(); }
function client(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, fetch: (...a) => globalThis.fetch(...a) });
}

const DECOMPOSE_TOOL = {
  name: 'emit_claims',
  description: 'Break the answer into atomic, individually-checkable factual claims.',
  input_schema: {
    type: 'object' as const,
    properties: { claims: { type: 'array', items: { type: 'string' }, description: 'atomic claims, each one verifiable in isolation' } },
    required: ['claims'],
  },
};

const ENTAIL_TOOL = {
  name: 'emit_entailments',
  description: 'For each claim, decide whether the SOURCES entail it, and copy a verbatim supporting span.',
  input_schema: {
    type: 'object' as const,
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            label: { type: 'string', enum: ['entailed', 'not_entailed', 'contradicted'] },
            supporting_span: { type: 'string', description: 'verbatim substring from SOURCES, or empty' },
          },
          required: ['claim', 'label', 'supporting_span'],
        },
      },
    },
    required: ['results'],
  },
};

async function decompose(answer: string): Promise<string[]> {
  const res = await client().messages.create({
    model: MODEL, max_tokens: 1024, tool_choice: { type: 'tool', name: 'emit_claims' }, tools: [DECOMPOSE_TOOL],
    messages: [{ role: 'user', content: `Decompose this answer into atomic factual claims:\n\n${answer}` }],
  });
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') return [];
  const claims = (block.input as { claims?: string[] }).claims ?? [];
  return claims.filter((c) => typeof c === 'string' && c.trim().length > 0).slice(0, 20);
}

// LLM entailment scorer (default). Returns a per-claim label + proposed span.
async function entailLLM(sources: string, claims: string[]): Promise<Array<{ claim: string; label: EntailLabel; span: string }>> {
  const res = await client().messages.create({
    model: MODEL, max_tokens: 2048, tool_choice: { type: 'tool', name: 'emit_entailments' }, tools: [ENTAIL_TOOL],
    messages: [{
      role: 'user',
      content: `SOURCES (the only ground truth):\n${sources}\n\nCLAIMS:\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n` +
        `For each claim, label entailed only if the SOURCES support it, contradicted if the SOURCES refute it, else not_entailed. Copy a verbatim span from SOURCES when entailed.`,
    }],
  });
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') return claims.map((c) => ({ claim: c, label: 'not_entailed' as EntailLabel, span: '' }));
  const results = (block.input as { results?: Array<{ claim: string; label: EntailLabel; supporting_span: string }> }).results ?? [];
  return claims.map((c) => {
    const r = results.find((x) => normalize(x.claim).includes(normalize(c).slice(0, 40)) || normalize(c).includes(normalize(x.claim).slice(0, 40)));
    return { claim: c, label: (r?.label ?? 'not_entailed') as EntailLabel, span: r?.supporting_span ?? '' };
  });
}

// Optional in-process NLI scorer (transformers.js cross-encoder). Best-effort: if the model can't be
// loaded (not installed / too heavy), the caller falls back to the LLM scorer. Returns null on failure.
async function entailNLI(sources: string, claims: string[]): Promise<Array<{ claim: string; label: EntailLabel; score: number }> | null> {
  try {
    const tf = await import('@huggingface/transformers' as string).catch(() => null);
    if (!tf) return null;
    const nli = await (tf as { pipeline: (t: string, m: string, o?: unknown) => Promise<unknown> })
      .pipeline('text-classification', 'Xenova/nli-deberta-v3-xsmall', { quantized: true });
    const run = nli as (input: unknown, opts?: unknown) => Promise<Array<{ label: string; score: number }>>;
    const out: Array<{ claim: string; label: EntailLabel; score: number }> = [];
    for (const c of claims) {
      const r = await run({ text: sources, text_pair: c }, { top_k: null });
      const top = Array.isArray(r) ? r.reduce((a, b) => (b.score > a.score ? b : a)) : { label: 'neutral', score: 0 };
      const lbl = top.label.toLowerCase();
      out.push({ claim: c, score: top.score, label: lbl.includes('entail') ? 'entailed' : lbl.includes('contra') ? 'contradicted' : 'not_entailed' });
    }
    return out;
  } catch {
    return null;
  }
}

export async function runGroundingV2(acceptance: Acceptance, artifact: Artifact): Promise<EvidenceBundle> {
  if (!acceptance.sources || acceptance.sources.trim() === '') {
    return { route: 'answer', items: [], routeError: 'payer provided no sources' };
  }

  let claims: string[];
  try { claims = await decompose(artifact.payload); }
  catch (err) { return { route: 'answer', items: [], routeError: `grounding decompose error: ${err instanceof Error ? err.message : String(err)}` }; }
  if (claims.length === 0) return { route: 'answer', items: [], routeError: 'no checkable claims extracted' };

  const sourcesNorm = normalize(acceptance.sources);

  // Score claims. Prefer the NLI model if enabled + available; else the LLM. The LLM also supplies
  // the candidate spans we then verify verbatim against the sources (deterministic anchor).
  let verdicts: ClaimVerdict[];
  const nli = process.env.GROUNDING_NLI === 'true' ? await entailNLI(acceptance.sources, claims) : null;
  const llm = await entailLLM(acceptance.sources, claims); // always run for spans
  if (nli) {
    verdicts = claims.map((c, i) => ({ claim: c, label: nli[i]?.label ?? 'not_entailed', span: llm[i]?.span ?? '', score: nli[i]?.score ?? 0 }));
  } else {
    verdicts = llm.map((r) => ({ claim: r.claim, label: r.label, span: r.span, score: r.label === 'entailed' ? 1 : 0 }));
  }

  // Deterministic per-claim gate: an "entailed" claim must have a verbatim-locatable span in SOURCES.
  const items: EvidenceItem[] = [];
  let anyContradiction = false, allEntailed = true;
  verdicts.forEach((v, i) => {
    const located = v.span.length > 0 && sourcesNorm.includes(normalize(v.span));
    const ok = v.label === 'entailed' && located;
    if (v.label === 'contradicted') anyContradiction = true;
    if (!ok) allEntailed = false;
    items.push({
      id: `span:claim_${i}`, kind: 'span', label: `claim ${i + 1}`,
      status: v.label === 'contradicted' ? 'fail' : ok ? 'pass' : 'info',
      detail: `"${v.claim.slice(0, 120)}" — ${v.label}${located ? ', span located' : ', span NOT located'}`,
      ref: located ? v.span.slice(0, 160) : undefined,
    });
  });

  // Aggregate: any contradiction => fail (refund); all entailed+located => pass; else abstain.
  const routeError = anyContradiction ? undefined
    : allEntailed ? undefined
    : 'not all claims are verifiably grounded in the provided sources';
  return { route: 'answer', items, routeError };
}
