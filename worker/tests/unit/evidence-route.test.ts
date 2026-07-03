import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetEvidence } from '../../src/routes/evidence.js';
import { putEvidence, getEvidence, _clearEvidence } from '../../src/lib/evidence-store.js';
import { buildAttestation } from '../../src/lib/erc8004-evidence.js';
import type { VerdictResult, Settlement, Task } from '../../src/types.js';
import { keccak256, toBytes } from 'viem';

const WORK_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const SETTLE_TX = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
const V: VerdictResult = { verdict: 'pass', confidence: 0.9, score: 90, citedEvidence: ['t:ok'], rationale: 'ok', route: 'answer', evidenceHash: ('0x' + 'ee'.repeat(32)) as any, verdictCode: 0 };
const S: Settlement = { workId: WORK_ID, outcome: 'release', verdictCode: 0, evidenceHash: ('0x' + 'ee'.repeat(32)) as any, txHash: SETTLE_TX, circleTxId: 'c1' };
const T: Task = { workId: WORK_ID, type: 'answer', acceptance: {} as any, payer: '0x1111111111111111111111111111111111111111', worker: '0x2222222222222222222222222222222222222222', amountUsdc: 1 };

beforeEach(() => _clearEvidence());

describe('handleGetEvidence', () => {
  it('serves a stored bundle whose bytes hash to the on-chain responseHash', () => {
    const att = buildAttestation({ verdict: V, settlement: S, task: T, validator: '0xD089Dfc911ea0A5cA7A54ff912ab73B5531D02D7', baseUrl: 'https://x' });
    putEvidence(att);
    const r = handleGetEvidence({ get: getEvidence }, att.requestHash);
    expect(r.status).toBe(200);
    if (r.status !== 200) throw new Error('unreachable');
    expect(keccak256(toBytes(r.json))).toBe(att.responseHash);
    expect(r.json).toContain(SETTLE_TX); // Gate D1: the Arc settlement tx is in the served evidence
  });

  it('accepts the ".json" suffix form the responseURI uses', () => {
    const att = buildAttestation({ verdict: V, settlement: S, task: T, validator: '0xD089Dfc911ea0A5cA7A54ff912ab73B5531D02D7', baseUrl: 'https://x' });
    putEvidence(att);
    const r = handleGetEvidence({ get: getEvidence }, `${att.requestHash}.json`);
    expect(r.status).toBe(200);
  });

  it('404 for an unknown requestHash', () => {
    const r = handleGetEvidence({ get: getEvidence }, '0x' + '00'.repeat(32));
    expect(r.status).toBe(404);
  });

  it('400 for a malformed id', () => {
    expect(handleGetEvidence({ get: getEvidence }, 'not-a-hash').status).toBe(400);
    expect(handleGetEvidence({ get: getEvidence }, '0x1234').status).toBe(400);
  });
});
