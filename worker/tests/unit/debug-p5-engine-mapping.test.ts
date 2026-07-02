// Debug Phase 5.4 — verdict→outcome mapping integrity (ported from the orphaned node:test
// tests/unit/types.test.ts into vitest so it runs in the suite). These constants map verdict
// labels / outcomes to the exact uint8 values VerdiktEscrow.sol reads; drift here silently
// mis-settles money. Cross-checked against contracts/src/VerdiktEscrow.sol:
//   OUTCOME_RELEASE=0 (worker), OUTCOME_REFUND=1 (payer), OUTCOME_ABSTAIN=2 (payer default)
//   verdictCode 0=pass 1=fail 2=partial 3=abstain
import { describe, it, expect } from 'vitest';
import { VERDICT_CODE, OUTCOME_CODE } from '../../src/types.js';
import { outcomeFor } from '../../src/settlement/settle.js';
import type { VerdictResult } from '../../src/types.js';

describe('VERDICT_CODE matches on-chain uint8 contract', () => {
  it('pass=0 fail=1 partial=2 abstain=3', () => {
    expect(VERDICT_CODE.pass).toBe(0);
    expect(VERDICT_CODE.fail).toBe(1);
    expect(VERDICT_CODE.partial).toBe(2);
    expect(VERDICT_CODE.abstain).toBe(3);
  });
  it('exactly four verdict labels, codes unique', () => {
    expect(Object.keys(VERDICT_CODE).sort()).toEqual(['abstain', 'fail', 'partial', 'pass']);
    const vals = Object.values(VERDICT_CODE);
    expect(new Set(vals).size).toBe(vals.length);
  });
});

describe('OUTCOME_CODE matches on-chain uint8 contract', () => {
  it('release=0 refund=1 abstain=2 partial=3', () => {
    expect(OUTCOME_CODE.release).toBe(0);
    expect(OUTCOME_CODE.refund).toBe(1);
    expect(OUTCOME_CODE.abstain).toBe(2);
    expect(OUTCOME_CODE.partial).toBe(3); // WS2: partial split is a distinct on-chain outcome
  });
  it('exactly four outcomes, codes unique', () => {
    expect(Object.keys(OUTCOME_CODE).sort()).toEqual(['abstain', 'partial', 'refund', 'release']);
    const vals = Object.values(OUTCOME_CODE);
    expect(new Set(vals).size).toBe(vals.length);
  });
});

describe('verdict → outcome mapping (settlement direction)', () => {
  const mk = (verdict: VerdictResult['verdict']): VerdictResult => ({
    verdict, confidence: 1, citedEvidence: [], rationale: '', route: 'code',
    evidenceHash: '0x00', verdictCode: VERDICT_CODE[verdict],
  });

  it('pass → release (to worker)', () => {
    expect(outcomeFor(mk('pass'))).toBe('release');
    expect(OUTCOME_CODE[outcomeFor(mk('pass'))]).toBe(0);
  });
  it('fail → refund (to payer)', () => {
    expect(outcomeFor(mk('fail'))).toBe('refund');
    expect(OUTCOME_CODE[outcomeFor(mk('fail'))]).toBe(1);
  });
  it('partial → partial (real bps split via settlePartial, WS2)', () => {
    expect(outcomeFor(mk('partial'))).toBe('partial');
    expect(OUTCOME_CODE[outcomeFor(mk('partial'))]).toBe(3);
  });
  it('abstain → abstain-default (to payer, code 2 — never release)', () => {
    expect(outcomeFor(mk('abstain'))).toBe('abstain');
    expect(OUTCOME_CODE[outcomeFor(mk('abstain'))]).toBe(2);
  });

  it('ONLY a pass verdict ever maps to a worker release', () => {
    for (const v of ['fail', 'partial', 'abstain'] as const) {
      expect(OUTCOME_CODE[outcomeFor(mk(v))]).not.toBe(OUTCOME_CODE.release);
    }
  });
});
