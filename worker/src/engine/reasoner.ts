import Anthropic from '@anthropic-ai/sdk';
import type { EvidenceBundle, VerdictResult, VerdictLabel } from '../types.js';
import { VERDICT_CODE } from '../types.js';
import { hashEvidence } from '../lib/hash.js';

const MODEL = process.env.REASONER_MODEL ?? 'claude-sonnet-4-6';

const VERDICT_TOOL = {
  name: 'emit_verdict',
  description: 'Emit a verdict over the evidence bundle. Cite the exact evidence ids you relied on.',
  input_schema: {
    type: 'object' as const,
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail', 'partial', 'abstain'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      cited_evidence: { type: 'array', items: { type: 'string' }, description: 'evidence ids from the bundle' },
      rationale: { type: 'string' },
      abstain_reason: { type: 'string' },
    },
    required: ['verdict', 'confidence', 'cited_evidence', 'rationale'],
  },
};

const SYSTEM =
  'You are an evidence arbiter that decides whether to release escrowed money for delivered work. ' +
  'Reason ONLY over the provided EvidenceBundle — never the raw artifact, never outside knowledge. ' +
  'Rules: (1) NEVER pass if any item with kind "test" has status "fail". ' +
  '(2) NEVER pass if any item with kind "static" exists (security findings are disqualifying). ' +
  '(3) NEVER pass if the bundle has a routeError. ' +
  '(4) Abstain when evidence is missing, contradictory, or insufficient to be confident. ' +
  '(5) Conservative-on-pass: when unsure between pass and anything else, do not pass. ' +
  'Cite the exact evidence ids you used.';

function deterministicFloor(bundle: EvidenceBundle): VerdictLabel | null {
  // Hard rules the model cannot override — computed from the bundle, not asked of the LLM.
  if (bundle.routeError) return 'abstain';
  if (bundle.items.length === 0) return 'abstain';
  if (bundle.items.some((i) => i.kind === 'static')) return 'fail';
  if (bundle.items.some((i) => i.kind === 'test' && i.status === 'fail')) return 'fail';
  return null;
}

export async function reasonOverEvidence(bundle: EvidenceBundle): Promise<VerdictResult> {
  const evidenceHash = hashEvidence(bundle);
  const floor = deterministicFloor(bundle);

  const base = (verdict: VerdictLabel, cited: string[], rationale: string, confidence: number, abstainReason?: string): VerdictResult => ({
    verdict, confidence, citedEvidence: cited, rationale, abstainReason,
    route: bundle.route, evidenceHash, verdictCode: VERDICT_CODE[verdict],
  });

  // Short-circuit the disqualifying cases deterministically. Cite whatever evidence is
  // present (e.g. the grounding span item) so the abstain shows its reason in the UI.
  if (floor === 'abstain') {
    const reason = bundle.routeError ?? 'insufficient evidence';
    return base('abstain', bundle.items.map((i) => i.id), reason, 0.2, reason);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  let parsed: { verdict: VerdictLabel; confidence: number; cited_evidence: string[]; rationale: string; abstain_reason?: string };
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tool_choice: { type: 'tool', name: 'emit_verdict' },
      tools: [VERDICT_TOOL],
      messages: [{ role: 'user', content: `EvidenceBundle:\n${JSON.stringify(bundle, null, 2)}` }],
    });
    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      // DEV-005: no structured output → fall back to the deterministic floor so a disqualifying
      // bundle still fails (never silently abstains away a known fail); else abstain.
      if (floor === 'fail') {
        const cited = bundle.items.filter((i) => i.kind === 'static' || (i.kind === 'test' && i.status === 'fail')).map((i) => i.id);
        return base('fail', cited, 'deterministic floor: disqualifying evidence present (no structured output)', 0.9);
      }
      return base('abstain', [], 'reasoner returned no structured verdict', 0.1, 'no structured output');
    }
    parsed = block.input as typeof parsed;
  } catch (err) {
    // API error never fabricates a PASS. DEV-005: if the deterministic floor already says fail
    // (a static finding or failed payer test), honor that fail even with Claude down — the hero
    // refund must not depend on API availability. Only when the floor is silent do we abstain.
    if (floor === 'fail') {
      const cited = bundle.items.filter((i) => i.kind === 'static' || (i.kind === 'test' && i.status === 'fail')).map((i) => i.id);
      return base('fail', cited, 'deterministic floor: disqualifying evidence present (reasoner API unavailable)', 0.9);
    }
    return base('abstain', [], `reasoner API error`, 0.1, err instanceof Error ? err.message : String(err));
  }

  // Guard 1: every cited id must exist in the bundle, else force abstain.
  const validIds = new Set(bundle.items.map((i) => i.id));
  const fabricated = parsed.cited_evidence.filter((id) => !validIds.has(id));
  if (fabricated.length > 0) {
    return base('abstain', [], `fabricated citation(s): ${fabricated.join(', ')}`, 0.1, 'fabricated citation');
  }

  // Guard 2: deterministic floor overrides an over-optimistic model (fail beats pass).
  if (floor === 'fail' && parsed.verdict === 'pass') {
    return base('fail', parsed.cited_evidence, 'deterministic floor: disqualifying evidence present', Math.max(parsed.confidence, 0.9));
  }

  return base(parsed.verdict, parsed.cited_evidence, parsed.rationale, parsed.confidence, parsed.abstain_reason);
}
