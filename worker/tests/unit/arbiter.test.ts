import { describe, it, expect } from 'vitest';
import { arbitrate } from '../../src/lib/arbiter.js';
import type { Dispute } from '../../src/lib/arbiter.js';
import { planSettlement, outcomeForAction } from '../../src/settlement/tiers.js';
import type { EvidenceBundle, EvidenceItem, VerdictResult, VerdictLabel } from '../../src/types.js';
import { VERDICT_CODE } from '../../src/types.js';

const WORK = '0x'.padEnd(66, '1') as `0x${string}`;

function ev(statuses: EvidenceItem['status'][]): EvidenceBundle {
  return {
    route: 'code',
    items: statuses.map((status, i) => ({
      id: `test:item_${i}`, kind: 'test', label: `check ${i}`, status, detail: '',
    })),
  };
}

function verdict(label: VerdictLabel, score: number): VerdictResult {
  return {
    verdict: label,
    confidence: score / 100,
    score,
    citedEvidence: ['test:item_0'],
    rationale: 'engine verdict',
    route: 'code',
    evidenceHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
    verdictCode: VERDICT_CODE[label],
  };
}

const asPayer: Dispute = { by: 'payer', reason: 'the code does not actually pass' };
const asWorker: Dispute = { by: 'worker', reason: 'my delivery met the spec' };

describe('arbiter — always an honest mock', () => {
  it('tags every ruling arbiter=mock and rationale as [MOCK ARBITER]', () => {
    const r = arbitrate({ workId: WORK, proposed: verdict('pass', 100), evidence: ev(['pass']), dispute: asPayer });
    expect(r.arbiter).toBe('mock');
    expect(r.rationale).toMatch(/\[MOCK ARBITER\]/);
  });

  it('anchors a ruling evidenceHash distinct from the disputed verdict', () => {
    const proposed = verdict('pass', 100);
    const r = arbitrate({ workId: WORK, proposed, evidence: ev(['pass']), dispute: asPayer });
    expect(r.verdict.evidenceHash).not.toBe(proposed.evidenceHash);
    expect(r.verdict.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic: same inputs → identical ruling + hash', () => {
    const a = arbitrate({ workId: WORK, proposed: verdict('partial', 60), evidence: ev(['pass', 'fail']), dispute: asPayer });
    const b = arbitrate({ workId: WORK, proposed: verdict('partial', 60), evidence: ev(['pass', 'fail']), dispute: asPayer });
    expect(a).toEqual(b);
  });
});

describe('arbiter — overturns only when evidence supports the disputer', () => {
  it('buyer disputes a RELEASE, all checks failed → overturns to REFUND', () => {
    const r = arbitrate({ workId: WORK, proposed: verdict('pass', 100), evidence: ev(['fail', 'fail']), dispute: asPayer });
    expect(r.outcome).toBe('refund');
    expect(r.upheld).toBe(false);
    expect(r.proposedOutcome).toBe('release');
  });

  it('buyer disputes a RELEASE, mixed evidence → overturns to a proportional PARTIAL', () => {
    // 1 pass / 1 fail → 50% → bps 5000
    const r = arbitrate({ workId: WORK, proposed: verdict('pass', 100), evidence: ev(['pass', 'fail']), dispute: asPayer });
    expect(r.outcome).toBe('partial');
    expect(r.bps).toBe(5000);
    expect(r.upheld).toBe(false);
  });

  it('worker disputes a REFUND, all checks passed → overturns to RELEASE', () => {
    const r = arbitrate({ workId: WORK, proposed: verdict('fail', 0), evidence: ev(['pass', 'pass']), dispute: asWorker });
    expect(r.outcome).toBe('release');
    expect(r.upheld).toBe(false);
    expect(r.proposedOutcome).toBe('refund');
  });

  it('worker disputes an ABSTAIN with clean evidence → overturns to RELEASE', () => {
    const r = arbitrate({ workId: WORK, proposed: verdict('abstain', 0), evidence: ev(['pass']), dispute: asWorker });
    expect(r.outcome).toBe('release');
    expect(r.upheld).toBe(false);
  });
});

describe('arbiter — upholds when the evidence does not back the claim', () => {
  it('buyer disputes a RELEASE but every check passed → UPHOLDS release', () => {
    const r = arbitrate({ workId: WORK, proposed: verdict('pass', 100), evidence: ev(['pass', 'pass']), dispute: asPayer });
    expect(r.outcome).toBe('release');
    expect(r.upheld).toBe(true);
  });

  it('worker disputes a REFUND but a check failed → UPHOLDS refund', () => {
    const r = arbitrate({ workId: WORK, proposed: verdict('fail', 0), evidence: ev(['pass', 'fail']), dispute: asWorker });
    expect(r.outcome).toBe('refund');
    expect(r.upheld).toBe(true);
  });

  it('buyer disputes a REFUND (wrong direction — buyer already refunded) → UPHOLDS', () => {
    const r = arbitrate({ workId: WORK, proposed: verdict('fail', 0), evidence: ev(['fail']), dispute: asPayer });
    expect(r.outcome).toBe('refund');
    expect(r.upheld).toBe(true);
  });
});

describe('arbiter — ruling settles through the proven settleVerdict path', () => {
  it('a REFUND ruling maps to settle(fail)', () => {
    const r = arbitrate({ workId: WORK, proposed: verdict('pass', 100), evidence: ev(['fail']), dispute: asPayer });
    const action = planSettlement(r.verdict);
    expect(action).toEqual({ kind: 'settle', code: 1 });
    expect(outcomeForAction(action)).toBe('refund');
  });

  it('a PARTIAL ruling maps to settlePartial with the arbiter bps', () => {
    const r = arbitrate({ workId: WORK, proposed: verdict('pass', 100), evidence: ev(['pass', 'fail']), dispute: asPayer });
    const action = planSettlement(r.verdict);
    expect(action).toEqual({ kind: 'settlePartial', bps: 5000 });
  });

  it('a RELEASE ruling maps to settle(pass)', () => {
    const r = arbitrate({ workId: WORK, proposed: verdict('fail', 0), evidence: ev(['pass']), dispute: asWorker });
    expect(planSettlement(r.verdict)).toEqual({ kind: 'settle', code: 0 });
  });
});
