import type { Acceptance, Artifact, EvidenceBundle, EvidenceItem } from '../types.js';
import { callTool } from './llm.js';

const CLAIM_TOOL = {
  name: 'report_grounding',
  description: 'Report whether the answer\'s key claim is supported by a verbatim span in the provided sources.',
  input_schema: {
    type: 'object' as const,
    properties: {
      key_claim: { type: 'string', description: 'the single load-bearing claim in the answer' },
      label: { type: 'string', enum: ['supported', 'unsupported', 'uncertain'] },
      supporting_span: { type: 'string', description: 'verbatim substring copied from the sources, or empty' },
    },
    required: ['key_claim', 'label', 'supporting_span'],
  },
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export async function runGroundingRoute(acceptance: Acceptance, artifact: Artifact): Promise<EvidenceBundle> {
  if (!acceptance.sources || acceptance.sources.trim() === '') {
    return { route: 'answer', items: [], routeError: 'payer provided no sources' };
  }

  let toolInput: { key_claim: string; label: string; supporting_span: string };
  try {
    const input = await callTool({
      tool: CLAIM_TOOL,
      maxTokens: 1024,
      userContent:
        `SOURCES (the only ground truth):\n${acceptance.sources}\n\n` +
        `ANSWER to verify:\n${artifact.payload}\n\n` +
        `Find the answer's single key claim. Copy a verbatim supporting span from SOURCES if one exists. ` +
        `If no verbatim span supports it, label unsupported. If you are unsure, label uncertain. Do not invent spans.`,
    });
    if (!input) {
      return { route: 'answer', items: [], routeError: 'grounding model returned no structured result' };
    }
    toolInput = input as typeof toolInput;
  } catch (err) {
    return { route: 'answer', items: [], routeError: `grounding API error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Deterministic entailment gate (V2 fix): a "supported" label from the model is NOT enough. The
  // span must (a) appear VERBATIM in the sources, (b) be SUBSTANTIVE (≥6 content tokens, 24–400
  // chars) so a trivial span like "the" cannot pass, and (c) actually COVER the claim (claim-token
  // recall ≥ 0.5). The model proposes; these lexical checks dispose — so the route stops being
  // "just an LLM" and a degenerate/injected model cannot certify a trivially-present span.
  const span = toolInput.supporting_span ?? '';
  const spanNorm = normalize(span);
  const sourcesNorm = normalize(acceptance.sources);

  const spanTokens = spanNorm.match(/[a-z0-9]+/g) ?? [];
  const claimTokens = new Set(normalize(toolInput.key_claim).match(/[a-z0-9]+/g) ?? []);
  const spanTokenSet = new Set(spanTokens);
  const overlap = [...claimTokens].filter((t) => spanTokenSet.has(t)).length;
  const claimRecall = claimTokens.size > 0 ? overlap / claimTokens.size : 0;

  const verbatim = span.length > 0 && sourcesNorm.includes(spanNorm);
  const substantive = spanTokens.length >= 6 && span.length >= 24 && span.length <= 400;
  const coversClaim = claimRecall >= 0.5;
  const verified = toolInput.label === 'supported' && verbatim && substantive && coversClaim;

  const reason =
    !verbatim ? 'span not found verbatim in sources'
    : !substantive ? 'span too short to be substantive evidence'
    : !coversClaim ? `span covers only ${Math.round(claimRecall * 100)}% of the claim tokens`
    : toolInput.label !== 'supported' ? `model labeled the claim ${toolInput.label}`
    : 'verified';

  const items: EvidenceItem[] = [{
    id: 'span:key_claim',
    kind: 'span',
    label: 'key claim grounding',
    status: verified ? 'pass' : 'info',
    detail: `claim: "${toolInput.key_claim.slice(0, 160)}" — label=${toolInput.label}, ${reason}`,
    ref: verbatim ? span.slice(0, 160) : undefined,
  }];

  // Abstain-heavy by design: anything short of a verified, substantive, claim-covering span signals
  // abstain to the reasoner (refund-to-payer). False-certifying an answer is worse than none.
  const routeError = verified ? undefined : `claim not verifiably supported: ${reason}`;

  return { route: 'answer', items, routeError };
}
