import { describe, it, expect } from 'vitest';
import { buildAttestation, responseScore, deriveRequestHash } from '../../src/lib/erc8004-evidence.js';
import type { VerdictResult, Settlement, Task } from '../../src/types.js';

const WORK_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const SETTLE_TX = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
const VALIDATOR = '0xD089Dfc911ea0A5cA7A54ff912ab73B5531D02D7' as `0x${string}`;

const task = (): Task => ({
  workId: WORK_ID, type: 'answer', acceptance: { spec: 'SECRET-BUYER-INPUT-should-not-leak' } as any,
  payer: '0x1111111111111111111111111111111111111111', worker: '0x2222222222222222222222222222222222222222',
  amountUsdc: 1,
});

const verdict = (over: Partial<VerdictResult> = {}): VerdictResult => ({
  verdict: 'pass', confidence: 0.9, score: 90, citedEvidence: ['test:ok'], rationale: 'all checks passed',
  route: 'answer', evidenceHash: ('0x' + 'ee'.repeat(32)) as `0x${string}`, verdictCode: 0, ...over,
});

const settlement = (over: Partial<Settlement> = {}): Settlement => ({
  workId: WORK_ID, outcome: 'release', verdictCode: 0, evidenceHash: ('0x' + 'ee'.repeat(32)) as `0x${string}`,
  txHash: SETTLE_TX, circleTxId: 'circle-1', ...over,
});

describe('responseScore — outcome-driven work quality, never raw confidence', () => {
  it('release → confidence-scaled', () => {
    expect(responseScore(verdict({ confidence: 0.9 }), settlement({ outcome: 'release' }))).toBe(90);
  });
  it('refund → 0 even at high verdict confidence (confident FAIL = bad work)', () => {
    expect(responseScore(verdict({ verdict: 'fail', confidence: 0.99, verdictCode: 1 }), settlement({ outcome: 'refund' }))).toBe(0);
  });
  it('partial → released proportion (bps%)', () => {
    expect(responseScore(verdict(), settlement({ outcome: 'partial', bps: 6000 }))).toBe(60);
  });
  it('abstain → 0', () => {
    expect(responseScore(verdict({ verdict: 'abstain' }), settlement({ outcome: 'abstain' }))).toBe(0);
  });
  it('never exceeds 100', () => {
    expect(responseScore(verdict({ confidence: 1.5 }), settlement({ outcome: 'release' }))).toBe(100);
  });
});

describe('buildAttestation', () => {
  it('is deterministic — same inputs yield the same requestHash and responseHash', () => {
    const a = buildAttestation({ verdict: verdict(), settlement: settlement(), task: task(), validator: VALIDATOR, baseUrl: 'https://verdikt-worker.fly.dev' });
    const b = buildAttestation({ verdict: verdict(), settlement: settlement(), task: task(), validator: VALIDATOR, baseUrl: 'https://verdikt-worker.fly.dev' });
    expect(a.requestHash).toBe(b.requestHash);
    expect(a.responseHash).toBe(b.responseHash);
    expect(a.responseHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('requestHash binds workId + settle tx (a different settlement tx → a different key)', () => {
    const a = buildAttestation({ verdict: verdict(), settlement: settlement(), task: task(), validator: VALIDATOR, baseUrl: 'https://x' });
    const b = buildAttestation({ verdict: verdict(), settlement: settlement({ txHash: ('0x' + '99'.repeat(32)) as any }), task: task(), validator: VALIDATOR, baseUrl: 'https://x' });
    expect(a.requestHash).not.toBe(b.requestHash);
    expect(a.requestHash).toBe(deriveRequestHash(WORK_ID, SETTLE_TX));
  });

  it('tag + responseURI are derived from outcome + requestHash', () => {
    const a = buildAttestation({ verdict: verdict(), settlement: settlement(), task: task(), validator: VALIDATOR, baseUrl: 'https://verdikt-worker.fly.dev/' });
    expect(a.tag).toBe('verdikt:release');
    expect(a.responseURI).toBe(`https://verdikt-worker.fly.dev/evidence/${a.requestHash}.json`);
  });

  it('bundle carries the Arc settlement tx hash (Gate D1) and hashes to responseHash', async () => {
    const { keccak256, toBytes } = await import('viem');
    const a = buildAttestation({ verdict: verdict(), settlement: settlement(), task: task(), validator: VALIDATOR, baseUrl: 'https://x' });
    expect(a.bundle.settlement.txHash).toBe(SETTLE_TX);
    expect(a.bundle.settlement.explorerUrl).toContain(SETTLE_TX);
    expect(keccak256(toBytes(a.bundleJson))).toBe(a.responseHash); // responseHash verifiable from the served bundle
  });

  it('never leaks raw buyer input / acceptance spec (no-PII)', () => {
    const a = buildAttestation({ verdict: verdict(), settlement: settlement(), task: task(), validator: VALIDATOR, baseUrl: 'https://x' });
    expect(a.bundleJson).not.toContain('SECRET-BUYER-INPUT');
    expect(a.bundleJson).not.toContain('acceptance');
  });
});
