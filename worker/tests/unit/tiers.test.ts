// WS2 Gate B1 — confidence tiers: verdict → escrow call routing + score→bps math.
// Locks: pass/fail/abstain → settle(); partial → settlePartial() with a clamped, in-range bps.
// The LABEL decides release/refund/split; the SCORE only sizes a partial split.
import { describe, it, expect } from 'vitest';
import {
  confidenceToScore, scoreToBps, planSettlement, outcomeForAction, type SettlementAction,
} from '../../src/settlement/tiers.js';
import type { VerdictResult, VerdictLabel } from '../../src/types.js';

function mk(verdict: VerdictLabel, score?: number, confidence = 1): VerdictResult {
  return {
    verdict, score, confidence, citedEvidence: [], rationale: '', route: 'code',
    evidenceHash: ('0x' + '11'.repeat(32)) as `0x${string}`,
    verdictCode: { pass: 0, fail: 1, partial: 2, abstain: 3 }[verdict],
  };
}

describe('confidenceToScore (0..1 → 0..100)', () => {
  it('maps the range', () => {
    expect(confidenceToScore(0)).toBe(0);
    expect(confidenceToScore(0.5)).toBe(50);
    expect(confidenceToScore(0.75)).toBe(75);
    expect(confidenceToScore(1)).toBe(100);
  });
  it('clamps out-of-range / non-finite', () => {
    expect(confidenceToScore(-1)).toBe(0);
    expect(confidenceToScore(2)).toBe(100);
    expect(confidenceToScore(NaN)).toBe(0);
  });
});

describe('scoreToBps (0..100 → 0..10000) — boundary correctness', () => {
  it('boundaries 0 / 50 / 100', () => {
    expect(scoreToBps(0)).toBe(0);
    expect(scoreToBps(50)).toBe(5000);
    expect(scoreToBps(100)).toBe(10000);
  });
  it('interior + clamp', () => {
    expect(scoreToBps(70)).toBe(7000);
    expect(scoreToBps(1)).toBe(100);
    expect(scoreToBps(150)).toBe(10000);
    expect(scoreToBps(-5)).toBe(0);
  });
});

describe('planSettlement — verdict label → escrow call', () => {
  it('pass → settle(0)', () => expect(planSettlement(mk('pass'))).toEqual({ kind: 'settle', code: 0 }));
  it('fail → settle(1)', () => expect(planSettlement(mk('fail'))).toEqual({ kind: 'settle', code: 1 }));
  it('abstain → settle(3)', () => expect(planSettlement(mk('abstain'))).toEqual({ kind: 'settle', code: 3 }));

  it('partial(score 50) → settlePartial(5000)', () =>
    expect(planSettlement(mk('partial', 50))).toEqual({ kind: 'settlePartial', bps: 5000 }));
  it('partial(score 70) → settlePartial(7000)', () =>
    expect(planSettlement(mk('partial', 70))).toEqual({ kind: 'settlePartial', bps: 7000 }));

  // Boundary CLAMP into the contract's open interval (0,1e4): a partial always splits.
  it('partial(score 0) → settlePartial(1) — clamped, never sent as 0', () =>
    expect(planSettlement(mk('partial', 0))).toEqual({ kind: 'settlePartial', bps: 1 }));
  it('partial(score 100) → settlePartial(9999) — clamped, never sent as 10000', () =>
    expect(planSettlement(mk('partial', 100))).toEqual({ kind: 'settlePartial', bps: 9999 }));

  it('partial falls back to confidence when score omitted', () =>
    expect(planSettlement(mk('partial', undefined, 0.6))).toEqual({ kind: 'settlePartial', bps: 6000 }));

  it('every partial bps is strictly inside (0, 10000)', () => {
    for (let s = 0; s <= 100; s++) {
      const a = planSettlement(mk('partial', s)) as Extract<SettlementAction, { kind: 'settlePartial' }>;
      expect(a.kind).toBe('settlePartial');
      expect(a.bps).toBeGreaterThan(0);
      expect(a.bps).toBeLessThan(10000);
    }
  });
});

describe('outcomeForAction — off-chain label matches on-chain outcome enum', () => {
  it('settle(0)=release, settle(1)=refund, settle(3)=abstain', () => {
    expect(outcomeForAction({ kind: 'settle', code: 0 })).toBe('release');
    expect(outcomeForAction({ kind: 'settle', code: 1 })).toBe('refund');
    expect(outcomeForAction({ kind: 'settle', code: 3 })).toBe('abstain');
  });
  it('settlePartial → partial', () =>
    expect(outcomeForAction({ kind: 'settlePartial', bps: 5000 })).toBe('partial'));

  // Money-safety invariant: fail & abstain NEVER release; only pass releases; partial never releases.
  it('only pass ever maps to release', () => {
    for (const v of ['fail', 'abstain'] as const) {
      expect(outcomeForAction(planSettlement(mk(v)))).not.toBe('release');
    }
    for (let s = 0; s <= 100; s++) {
      expect(outcomeForAction(planSettlement(mk('partial', s)))).toBe('partial');
    }
    expect(outcomeForAction(planSettlement(mk('pass')))).toBe('release');
  });
});
