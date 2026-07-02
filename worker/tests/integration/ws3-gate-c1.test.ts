import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from '@vercel/postgres';
import { insertTask, getTask } from '../../src/lib/db.js';
import * as jobStore from '../../src/lib/job-store.js';
import { makeEngine } from '../../src/lib/job-engine.js';
import type { JobStore } from '../../src/lib/job-engine.js';
import type { JobRow } from '../../src/lib/job-store.js';
import { pollOnce, expireOnce } from '../../src/lib/keeper.js';
import { handleCallback } from '../../src/routes/callback.js';
import type { CallbackDeps } from '../../src/routes/callback.js';
import type { SellerTransport } from '../../src/lib/transport.js';
import { isTerminal } from '../../src/lib/job-machine.js';
import type { Task, Artifact, VerdictResult } from '../../src/types.js';
import type { VerdictRunResult } from '../../src/engine/orchestrator.js';

// ── Gate C1: async job lifecycle × mock seller harness ────────────────────────────────────────────
// The behavior matrix + callback auth run against a FAST in-memory store — this is a real integration
// of the engine + dispatcher + keeper + callback handler + a configurable seller, just without the
// network latency of serverless Postgres. The DB's own atomic single-shot transitions + jti dedupe are
// proven against live Neon in job-store.test.ts; the "survives a worker restart" property (which only
// means anything against real persistence) gets its own live-Neon test at the bottom. The verdict
// engine's honesty (garbage→refund/abstain) is proven in WS2; here `verify` is an injected spy so the
// matrix stays deterministic and chain-free. Real runVerdict→real Arc settle is proven in WS3.6.

const goodArtifact: Artifact = { type: 'answer', payload: 'grounded answer' };
const verdict = { verdict: 'pass', confidence: 1, citedEvidence: [], rationale: '', route: 'answer', evidenceHash: `0x${'0'.repeat(64)}`, verdictCode: 0 } as VerdictResult;
const vr = (outcome: string, txHash: string | null = '0xsettle'): VerdictRunResult => ({ verdict, outcome, txHash, error: txHash ? undefined : 'settlement did not confirm' });
const SELLER = 'https://seller.example.com';
const task = (work: `0x${string}`): Task => ({ workId: work, type: 'answer', payer: `0x${'11'.repeat(20)}`, worker: `0x${'22'.repeat(20)}`, amountUsdc: 0.1, acceptance: { spec: 's', sources: 'x' } });

// Faithful in-memory JobStore — single-threaded JS makes each conditional update atomic, matching the
// DB's single-shot semantics.
function memStore(): JobStore {
  const rows = new Map<string, JobRow>();
  const patch = (id: string, p: Partial<JobRow>) => { const r = rows.get(id); if (r) rows.set(id, { ...r, ...p }); };
  return {
    async createJob(i) { rows.set(i.jobId, { jobId: i.jobId, workId: i.workId, state: 'FUNDED', sellerUrl: i.sellerUrl, sellerProtocol: i.sellerProtocol, callbackToken: i.callbackToken, resultRef: i.resultRef, deadline: i.deadline, dispatchAttempts: 0, artifact: null, outcome: null, settleTxHash: null, lastError: null }); },
    async getJob(id) { return rows.get(id) ?? null; },
    async markDispatched(id) { if (rows.get(id)?.state !== 'FUNDED') return false; patch(id, { state: 'DISPATCHED' }); return true; },
    async markAwaiting(id) { if (rows.get(id)?.state !== 'DISPATCHED') return false; patch(id, { state: 'AWAITING_DELIVERY' }); return true; },
    async claimDelivery(id, art) { const s = rows.get(id)?.state; if (s !== 'DISPATCHED' && s !== 'AWAITING_DELIVERY') return false; patch(id, { state: 'DELIVERED', artifact: art }); return true; },
    async markVerifying(id) { if (rows.get(id)?.state !== 'DELIVERED') return false; patch(id, { state: 'VERIFYING' }); return true; },
    async markSettled(id, outcome, tx) { if (rows.get(id)?.state !== 'VERIFYING') return false; patch(id, { state: outcome === 'abstain' ? 'ABSTAINED' : 'SETTLED', outcome, settleTxHash: tx }); return true; },
    async markExpired(id, tx) { const r = rows.get(id); if (!r || isTerminal(r.state)) return false; patch(id, { state: 'EXPIRED', outcome: 'refund', settleTxHash: tx }); return true; },
    async recordDispatchAttempt(id, err) { const r = rows.get(id); if (r) patch(id, { dispatchAttempts: r.dispatchAttempts + 1, lastError: err ?? r.lastError }); },
    async recordJobError(id, err) { patch(id, { lastError: err }); },
    async listByState(states) { return [...rows.values()].filter((r) => states.includes(r.state)); },
  };
}

// Configurable in-memory seller: each job registers a behavior; dispatch/fetchResult honor it.
class MockSeller implements SellerTransport {
  behaviors = new Map<string, { unreachable?: boolean; ready?: boolean; artifact?: Artifact }>();
  async dispatch(job: { jobId: string }): Promise<void> {
    if (this.behaviors.get(job.jobId)?.unreachable) throw new Error('ECONNREFUSED');
  }
  async fetchResult(job: { jobId: string }): Promise<Artifact | null> {
    const b = this.behaviors.get(job.jobId);
    return b?.ready ? (b.artifact ?? goodArtifact) : null;
  }
}

function harness() {
  const store = memStore();
  const seller = new MockSeller();
  const verify = vi.fn<(t: Task, a: Artifact) => Promise<VerdictRunResult>>().mockResolvedValue(vr('release'));
  const refundExpiredOnChain = vi.fn<(w: `0x${string}`) => Promise<string>>().mockResolvedValue('0xrefundexpired');
  const engine = makeEngine({
    store, transport: seller, verify, refundExpiredOnChain,
    getTask: async (w) => task(w as `0x${string}`),
    now: () => Date.now(),
    dispatch: { maxAttempts: 2, baseDelayMs: 1, sleep: () => Promise.resolve() },
  });
  const keeperDeps = { engine, listByState: store.listByState, transport: seller, now: () => Date.now() };
  return { store, seller, verify, refundExpiredOnChain, engine, keeperDeps };
}

const future = () => new Date(Date.now() + 3600_000);
const past = () => new Date(Date.now() - 1000);
const WORK = `0x${'ab'.repeat(32)}` as `0x${string}`;
const start = (h: ReturnType<typeof harness>, job: string, deadline: Date, protocol: jobStore.SellerProtocol = 'a2a') =>
  h.engine.startJob({ jobId: job, workId: WORK, sellerUrl: `${SELLER}/dispatch`, sellerProtocol: protocol, callbackToken: 'tok', resultRef: `${SELLER}/tasks/${job}`, deadline });

describe('Gate C1 — seller behaviors → correct terminal state + escrow call', () => {
  it('fast deliver (good) → SETTLED(release)', async () => {
    const h = harness(); await start(h, 'fast', future());
    h.seller.behaviors.set('fast', { ready: true });
    const n = await pollOnce(h.keeperDeps);
    expect(n).toBe(1);
    const row = await h.store.getJob('fast');
    expect(row!.state).toBe('SETTLED');
    expect(row!.outcome).toBe('release');
  });

  it('slow deliver → AWAITING on the first poll, SETTLED on a later poll', async () => {
    const h = harness(); await start(h, 'slow', future());
    await pollOnce(h.keeperDeps);
    expect((await h.store.getJob('slow'))!.state).toBe('AWAITING_DELIVERY');
    h.seller.behaviors.set('slow', { ready: true }); // seller finishes
    await pollOnce(h.keeperDeps);
    expect((await h.store.getJob('slow'))!.state).toBe('SETTLED');
  });

  it('no-show → EXPIRED via refundExpired (buyer refunded)', async () => {
    const h = harness(); await start(h, 'noshow', past());
    const n = await expireOnce(h.keeperDeps);
    expect(n).toBe(1);
    expect(h.refundExpiredOnChain).toHaveBeenCalledWith(WORK);
    const row = await h.store.getJob('noshow');
    expect(row!.state).toBe('EXPIRED');
    expect(row!.outcome).toBe('refund');
  });

  it('unreachable endpoint → retry then fail (stays FUNDED), keeper refunds at deadline', async () => {
    const h = harness();
    h.seller.behaviors.set('unreach', { unreachable: true });
    await start(h, 'unreach', past());
    let row = await h.store.getJob('unreach');
    expect(row!.state).toBe('FUNDED');            // funds not stranded
    expect(row!.dispatchAttempts).toBe(2);        // retried
    await expireOnce(h.keeperDeps);
    row = await h.store.getJob('unreach');
    expect(row!.state).toBe('EXPIRED');
    expect(h.refundExpiredOnChain).toHaveBeenCalledWith(WORK);
  });

  it('duplicate delivery → idempotent (verify runs once)', async () => {
    const h = harness(); await start(h, 'dup', future());
    const row = (await h.store.getJob('dup'))!;
    await h.engine.onDelivery(row, { artifact: goodArtifact });
    await h.engine.onDelivery(row, { artifact: goodArtifact }); // stale snapshot
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect((await h.store.getJob('dup'))!.state).toBe('SETTLED');
  });

  it('garbage delivery → refund verdict → SETTLED(refund), never a wrongful release', async () => {
    const h = harness(); h.verify.mockResolvedValue(vr('refund'));
    await start(h, 'garbage', future());
    await h.engine.onDelivery((await h.store.getJob('garbage'))!, { artifact: { type: 'answer', payload: 'unsupported' } });
    const row = await h.store.getJob('garbage');
    expect(row!.state).toBe('SETTLED');
    expect(row!.outcome).toBe('refund');
  });

  it('unverifiable delivery → abstain verdict → ABSTAINED (buyer refunded, no fee)', async () => {
    const h = harness(); h.verify.mockResolvedValue(vr('abstain'));
    await start(h, 'abstain', future());
    await h.engine.onDelivery((await h.store.getJob('abstain'))!, { artifact: goodArtifact });
    expect((await h.store.getJob('abstain'))!.state).toBe('ABSTAINED');
  });

  it('settlement that never confirms → job stays non-terminal for the keeper to expire', async () => {
    const h = harness(); h.verify.mockResolvedValue(vr('release', null)); // no tx hash
    await start(h, 'unconfirmed', future());
    await h.engine.onDelivery((await h.store.getJob('unconfirmed'))!, { artifact: goodArtifact });
    const row = await h.store.getJob('unconfirmed');
    expect(isTerminal(row!.state)).toBe(false);
    expect(row!.lastError).toMatch(/confirm/i);
  });
});

describe('Gate C1 — callback auth + replay + authoritative re-fetch', () => {
  const deps = (h: ReturnType<typeof harness>, onDelivery: CallbackDeps['onDelivery']): CallbackDeps => ({
    getJob: h.store.getJob, recordSeenJti: (() => { const seen = new Set<string>(); return async (jti: string) => (seen.has(jti) ? false : (seen.add(jti), true)); })(), onDelivery,
  });

  it('forged callback (wrong token) → 401, no delivery', async () => {
    const h = harness(); await start(h, 'forged', future(), 'webhook');
    const onDelivery = vi.fn().mockResolvedValue(undefined);
    const r = await handleCallback(deps(h, onDelivery), { protocol: 'webhook', jobId: 'forged', token: 'WRONG', jti: 'j1', artifact: goodArtifact });
    expect(r.status).toBe(401);
    expect(onDelivery).not.toHaveBeenCalled();
  });

  it('replayed jti → 409 on the second call, delivery fires only once', async () => {
    const h = harness(); await start(h, 'replay', future(), 'webhook');
    const onDelivery = vi.fn().mockResolvedValue(undefined);
    const d = deps(h, onDelivery);
    const first = await handleCallback(d, { protocol: 'webhook', jobId: 'replay', token: 'tok', jti: 'same', artifact: goodArtifact });
    const second = await handleCallback(d, { protocol: 'webhook', jobId: 'replay', token: 'tok', jti: 'same', artifact: goodArtifact });
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(onDelivery).toHaveBeenCalledTimes(1);
  });

  it('valid a2a callback → authoritative re-fetch → verdict → SETTLED (never trusts the pushed body)', async () => {
    const h = harness(); await start(h, 'valid', future(), 'a2a');
    h.seller.behaviors.set('valid', { ready: true }); // seller exposes the authoritative result
    const r = await handleCallback(deps(h, h.engine.onDelivery), { protocol: 'a2a', jobId: 'valid', token: 'tok', jti: 'v1', resultRef: `${SELLER}/tasks/valid` });
    expect(r.status).toBe(202);
    // onDelivery is fire-and-forget; give the microtask queue a beat (all in-memory, resolves fast).
    await new Promise((res) => setTimeout(res, 20));
    expect(h.verify).toHaveBeenCalled();
    expect((await h.store.getJob('valid'))!.state).toBe('SETTLED');
  });
});

// The one property that only means something against real persistence: a job created before a
// "restart" is picked up by a fresh engine reading state back from Postgres.
describe('Gate C1 — leave-and-return (DB-backed survival across a worker restart)', () => {
  const workId = `0x${Buffer.from(`restart${Date.now()}`).toString('hex').padEnd(64, '0').slice(0, 64)}` as `0x${string}`;
  const job = `c1-restart-${Date.now()}`;

  beforeAll(() => { if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL required'); });
  afterAll(async () => {
    await sql`DELETE FROM vk_jobs WHERE job_id = ${job}`;
    await sql`DELETE FROM vk_tasks WHERE work_id = ${workId}`;
  });

  it('a fresh engine resumes an AWAITING job from Postgres and settles it', async () => {
    await insertTask(task(workId));
    // Engine #1 creates + advances the job to AWAITING_DELIVERY (persisted to Postgres).
    await jobStore.createJob({ jobId: job, workId, sellerUrl: `${SELLER}/d`, sellerProtocol: 'a2a', callbackToken: 'tok', resultRef: `${SELLER}/tasks/${job}`, deadline: future() });
    await jobStore.markDispatched(job);
    await jobStore.markAwaiting(job);

    // "Restart": a brand-new engine over the REAL store, no in-memory carryover.
    const verify = vi.fn<(t: Task, a: Artifact) => Promise<VerdictRunResult>>().mockResolvedValue(vr('release'));
    const engine2 = makeEngine({
      store: jobStore as JobStore, transport: new MockSeller(), verify, getTask,
      refundExpiredOnChain: vi.fn().mockResolvedValue('0x'), now: () => Date.now(),
      dispatch: { maxAttempts: 1, baseDelayMs: 1, sleep: () => Promise.resolve() },
    });

    const resumed = await jobStore.getJob(job); // state read back from Postgres
    expect(resumed!.state).toBe('AWAITING_DELIVERY');
    await engine2.onDelivery(resumed!, { artifact: goodArtifact });
    expect((await jobStore.getJob(job))!.state).toBe('SETTLED');
  }, 40_000);
});
