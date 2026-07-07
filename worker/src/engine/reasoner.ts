import type { EvidenceBundle, VerdictResult, VerdictLabel } from '../types.js';
import { VERDICT_CODE } from '../types.js';
import { confidenceToScore } from '../settlement/tiers.js';
import { hashEvidence } from '../lib/hash.js';
import { callTool } from './llm.js';

const VERDICT_TOOL = {
  name: 'emit_verdict',
  description: 'Emit a verdict over the evidence bundle. Cite the exact evidence ids you relied on.',
  input_schema: {
    type: 'object' as const,
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail', 'partial', 'abstain'] },
      confidence: {
        type: 'number', minimum: 0, maximum: 1,
        description:
          'For pass/fail/abstain: your confidence in the verdict. For "partial": the FRACTION of the ' +
          'bounty the delivered work has genuinely earned (0=nothing, 1=all) — this value directly ' +
          'sizes the on-chain payment split, so set it to the fair share, not your certainty.',
      },
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
  'Rules: (1) NEVER pass if any evidence item has status "fail" — a failed test, a static ' +
  'security finding, a failed schema check, or an unsupported claim span is each disqualifying. ' +
  '(2) NEVER pass if the bundle has a routeError. ' +
  '(3) Abstain when evidence is missing, contradictory, or insufficient to be confident. ' +
  '(4) Conservative-on-pass: when unsure between pass and anything else, do not pass. ' +
  '(5) Use "partial" ONLY when the work is genuinely partially acceptable (some deliverables met, ' +
  'others not) — and set confidence to the fraction of the bounty that share is worth, since it ' +
  'directly sizes the on-chain split. If nothing is acceptable, fail; if you cannot tell, abstain. ' +
  'Cite the exact evidence ids you used.';

function deterministicFloor(bundle: EvidenceBundle): VerdictLabel | null {
  // Hard rules the model cannot override — computed from the bundle, not asked of the LLM.
  if (bundle.routeError) return 'abstain';            // MUST stay first: grounding 'info' rides here
  if (bundle.items.length === 0) return 'abstain';
  // Any failing item disqualifies across EVERY route — test, static, schema_check, or span.
  // routeError is checked first, so grounding's uncertain/unmatched path (status 'info' + routeError)
  // abstains rather than fails; only a hard status==='fail' lands here.
  if (bundle.items.some((i) => i.status === 'fail')) return 'fail';
  return null;
}

export async function reasonOverEvidence(bundle: EvidenceBundle): Promise<VerdictResult> {
  const evidenceHash = hashEvidence(bundle);
  const floor = deterministicFloor(bundle);

  const base = (verdict: VerdictLabel, cited: string[], rationale: string, confidence: number, abstainReason?: string): VerdictResult => ({
    verdict, confidence, score: confidenceToScore(confidence), citedEvidence: cited, rationale, abstainReason,
    route: bundle.route, evidenceHash, verdictCode: VERDICT_CODE[verdict],
  });

  // Short-circuit the disqualifying cases deterministically. Cite whatever evidence is
  // present (e.g. the grounding span item) so the abstain shows its reason in the UI.
  if (floor === 'abstain') {
    const reason = bundle.routeError ?? 'insufficient evidence';
    return base('abstain', bundle.items.map((i) => i.id), reason, 0.2, reason);
  }

  // Deterministic-first: a disqualifying bundle (a failed test, a static security finding, a failed
  // schema check, or an unsupported claim span) FAILS without ever calling the LLM. The refund
  // settles in seconds and never depends on the model or API availability. The model is consulted
  // ONLY to certify a pass over a silent floor — it can never overturn a deterministic fail.
  if (floor === 'fail') {
    const cited = bundle.items.filter((i) => i.status === 'fail').map((i) => i.id);
    return base('fail', cited, 'deterministic floor: disqualifying evidence present', 0.95);
  }

  // The pluggable reasoner seam (Anthropic native or any OpenAI-compatible provider). The model is
  // consulted ONLY to certify a pass over a silent floor — it can never overturn a deterministic fail.
  let parsed: { verdict: VerdictLabel; confidence: number; cited_evidence: string[]; rationale: string; abstain_reason?: string };
  try {
    const input = await callTool({
      system: SYSTEM,
      tool: VERDICT_TOOL,
      maxTokens: 1024,
      userContent: `EvidenceBundle:\n${JSON.stringify(bundle, null, 2)}`,
    });
    if (!input) {
      // Floor is silent here (a fail already returned above). No structured output means we cannot
      // certify a pass → abstain. Never fabricate a pass on a clean-but-unverified bundle.
      return base('abstain', [], 'reasoner returned no structured verdict', 0.1, 'no structured output');
    }
    parsed = input as typeof parsed;
  } catch (err) {
    // Floor is silent here (a fail already returned above). With Claude unavailable we cannot
    // certify a pass over silent evidence → abstain (refund-to-payer), never fabricate a pass.
    return base('abstain', [], `reasoner API error`, 0.1, err instanceof Error ? err.message : String(err));
  }

  // Guard: every cited id must exist in the bundle, else force abstain (anti-hallucination).
  const validIds = new Set(bundle.items.map((i) => i.id));
  const fabricated = parsed.cited_evidence.filter((id) => !validIds.has(id));
  if (fabricated.length > 0) {
    return base('abstain', [], `fabricated citation(s): ${fabricated.join(', ')}`, 0.1, 'fabricated citation');
  }

  return base(parsed.verdict, parsed.cited_evidence, parsed.rationale, parsed.confidence, parsed.abstain_reason);
}
