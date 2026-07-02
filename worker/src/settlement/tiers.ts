import type { VerdictResult, Outcome } from '../types.js';

// Confidence tiers — the single source of truth for turning a verdict into an on-chain settlement
// call. WS2.1: the engine emits {label, score 0..100}; pass/fail/abstain settle() and `partial`
// settlePartial() with a real bps split.

// Confidence (0..1) → score (0..100 integer). The engine's public tier signal.
export function confidenceToScore(confidence: number): number {
  const c = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  return Math.round(c * 100);
}

// score (0..100) → bps (0..10000). Pure linear map (MASTER-PLAN WS2.1: bps = score*100).
export function scoreToBps(score: number): number {
  const s = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
  return Math.round(s * 100);
}

// settlePartial's on-chain guard is bps ∈ (0, 1e4) EXCLUSIVE. A `partial` verdict always yields a
// real split, so we clamp into the valid open interval: the worker earns ≥1bps and the payer keeps
// ≥1bps. The LABEL — not the score — decides release/refund/split; the score only SIZES the split.
// This keeps the money-safety invariant crisp: only `pass` releases, only fail/abstain refund, only
// `partial` splits. (Retires the interim onChainSettleCode() that downgraded partial → refund.)
const MIN_PARTIAL_BPS = 1;
const MAX_PARTIAL_BPS = 9999;

export type SettlementAction =
  | { kind: 'settle'; code: 0 | 1 | 3 }        // pass=0 / fail=1 / abstain=3  → settle()
  | { kind: 'settlePartial'; bps: number };    // partial split, bps ∈ [1, 9999] → settlePartial()

// The score a verdict settles on: the engine-emitted score, or derived from confidence as a fallback
// (so pre-WS2 fixtures and the pre-settle SSE label both resolve without an explicit score).
function scoreOf(v: Pick<VerdictResult, 'score' | 'confidence'>): number {
  return typeof v.score === 'number' ? v.score : confidenceToScore(v.confidence);
}

// Verdict → on-chain settlement call. THE routing gate for confidence tiers.
export function planSettlement(v: Pick<VerdictResult, 'verdict' | 'score' | 'confidence'>): SettlementAction {
  switch (v.verdict) {
    case 'pass':    return { kind: 'settle', code: 0 };
    case 'fail':    return { kind: 'settle', code: 1 };
    case 'abstain': return { kind: 'settle', code: 3 };
    case 'partial': {
      const bps = Math.max(MIN_PARTIAL_BPS, Math.min(MAX_PARTIAL_BPS, scoreToBps(scoreOf(v))));
      return { kind: 'settlePartial', bps };
    }
  }
}

// Off-chain Outcome label for a settlement action (DB / SSE / receipt display). MUST agree with the
// contract's on-chain outcome enum: release=0 refund=1 abstain=2 partial=3.
export function outcomeForAction(a: SettlementAction): Outcome {
  if (a.kind === 'settlePartial') return 'partial';
  return a.code === 0 ? 'release' : a.code === 3 ? 'abstain' : 'refund';
}
