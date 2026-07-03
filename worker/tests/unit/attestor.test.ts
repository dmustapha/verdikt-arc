import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the on-chain surface so the attestor's control flow is tested without a live chain.
vi.mock('../../src/lib/erc8004-writer.js', () => ({
  openValidationRequest: vi.fn(async () => ({ txHash: '0x' + 'aa'.repeat(32), alreadyOpen: false })),
  postValidationResponse: vi.fn(async () => '0x' + 'bb'.repeat(32)),
}));
vi.mock('../../src/lib/erc8004.js', () => ({ readValidationStatus: vi.fn(async () => null) }));

import { attestSettlement, attestAfterSettle, enableAttestation } from '../../src/lib/attestor.js';
import { openValidationRequest, postValidationResponse } from '../../src/lib/erc8004-writer.js';
import { readValidationStatus } from '../../src/lib/erc8004.js';
import type { Task, VerdictResult, Settlement } from '../../src/types.js';

const WORK_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const CFG = { agentId: 7395n, attestorKey: ('0x' + '01'.repeat(32)) as `0x${string}`, validator: '0xD089Dfc911ea0A5cA7A54ff912ab73B5531D02D7' as `0x${string}`, baseUrl: 'https://verdikt-worker.fly.dev' };
const V: VerdictResult = { verdict: 'pass', confidence: 0.9, citedEvidence: ['t:ok'], rationale: 'ok', route: 'answer', evidenceHash: ('0x' + 'ee'.repeat(32)) as any, verdictCode: 0 };
const T: Task = { workId: WORK_ID, type: 'answer', acceptance: {} as any, payer: '0x1', worker: '0x2', amountUsdc: 1 } as any;
const S = (over: Partial<Settlement> = {}): Settlement => ({ workId: WORK_ID, outcome: 'release', verdictCode: 0, evidenceHash: ('0x' + 'ee'.repeat(32)) as any, txHash: '0x' + 'cd'.repeat(32), circleTxId: '', ...over });

beforeEach(() => vi.clearAllMocks());

describe('attestSettlement', () => {
  it('skips (no-op) when unconfigured — protects every unrelated test/env', async () => {
    const r = await attestSettlement(T, V, S(), null);
    expect(r.status).toBe('skipped');
    expect(openValidationRequest).not.toHaveBeenCalled();
  });

  it('skips abstain — nothing was validated, so nothing is attested', async () => {
    const r = await attestSettlement(T, { ...V, verdict: 'abstain' }, S({ outcome: 'abstain' }), CFG);
    expect(r).toMatchObject({ status: 'skipped' });
    expect(postValidationResponse).not.toHaveBeenCalled();
  });

  it('attests a release: opens the request then posts the response', async () => {
    const r = await attestSettlement(T, V, S(), CFG);
    expect(r.status).toBe('attested');
    if (r.status !== 'attested') throw new Error('unreachable');
    expect(openValidationRequest).toHaveBeenCalledOnce();
    expect(postValidationResponse).toHaveBeenCalledOnce();
    // response posted is the 0..100 work-quality score for a 0.9-confidence release.
    expect((postValidationResponse as any).mock.calls[0][0].response).toBe(90);
    expect(r.responseTxHash).toMatch(/^0x/);
  });

  it('is idempotent — already-attested on-chain is skipped (no double write)', async () => {
    (readValidationStatus as any).mockResolvedValueOnce({ validatorAddress: CFG.validator, agentId: 7395n, response: 90, responseHash: '0x', tag: 'verdikt:release', lastUpdate: 123n });
    const r = await attestSettlement(T, V, S(), CFG);
    expect(r.status).toBe('skipped');
    expect(openValidationRequest).not.toHaveBeenCalled();
  });

  it('an OPEN-but-unanswered request is NOT skipped — it proceeds to post the response', async () => {
    // tag='' + zero responseHash + lastUpdate>0 = a request opened whose response failed earlier.
    (readValidationStatus as any).mockResolvedValueOnce({ validatorAddress: CFG.validator, agentId: 7395n, response: 0, responseHash: '0x' + '00'.repeat(32), tag: '', lastUpdate: 999n });
    const r = await attestSettlement(T, V, S(), CFG);
    expect(r.status).toBe('attested');
    expect(postValidationResponse).toHaveBeenCalledOnce();
  });

  it('NEVER throws — an on-chain failure surfaces as {status:error}, not an exception', async () => {
    (openValidationRequest as any).mockRejectedValueOnce(new Error('rpc exploded'));
    const r = await attestSettlement(T, V, S(), CFG);
    expect(r.status).toBe('error');
    if (r.status !== 'error') throw new Error('unreachable');
    expect(r.reason).toContain('rpc exploded');
  });

  it('re-checks after opening the request and skips if a response already exists (no double-post)', async () => {
    // Fast read: no response yet (stale). After opening, the reliable recheck sees a response.
    (readValidationStatus as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ validatorAddress: CFG.validator, agentId: 7395n, response: 90, responseHash: '0x' + 'aa'.repeat(32), tag: 'verdikt:release', lastUpdate: 5n });
    const r = await attestSettlement(T, V, S(), CFG);
    expect(r.status).toBe('skipped');
    expect(postValidationResponse).not.toHaveBeenCalled(); // never double-posted
  });
});

describe('attestAfterSettle (fire-and-forget wrapper)', () => {
  it('is a no-op until enabled — imports/tests never fire live writes', async () => {
    // enableAttestation() has not been called in this test → nothing runs.
    await attestAfterSettle(T, V, S());
    expect(openValidationRequest).not.toHaveBeenCalled();
    expect(postValidationResponse).not.toHaveBeenCalled();
  });

  it('never rejects even when the writer throws — safe to leave unawaited', async () => {
    enableAttestation();
    (openValidationRequest as any).mockRejectedValueOnce(new Error('boom'));
    await expect(attestAfterSettle(T, V, S())).resolves.toBeUndefined();
  });
});
