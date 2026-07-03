import { describe, it, expect, vi } from 'vitest';
import { makeEngine } from '../../src/lib/job-engine.js';
import type { JobStore } from '../../src/lib/job-engine.js';
import type { JobRow } from '../../src/lib/job-store.js';
import type { SellerTransport } from '../../src/lib/transport.js';
import type { Task, Artifact, VerdictResult } from '../../src/types.js';
import type { VerdictRunResult } from '../../src/engine/orchestrator.js';
import { isTerminal } from '../../src/lib/job-machine.js';

// In-memory JobStore — single-threaded JS makes the conditional updates atomic by construction, so it
// faithfully models the DB's single-shot semantics for engine logic tests.
function memStore(): JobStore & { rows: Map<string, JobRow> } {
  const rows = new Map<string, JobRow>();
  const set = (id: string, patch: Partial<JobRow>) => { const r = rows.get(id)!; rows.set(id, { ...r, ...patch }); };
  return {
    rows,
    async createJob(i) {
      rows.set(i.jobId, {
        jobId: i.jobId, workId: i.workId, state: 'FUNDED', sellerUrl: i.sellerUrl, sellerProtocol: i.sellerProtocol,
        callbackToken: i.callbackToken, resultRef: i.resultRef, deadline: i.deadline, dispatchAttempts: 0,
        artifact: null, outcome: null, settleTxHash: null, lastError: null,
      });
    },
    async getJob(id) { return rows.get(id) ?? null; },
    async markDispatched(id) { const r = rows.get(id); if (r?.state !== 'FUNDED') return false; set(id, { state: 'DISPATCHED' }); return true; },
    async markAwaiting(id) { const r = rows.get(id); if (r?.state !== 'DISPATCHED') return false; set(id, { state: 'AWAITING_DELIVERY' }); return true; },
    async claimDelivery(id, art) { const s = rows.get(id)?.state; if (s !== 'FUNDED' && s !== 'DISPATCHED' && s !== 'AWAITING_DELIVERY') return false; set(id, { state: 'DELIVERED', artifact: art }); return true; },
    async markVerifying(id) { const r = rows.get(id); if (r?.state !== 'DELIVERED') return false; set(id, { state: 'VERIFYING' }); return true; },
    async markSettled(id, outcome, tx) { const r = rows.get(id); if (r?.state !== 'VERIFYING') return false; set(id, { state: outcome === 'abstain' ? 'ABSTAINED' : 'SETTLED', outcome, settleTxHash: tx }); return true; },
    async markExpired(id, tx) { const r = rows.get(id); if (!r || isTerminal(r.state)) return false; set(id, { state: 'EXPIRED', outcome: 'refund', settleTxHash: tx }); return true; },
    async recordDispatchAttempt(id, err) { const r = rows.get(id); if (r) set(id, { dispatchAttempts: r.dispatchAttempts + 1, lastError: err ?? r.lastError }); },
    async recordJobError(id, err) { set(id, { lastError: err }); },
    async listByState(states) { return [...rows.values()].filter((r) => states.includes(r.state)); },
  };
}

const task: Task = { workId: `0x${'ab'.repeat(32)}`, type: 'code', acceptance: { spec: 's', tests: 't' }, payer: `0x${'11'.repeat(20)}`, worker: `0x${'22'.repeat(20)}`, amountUsdc: 0.1 };
const artifact: Artifact = { type: 'code', language: 'python', payload: 'print(1)' };
const verdict = { verdict: 'pass', confidence: 1, citedEvidence: [], rationale: '', route: 'code', evidenceHash: `0x${'0'.repeat(64)}`, verdictCode: 0 } as VerdictResult;

function verdictResult(outcome: string, txHash: string | null): VerdictRunResult {
  return { verdict, outcome, txHash, error: txHash ? undefined : 'settlement did not confirm' };
}

const createInput = {
  jobId: 'j1', workId: task.workId, sellerUrl: 'https://seller.example.com/dispatch',
  sellerProtocol: 'webhook' as const, callbackToken: 'tok', resultRef: null,
  deadline: new Date(Date.now() + 3600_000),
};

function mkEngine(over: Partial<Parameters<typeof makeEngine>[0]> = {}) {
  const store = memStore();
  const transport: SellerTransport = over.transport ?? { dispatch: vi.fn().mockResolvedValue(undefined), fetchResult: vi.fn().mockResolvedValue(null) };
  const verify = (over.verify ?? vi.fn().mockResolvedValue(verdictResult('release', '0xtx'))) as ReturnType<typeof vi.fn>;
  const refundExpiredOnChain = (over.refundExpiredOnChain ?? vi.fn().mockResolvedValue('0xrefund')) as ReturnType<typeof vi.fn>;
  const getTask = (over.getTask ?? vi.fn().mockResolvedValue(task)) as ReturnType<typeof vi.fn>;
  const now = over.now ?? (() => Date.now());
  const emit = (over.emit ?? vi.fn()) as ReturnType<typeof vi.fn>;
  const engine = makeEngine({
    store, transport, verify, refundExpiredOnChain, getTask, now, emit,
    dispatch: { maxAttempts: 3, baseDelayMs: 1, sleep: vi.fn().mockResolvedValue(undefined) },
  });
  return { engine, store, transport, verify, refundExpiredOnChain, getTask, emit };
}

// The states each transition emits, in order (WS8 dashboard SSE). Helper to read a spy's calls.
const emittedStates = (emit: ReturnType<typeof vi.fn>) => emit.mock.calls.map((c) => c[1]);

describe('job-engine — startJob', () => {
  it('dispatches and lands in AWAITING_DELIVERY on success', async () => {
    const { engine, store, transport } = mkEngine();
    const job = await engine.startJob(createInput);
    expect(transport.dispatch).toHaveBeenCalledTimes(1);
    expect(job!.state).toBe('AWAITING_DELIVERY');
    expect(store.rows.get('j1')!.state).toBe('AWAITING_DELIVERY');
  });

  it('stays FUNDED with an error when the seller is unreachable (retry then fail)', async () => {
    const transport: SellerTransport = { dispatch: vi.fn().mockRejectedValue(new Error('unreachable')), fetchResult: vi.fn() };
    const { engine, store } = mkEngine({ transport });
    const job = await engine.startJob(createInput);
    expect(transport.dispatch).toHaveBeenCalledTimes(3); // exhausted
    expect(job!.state).toBe('FUNDED'); // funds locked; keeper refunds at deadline
    expect(store.rows.get('j1')!.lastError).toMatch(/unreachable|dispatch/i);
  });
});

describe('job-engine — onDelivery', () => {
  async function deliveredJob(over: Parameters<typeof mkEngine>[0] = {}) {
    const ctx = mkEngine(over);
    await ctx.engine.startJob(createInput);
    return ctx;
  }

  it('verifies an inline artifact and settles → SETTLED on release', async () => {
    const ctx = await deliveredJob();
    const job = ctx.store.rows.get('j1')!;
    await ctx.engine.onDelivery(job, { artifact });
    expect(ctx.verify).toHaveBeenCalledWith(task, artifact);
    expect(ctx.store.rows.get('j1')!.state).toBe('SETTLED');
    expect(ctx.store.rows.get('j1')!.outcome).toBe('release');
  });

  it('routes an abstain verdict to ABSTAINED', async () => {
    const ctx = await deliveredJob({ verify: vi.fn().mockResolvedValue(verdictResult('abstain', '0xtx')) });
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    expect(ctx.store.rows.get('j1')!.state).toBe('ABSTAINED');
  });

  it('routes a garbage → refund verdict to SETTLED(refund)', async () => {
    const ctx = await deliveredJob({ verify: vi.fn().mockResolvedValue(verdictResult('refund', '0xtx')) });
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    expect(ctx.store.rows.get('j1')!.state).toBe('SETTLED');
    expect(ctx.store.rows.get('j1')!.outcome).toBe('refund');
  });

  it('is idempotent — a duplicate delivery verifies only once', async () => {
    const ctx = await deliveredJob();
    const job = ctx.store.rows.get('j1')!;
    await ctx.engine.onDelivery(job, { artifact });
    await ctx.engine.onDelivery(job, { artifact }); // duplicate (stale job snapshot)
    expect(ctx.verify).toHaveBeenCalledTimes(1);
  });

  it('re-fetches the authoritative artifact for an a2a resultRef, never trusting a body', async () => {
    const fetchResult = vi.fn().mockResolvedValue(artifact);
    const transport: SellerTransport = { dispatch: vi.fn().mockResolvedValue(undefined), fetchResult };
    const ctx = await deliveredJob({ transport });
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { resultRef: 'https://seller.example.com/tasks/1' });
    expect(fetchResult).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'j1' }), 'https://seller.example.com/tasks/1');
    expect(ctx.verify).toHaveBeenCalledWith(task, artifact);
    expect(ctx.store.rows.get('j1')!.state).toBe('SETTLED');
  });

  it('leaves the job non-terminal when settlement does not confirm (keeper will expire)', async () => {
    const ctx = await deliveredJob({ verify: vi.fn().mockResolvedValue(verdictResult('release', null)) });
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    const row = ctx.store.rows.get('j1')!;
    expect(isTerminal(row.state)).toBe(false);
    expect(row.lastError).toMatch(/settle|confirm/i);
  });

  it('refuses a delivery that arrives after the deadline (defers to no-show expiry; transport-independent)', async () => {
    const ctx = mkEngine({ now: () => Date.now() });
    await ctx.engine.startJob({ ...createInput, deadline: new Date(Date.now() - 1000) }); // already past
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    expect(ctx.verify).not.toHaveBeenCalled();
    expect(ctx.store.rows.get('j1')!.state).toBe('AWAITING_DELIVERY'); // untouched; keeper will expire it
  });

  it('does not verify or settle when the artifact never materializes (fetchResult null)', async () => {
    const transport: SellerTransport = { dispatch: vi.fn().mockResolvedValue(undefined), fetchResult: vi.fn().mockResolvedValue(null) };
    const ctx = await deliveredJob({ transport });
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { resultRef: 'https://seller.example.com/tasks/1' });
    expect(ctx.verify).not.toHaveBeenCalled();
    expect(ctx.store.rows.get('j1')!.state).toBe('AWAITING_DELIVERY');
  });
});

describe('job-engine — job_state SSE emit (WS8 dashboard)', () => {
  it('emits FUNDED → DISPATCHED → AWAITING_DELIVERY on a successful dispatch, keyed by workId', async () => {
    const { engine, emit } = mkEngine();
    await engine.startJob(createInput);
    expect(emittedStates(emit)).toEqual(['FUNDED', 'DISPATCHED', 'AWAITING_DELIVERY']);
    expect(emit).toHaveBeenCalledWith(task.workId, 'FUNDED'); // every event carries the workId channel
  });

  it('emits the full lifecycle through the terminal state on delivery → release', async () => {
    const ctx = mkEngine();
    await ctx.engine.startJob(createInput);
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    expect(emittedStates(ctx.emit)).toEqual(['FUNDED', 'DISPATCHED', 'AWAITING_DELIVERY', 'DELIVERED', 'VERIFYING', 'SETTLED']);
  });

  it('emits ABSTAINED (not SETTLED) when the verdict abstains', async () => {
    const ctx = mkEngine({ verify: vi.fn().mockResolvedValue(verdictResult('abstain', '0xtx')) });
    await ctx.engine.startJob(createInput);
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    expect(emittedStates(ctx.emit).at(-1)).toBe('ABSTAINED');
  });

  it('emits EXPIRED when the keeper no-shows a past-deadline job', async () => {
    const ctx = mkEngine({ now: () => Date.now() });
    await ctx.engine.startJob({ ...createInput, deadline: new Date(Date.now() - 1000) });
    ctx.emit.mockClear();
    await ctx.engine.expireJob('j1');
    expect(emittedStates(ctx.emit)).toEqual(['EXPIRED']);
  });

  it('does NOT emit on a lost race — a duplicate delivery emits the lifecycle only once', async () => {
    const ctx = mkEngine();
    await ctx.engine.startJob(createInput);
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    const afterFirst = emittedStates(ctx.emit).length;
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact }); // duplicate loses claimDelivery
    expect(emittedStates(ctx.emit).length).toBe(afterFirst); // no extra DELIVERED/VERIFYING/SETTLED
  });

  it('a settlement that never confirms emits no terminal state (keeper still owns expiry)', async () => {
    const ctx = mkEngine({ verify: vi.fn().mockResolvedValue(verdictResult('release', null)) });
    await ctx.engine.startJob(createInput);
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    const states = emittedStates(ctx.emit);
    expect(states).toContain('VERIFYING');
    expect(states).not.toContain('SETTLED'); // no txHash → no markSettled → no emit
  });

  it('never throws when emit throws — a broken SSE bus cannot stall the lifecycle', async () => {
    const emit = vi.fn().mockImplementation(() => { throw new Error('sse down'); });
    const ctx = mkEngine({ emit });
    const job = await ctx.engine.startJob(createInput);
    expect(job!.state).toBe('AWAITING_DELIVERY'); // dispatch completed despite emit throwing
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    expect(ctx.store.rows.get('j1')!.state).toBe('SETTLED'); // settlement completed too
  });
});

describe('job-engine — expireJob (no-show keeper)', () => {
  it('refunds via refundExpired past the deadline → EXPIRED', async () => {
    const ctx = mkEngine({ now: () => Date.now() });
    await ctx.engine.startJob({ ...createInput, deadline: new Date(Date.now() - 1000) }); // already past
    const r = await ctx.engine.expireJob('j1');
    expect(ctx.refundExpiredOnChain).toHaveBeenCalledWith(task.workId);
    expect(r.expired).toBe(true);
    expect(ctx.store.rows.get('j1')!.state).toBe('EXPIRED');
  });

  it('refuses to expire before the deadline (no chain call)', async () => {
    const ctx = mkEngine();
    await ctx.engine.startJob(createInput); // deadline +1h
    const r = await ctx.engine.expireJob('j1');
    expect(r.expired).toBe(false);
    expect(ctx.refundExpiredOnChain).not.toHaveBeenCalled();
  });

  it('refuses to expire a terminal job (no double-settle), deadline-independently', async () => {
    // Settle within the deadline (onDelivery declines past-deadline deliveries), then prove expire
    // refuses — the isTerminal guard fires regardless of the deadline, so a SETTLED job is never
    // double-settled by the keeper even after its deadline lapses.
    const ctx = mkEngine();
    await ctx.engine.startJob(createInput); // future deadline
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact }); // → SETTLED
    expect(ctx.store.rows.get('j1')!.state).toBe('SETTLED');
    ctx.refundExpiredOnChain.mockClear();
    const r = await ctx.engine.expireJob('j1');
    expect(r.expired).toBe(false);
    expect(r.reason).toMatch(/already/i);
    expect(ctx.refundExpiredOnChain).not.toHaveBeenCalled();
  });
});
