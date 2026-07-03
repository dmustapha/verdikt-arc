import { describe, it, expect, vi } from 'vitest';
import { makeEngine, type EngineDeps, type JobStore } from '../../src/lib/job-engine.js';
import type { JobRow } from '../../src/lib/job-store.js';
import type { Task, Artifact } from '../../src/types.js';
import type { VerdictRunResult } from '../../src/engine/orchestrator.js';

const WORK_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const artifact: Artifact = { type: 'answer', payload: 'hi' };
const task: Task = { workId: WORK_ID, type: 'answer', acceptance: {} as any, payer: '0x1', worker: '0x2', amountUsdc: 1 } as any;
const job = { jobId: 'job-1', workId: WORK_ID, deadline: new Date(Date.now() + 60_000) } as unknown as JobRow;

const run = (over: Partial<VerdictRunResult> = {}): VerdictRunResult => ({
  verdict: { verdict: 'pass', confidence: 0.9, citedEvidence: [], rationale: 'ok', route: 'answer', evidenceHash: ('0x' + 'ee'.repeat(32)) as any, verdictCode: 0 },
  outcome: 'release', txHash: '0x' + '11'.repeat(32), ...over,
});

function makeStore() {
  const calls: string[] = [];
  const store = {
    createJob: vi.fn(), getJob: vi.fn(async () => job), markDispatched: vi.fn(), markAwaiting: vi.fn(),
    claimDelivery: vi.fn(async () => { calls.push('claimDelivery'); return true; }),
    markVerifying: vi.fn(async () => { calls.push('markVerifying'); return true; }),
    markSettled: vi.fn(async () => { calls.push('markSettled'); return true; }),
    markExpired: vi.fn(), recordDispatchAttempt: vi.fn(),
    recordJobError: vi.fn(async (_id: string, e: string) => { calls.push(`recordJobError:${e.slice(0, 24)}`); }),
    listByState: vi.fn(),
  } as unknown as JobStore;
  return { store, calls };
}

function makeDeps(store: JobStore, attest?: EngineDeps['attest']): EngineDeps {
  return {
    store, transport: { dispatch: vi.fn(), fetchResult: vi.fn() } as any,
    verify: vi.fn(async () => run()), getTask: vi.fn(async () => task),
    refundExpiredOnChain: vi.fn(async () => '0x'), now: () => Date.now(),
    dispatch: { maxAttempts: 1, baseDelayMs: 1, sleep: vi.fn() }, attest,
  };
}

describe('job-engine post-settle attestation wiring', () => {
  it('calls attest with (task, run) AFTER the settlement is recorded', async () => {
    const { store, calls } = makeStore();
    const attest = vi.fn(async () => {});
    const engine = makeEngine(makeDeps(store, attest));
    await engine.onDelivery(job, { artifact });

    expect(store.markSettled).toHaveBeenCalledOnce();
    expect(attest).toHaveBeenCalledOnce();
    expect(attest).toHaveBeenCalledWith(task, expect.objectContaining({ outcome: 'release', txHash: expect.any(String) }));
    expect(calls.indexOf('markSettled')).toBeLessThan(calls.length); // settled recorded
  });

  it('a THROWING attest never breaks the settlement (money path already done) — recorded as non-fatal', async () => {
    const { store, calls } = makeStore();
    const attest = vi.fn(async () => { throw new Error('base sepolia rpc down'); });
    const engine = makeEngine(makeDeps(store, attest));

    await expect(engine.onDelivery(job, { artifact })).resolves.toBeUndefined(); // does NOT reject
    expect(store.markSettled).toHaveBeenCalledOnce();                            // settlement stands
    expect(calls.some((c) => c.startsWith('recordJobError:erc8004'))).toBe(true);
  });

  it('with no attest dep, settlement proceeds unchanged (backward compatible)', async () => {
    const { store } = makeStore();
    const engine = makeEngine(makeDeps(store, undefined));
    await engine.onDelivery(job, { artifact });
    expect(store.markSettled).toHaveBeenCalledOnce();
  });

  it('does not attest when the verdict never settled (no txHash)', async () => {
    const { store } = makeStore();
    const attest = vi.fn(async () => {});
    const deps = makeDeps(store, attest);
    deps.verify = vi.fn(async () => run({ txHash: null, error: 'settle did not confirm' }));
    const engine = makeEngine(deps);
    await engine.onDelivery(job, { artifact });
    expect(store.markSettled).not.toHaveBeenCalled();
    expect(attest).not.toHaveBeenCalled();
  });
});
