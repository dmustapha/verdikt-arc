import type { EvidenceBundle, VerdictResult, VerdictLabel } from '../types.js';
import { VERDICT_CODE } from '../types.js';
import { planSettlement, outcomeForAction, scoreToBps } from '../settlement/tiers.js';
import { hashCanonical } from './hash.js';

// ─────────────────────────────────────────────────────────────────────────────
// WS11 — MOCKED ARBITER  (Gate H1)
//
// HONEST BOUNDARY (read this before trusting anything below):
//   This is a DETERMINISTIC, in-process DEMO STAND-IN for a decentralized dispute oracle. It is NOT
//   real arbitration. A production arbiter (UMA optimistic oracle / Kleros court) posts a bond, opens
//   a multi-hour challenge window, and has independent human/oracle voters resolve the claim — none of
//   which happens here. Every ruling this module returns is marked `arbiter: 'mock'`, and the on-chain
//   settlement it produces is a normal `settle`/`settlePartial` executed by Verdikt's own settlement
//   wallet — there is no separate on-chain arbiter role. Real arbitration is documented as roadmap
//   (MASTER-PLAN PART 5), not faked.
//
// What IS real: the fund-holding (the escrow stays FUNDED on-chain during the dispute), the state
// machine, and the final settlement. What is MOCKED: only the decision function below.
//
// The decision is transparent and evidence-grounded — the arbiter re-reads the SAME evidence bundle
// the engine judged and only overturns when that evidence supports the disputing party. It never
// invents a verdict from nothing, and it can genuinely UPHOLD or OVERTURN (so the demo is meaningful).
// ─────────────────────────────────────────────────────────────────────────────

export type DisputeParty = 'payer' | 'worker';
export type ArbiterOutcome = 'release' | 'refund' | 'partial' | 'abstain';

export interface Dispute {
  by: DisputeParty;   // who contested the proposed verdict
  reason: string;     // their stated reason (recorded, not trusted as evidence)
}

export interface ArbiterRuling {
  arbiter: 'mock';           // the honest boundary flag — surfaced to the API/UI/proof, never hidden
  outcome: ArbiterOutcome;   // the final outcome the arbiter rules
  bps?: number;              // worker's share on a partial ruling (1..9999); undefined otherwise
  upheld: boolean;           // true = agrees with the engine's proposed outcome; false = overturned it
  proposedOutcome: ArbiterOutcome; // what the engine had proposed (for an honest before/after record)
  rationale: string;         // plain-language explanation, anchored to evidence counts
  // The ruling re-shaped as a VerdictResult so it settles through the SAME proven settleVerdict path.
  // Its evidenceHash is a fresh, arbiter-specific hash (distinct from the disputed verdict's), so the
  // on-chain settlement is provably arbiter-anchored.
  verdict: VerdictResult;
}

interface ArbitrateInput {
  workId: `0x${string}`;
  proposed: VerdictResult;   // the engine's held verdict
  evidence: EvidenceBundle;  // the bundle the engine judged (the arbiter's only factual basis)
  dispute: Dispute;
}

const DECISIVE_FAIL = new Set(['fail', 'error']);

// Count the decisive evidence signal. `info` items are non-decisive (context, not a pass/fail).
function tally(evidence: EvidenceBundle): { passes: number; fails: number; decisive: number; failIds: string[]; passIds: string[] } {
  const failIds: string[] = [];
  const passIds: string[] = [];
  for (const it of evidence.items) {
    if (DECISIVE_FAIL.has(it.status)) failIds.push(it.id);
    else if (it.status === 'pass') passIds.push(it.id);
  }
  return { passes: passIds.length, fails: failIds.length, decisive: passIds.length + failIds.length, failIds, passIds };
}

// Map a decided ArbiterOutcome (+ optional bps) into a settle-ready VerdictResult. The LABEL drives the
// on-chain call via planSettlement; a partial carries a score so the split is sized correctly.
function toVerdict(
  outcome: ArbiterOutcome,
  bps: number | undefined,
  proposed: VerdictResult,
  citedEvidence: string[],
  rationale: string,
  evidenceHash: `0x${string}`,
): VerdictResult {
  const label: VerdictLabel =
    outcome === 'release' ? 'pass' : outcome === 'refund' ? 'fail' : outcome === 'abstain' ? 'abstain' : 'partial';
  const score = outcome === 'partial' ? (bps ?? 0) / 100 : outcome === 'release' ? 100 : 0;
  const confidence = score / 100;
  return {
    verdict: label,
    confidence,
    score,
    citedEvidence,
    rationale,
    route: proposed.route,
    evidenceHash,
    verdictCode: VERDICT_CODE[label],
  };
}

// The deterministic mock ruling. Pure: same inputs → same ruling (no clock, no randomness, no network).
export function arbitrate(input: ArbitrateInput): ArbiterRuling {
  const { proposed, evidence, dispute, workId } = input;
  const proposedOutcome = outcomeForAction(planSettlement(proposed)) as ArbiterOutcome;
  const { passes, fails, decisive, failIds, passIds } = tally(evidence);

  let outcome: ArbiterOutcome = proposedOutcome; // default: UPHOLD
  let bps: number | undefined = proposedOutcome === 'partial' ? scoreToBps(proposed.score ?? proposed.confidence * 100) : undefined;
  let cited: string[] = proposed.citedEvidence;
  let why: string;

  const buyerGrievance = dispute.by === 'payer' && (proposedOutcome === 'release' || proposedOutcome === 'partial');
  const sellerGrievance = dispute.by === 'worker' && (proposedOutcome === 'refund' || proposedOutcome === 'partial' || proposedOutcome === 'abstain');

  if (buyerGrievance && fails > 0) {
    // The buyer says the payout was too generous, and the evidence shows real failures → overturn DOWN.
    if (passes === 0) {
      outcome = 'refund'; bps = undefined; cited = failIds;
      why = `Buyer dispute upheld: all ${fails} decisive evidence item(s) failed and none passed, so the deliverable does not meet acceptance — the bounty is refunded.`;
    } else {
      bps = Math.max(1, Math.min(9999, scoreToBps((passes / decisive) * 100)));
      outcome = 'partial'; cited = [...passIds, ...failIds];
      why = `Buyer dispute partly upheld: ${passes}/${decisive} decisive checks passed, so the worker earns a proportional ${(bps / 100).toFixed(2)}% split and the buyer is refunded the remainder.`;
    }
  } else if (sellerGrievance && fails === 0 && passes > 0) {
    // The seller says the refusal was too harsh, and the evidence shows no failures → overturn UP.
    outcome = 'release'; bps = undefined; cited = passIds;
    why = `Worker dispute upheld: all ${passes} decisive evidence item(s) passed with zero failures, so the deliverable meets acceptance — the bounty is released.`;
  } else {
    // No evidentiary basis to overturn → the engine's verdict stands. (Includes disputes whose direction
    // does not match a plausible grievance, and grievances the evidence does not support.)
    why = `Dispute reviewed and the original verdict (${proposedOutcome}) stands: the recorded evidence (${passes} pass / ${fails} fail) does not support the ${dispute.by}'s claim.`;
  }

  const upheld = outcome === proposedOutcome;
  const rationale = `[MOCK ARBITER] ${why}`;

  // Anchor the ruling with a fresh, deterministic hash distinct from the disputed verdict's, binding
  // the workId + who disputed + the before/after outcome + the evidence the arbiter leaned on.
  const evidenceHash = hashCanonical({
    kind: 'verdikt:arbiter-ruling:mock',
    workId,
    disputedBy: dispute.by,
    disputeReason: dispute.reason,
    proposedOutcome,
    ruling: { outcome, bps: bps ?? null },
    citedEvidence: cited,
  });

  return {
    arbiter: 'mock',
    outcome,
    bps,
    upheld,
    proposedOutcome,
    rationale,
    verdict: toVerdict(outcome, bps, proposed, cited, rationale, evidenceHash),
  };
}
