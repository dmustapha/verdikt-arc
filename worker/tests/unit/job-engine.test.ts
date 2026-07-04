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
        disputable: i.disputable ?? false, challengeWindowMs: i.challengeWindowMs ?? null,
        challengeDeadline: null, disputedBy: null, disputeReason: null,
        arbiterOutcome: null, arbiterUpheld: null, arbiterRationale: null,
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
    // WS11 dispute transitions — same single-shot state guards as the real store.
    async markProposed(id, dl) { const r = rows.get(id); if (r?.state !== 'VERIFYING') return false; set(id, { state: 'PROPOSED', challengeDeadline: dl }); return true; },
    async finalizeProposed(id, outcome, tx) { const r = rows.get(id); if (r?.state !== 'PROPOSED') return false; set(id, { state: outcome === 'abstain' ? 'ABSTAINED' : 'SETTLED', outcome, settleTxHash: tx }); return true; },
    async openDispute(id, by, reason) { const r = rows.get(id); if (r?.state !== 'PROPOSED') return false; set(id, { state: 'DISPUTED', disputedBy: by, disputeReason: reason }); return true; },
    async markEscalated(id) { const r = rows.get(id); if (r?.state !== 'DISPUTED') return false; set(id, { state: 'ESCALATED' }); return true; },
    async markResolved(id, outcome, upheld, rationale, tx) { const r = rows.get(id); if (r?.state !== 'ESCALATED') return false; set(id, { state: 'RESOLVED', outcome, arbiterOutcome: outcome, arbiterUpheld: upheld, arbiterRationale: rationale, settleTxHash: tx }); return true; },
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
    // WS11 dispute deps (only exercised by the dispute-path tests; undefined here for the happy path).
    propose: over.propose, settleGiven: over.settleGiven, getProposedVerdict: over.getProposedVerdict,
    getEvidence: over.getEvidence, arbitrate: over.arbitrate, challengeWindowMs: over.challengeWindowMs,
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

describe('job-engine — WS11 dispute/escalation path', () => {
  const bundle = { route: 'code' as const, items: [{ id: 'test:t0', kind: 'test' as const, label: 't', status: 'pass' as const, detail: '' }] };
  const arbiterVerdict = { ...verdict, verdict: 'fail' as const, verdictCode: 1, rationale: '[MOCK ARBITER] overturned', evidenceHash: `0x${'b'.repeat(64)}` } as VerdictResult;

  // A fully-wired disputable engine. propose holds the verdict; arbitrate returns a controllable ruling;
  // settleGiven stands in for the on-chain settle (the arbiter unit test proves the real ruling logic).
  function disputableCtx(over: Parameters<typeof mkEngine>[0] = {}) {
    // Overrides win, and the RETURNED deps are the exact spies the engine uses (so assertions on
    // ctx.settleGiven etc. observe the real calls).
    const propose = over.propose ?? vi.fn().mockResolvedValue({ verdict, bundle });
    const settleGiven = over.settleGiven ?? vi.fn().mockResolvedValue(verdictResult('refund', '0xarb'));
    const getProposedVerdict = over.getProposedVerdict ?? vi.fn().mockResolvedValue(verdict);
    const getEvidence = over.getEvidence ?? vi.fn().mockResolvedValue(bundle);
    const arbitrate = over.arbitrate ?? vi.fn().mockReturnValue({
      arbiter: 'mock', outcome: 'refund', upheld: false, proposedOutcome: 'release',
      rationale: '[MOCK ARBITER] buyer dispute upheld', verdict: arbiterVerdict,
    });
    const base = mkEngine({ ...over, propose, settleGiven, getProposedVerdict, getEvidence, arbitrate, challengeWindowMs: over.challengeWindowMs ?? 60_000 });
    return { ...base, propose, settleGiven, getProposedVerdict, getEvidence, arbitrate };
  }

  const disputable = { ...createInput, disputable: true };

  async function proposedJob(over: Parameters<typeof mkEngine>[0] = {}) {
    const ctx = disputableCtx(over);
    await ctx.engine.startJob(disputable);
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    return ctx;
  }

  it('HOLDS a disputable job in PROPOSED (computes the verdict, does NOT settle)', async () => {
    const ctx = await proposedJob();
    const row = ctx.store.rows.get('j1')!;
    expect(ctx.propose).toHaveBeenCalledWith(task, artifact);
    expect(ctx.verify).not.toHaveBeenCalled();       // the settling verify path is bypassed
    expect(row.state).toBe('PROPOSED');
    expect(row.settleTxHash).toBeNull();              // no money moved
    expect(row.challengeDeadline).toBeInstanceOf(Date);
    expect(emittedStates(ctx.emit)).toContain('PROPOSED');
  });

  it('clamps the challenge window so it never outlasts the escrow deadline', async () => {
    const t = 1_000_000_000;
    // Escrow deadline only 30s out, but a 60s challenge window requested → must clamp to deadline−margin.
    const ctx = disputableCtx({ now: () => t, challengeWindowMs: 60_000 });
    await ctx.engine.startJob({ ...disputable, deadline: new Date(t + 30_000) });
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    const cd = ctx.store.rows.get('j1')!.challengeDeadline!.getTime();
    expect(cd).toBe(t + 30_000 - 60_000);         // clamped to escrow deadline − 60s margin
    expect(cd).toBeLessThan(t + 60_000);          // did NOT use the full requested 60s window
  });

  it('an UNWIRED engine never strands a disputable job — it falls through to a normal settle', async () => {
    // No dispute deps provided: the disputable flag cannot be honored, so the job must still settle.
    const ctx = mkEngine();
    await ctx.engine.startJob(disputable);
    await ctx.engine.onDelivery(ctx.store.rows.get('j1')!, { artifact });
    expect(ctx.store.rows.get('j1')!.state).toBe('SETTLED');
  });

  it('a dispute in-window → DISPUTED → ESCALATED → RESOLVED with the arbiter outcome', async () => {
    const ctx = await proposedJob();
    ctx.emit.mockClear();
    const r = await ctx.engine.disputeJob('j1', 'payer', 'the code does not really pass');
    expect(r.resolved).toBe(true);
    expect(r.outcome).toBe('refund');
    expect(r.upheld).toBe(false);
    expect(ctx.arbitrate).toHaveBeenCalledOnce();
    expect(ctx.settleGiven).toHaveBeenCalledWith(task, arbiterVerdict); // the ARBITER verdict is settled
    const row = ctx.store.rows.get('j1')!;
    expect(row.state).toBe('RESOLVED');
    expect(row.outcome).toBe('refund');
    expect(row.arbiterUpheld).toBe(false);
    expect(row.disputedBy).toBe('payer');
    expect(emittedStates(ctx.emit)).toEqual(['DISPUTED', 'ESCALATED', 'RESOLVED']);
  });

  it('refuses to dispute a job that is not PROPOSED', async () => {
    const ctx = disputableCtx();
    await ctx.engine.startJob(disputable); // still FUNDED/AWAITING, never delivered
    const r = await ctx.engine.disputeJob('j1', 'worker', 'unfair');
    expect(r.resolved).toBe(false);
    expect(r.reason).toMatch(/not open to dispute/i);
    expect(ctx.arbitrate).not.toHaveBeenCalled();
  });

  it('refuses a dispute after the challenge window has closed', async () => {
    let t = 1_000_000;
    const ctx = await proposedJob({ now: () => t, challengeWindowMs: 1000 });
    t += 5000; // advance past the window
    const r = await ctx.engine.disputeJob('j1', 'payer', 'too late');
    expect(r.resolved).toBe(false);
    expect(r.reason).toMatch(/window has closed/i);
    expect(ctx.store.rows.get('j1')!.state).toBe('PROPOSED'); // untouched
  });

  it('a second dispute loses the single-shot race (idempotent)', async () => {
    const ctx = await proposedJob();
    await ctx.engine.disputeJob('j1', 'payer', 'first'); // resolves → RESOLVED
    const r2 = await ctx.engine.disputeJob('j1', 'worker', 'second');
    expect(r2.resolved).toBe(false); // job is already RESOLVED, not PROPOSED
    expect(ctx.arbitrate).toHaveBeenCalledOnce();
  });

  it('leaves the job ESCALATED (non-terminal) when the arbiter settlement does not confirm', async () => {
    const settleGiven = vi.fn().mockResolvedValue(verdictResult('refund', null)); // no txHash
    const ctx = await proposedJob({ settleGiven });
    const r = await ctx.engine.disputeJob('j1', 'payer', 'contested');
    expect(r.resolved).toBe(false);
    const row = ctx.store.rows.get('j1')!;
    expect(isTerminal(row.state)).toBe(false);   // ESCALATED — the no-show refund is the backstop
    expect(row.state).toBe('ESCALATED');
    expect(row.lastError).toMatch(/confirm/i);
  });

  it('finalizeProposedJob refuses while the window is open', async () => {
    let t = 1_000_000;
    const ctx = await proposedJob({ now: () => t, challengeWindowMs: 60_000 });
    const r = await ctx.engine.finalizeProposedJob('j1');
    expect(r.finalized).toBe(false);
    expect(r.reason).toMatch(/still open/i);
    expect(ctx.settleGiven).not.toHaveBeenCalled();
  });

  it('finalizeProposedJob settles the held verdict once the window closes (undisputed → SETTLED)', async () => {
    let t = 1_000_000;
    const settleGiven = vi.fn().mockResolvedValue(verdictResult('release', '0xfin'));
    const ctx = await proposedJob({ now: () => t, challengeWindowMs: 1000, settleGiven });
    t += 5000; // window closed
    ctx.emit.mockClear();
    const r = await ctx.engine.finalizeProposedJob('j1');
    expect(r.finalized).toBe(true);
    expect(ctx.settleGiven).toHaveBeenCalledWith(task, verdict); // the HELD (proposed) verdict, not the arbiter's
    const row = ctx.store.rows.get('j1')!;
    expect(row.state).toBe('SETTLED');
    expect(row.outcome).toBe('release');
    expect(emittedStates(ctx.emit)).toEqual(['SETTLED']);
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
