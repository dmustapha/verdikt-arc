import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { sql } from '@vercel/postgres';
import { insertTask, getTask } from '../../src/lib/db.js';
import * as jobStore from '../../src/lib/job-store.js';
import type { JobStore } from '../../src/lib/job-engine.js';
import { makeEngine } from '../../src/lib/job-engine.js';
import { httpTransport } from '../../src/lib/transport.js';
import { makeCallbackRouter } from '../../src/routes/callback.js';
import type { CallbackDeps } from '../../src/routes/callback.js';
import type { Task, Artifact, VerdictResult } from '../../src/types.js';
import type { VerdictRunResult } from '../../src/engine/orchestrator.js';

// THE continuous seller round-trip over REAL sockets — the flow that WS3 never ran as one path:
//   engine.startJob → httpTransport.dispatch (real POST) → seller HTTP server does work →
//   seller POSTs the signed callback (real POST) → our callback router → engine.onDelivery →
//   verify → settle. verify is a spy (release) so this is repeatable with no chain spend; the real
//   runVerdict→Arc settle leg is proven live in prove-seller-roundtrip.ts. Closes "never run over
//   sockets as a single flow".

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 }); // real sockets + Neon polling

const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const workId = `0x${Buffer.from(`rt${suffix}`).toString('hex').padEnd(64, '0').slice(0, 64)}` as `0x${string}`;
const jobId = `rt-${suffix}`;
const deliveredArtifact: Artifact = { type: 'answer', payload: 'the grounded answer the seller produced' };

const verdict = { verdict: 'pass', confidence: 1, citedEvidence: [], rationale: '', route: 'answer', evidenceHash: `0x${'0'.repeat(64)}`, verdictCode: 0 } as VerdictResult;
const verify = vi.fn<(t: Task, a: Artifact) => Promise<VerdictRunResult>>().mockResolvedValue({ verdict, outcome: 'release', txHash: '0xsettle' });

let sellerServer: Server, workerServer: Server;
let sellerBase = '', workerBase = '';
const dispatchesReceived: unknown[] = [];
// Mutable indirection breaks the chicken-and-egg: the worker must listen to know its URL, but the
// engine's transport needs that URL — so the router calls through this ref, set once the engine exists.
let onDeliveryRef: CallbackDeps['onDelivery'] = async () => {};
let engine: ReturnType<typeof makeEngine>;

const listen = (app: express.Express): Promise<{ server: Server; base: string }> =>
  new Promise((resolve) => { const s = app.listen(0, () => resolve({ server: s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` })); });

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL required');

  const workerApp = express();
  workerApp.use(express.json());
  workerApp.use(makeCallbackRouter((job, d) => onDeliveryRef(job, d)));
  ({ server: workerServer, base: workerBase } = await listen(workerApp));

  engine = makeEngine({
    store: jobStore as JobStore,
    transport: httpTransport({ workerPublicUrl: workerBase, allowPrivate: true }),
    verify, getTask,
    refundExpiredOnChain: vi.fn<() => Promise<string>>().mockResolvedValue('0x'),
    now: () => Date.now(),
    dispatch: { maxAttempts: 2, baseDelayMs: 5, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) },
  });
  onDeliveryRef = engine.onDelivery;

  const sellerApp = express();
  sellerApp.use(express.json());
  sellerApp.post('/dispatch', (req, res) => {
    dispatchesReceived.push(req.body);
    const { callbackUrl, callbackToken } = req.body as { callbackUrl: string; callbackToken: string };
    res.status(202).json({ accepted: true });
    // "Work", then call back FAST (0ms) — exercises the fast-callback race (delivery may land while
    // the job is still FUNDED).
    setTimeout(() => {
      void fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Callback-Token': callbackToken },
        body: JSON.stringify({ jti: `rt-jti-${suffix}`, artifact: deliveredArtifact }),
      }).catch(() => {});
    }, 0);
  });
  ({ server: sellerServer, base: sellerBase } = await listen(sellerApp));
});

afterAll(async () => {
  await new Promise<void>((r) => sellerServer.close(() => r()));
  await new Promise<void>((r) => workerServer.close(() => r()));
  await sql`DELETE FROM vk_jobs WHERE job_id = ${jobId}`;
  await sql`DELETE FROM vk_seen_jti WHERE job_id = ${jobId}`;
  await sql`DELETE FROM vk_tasks WHERE work_id = ${workId}`;
});

async function waitForState(want: string, ms = 15_000): Promise<string> {
  const end = Date.now() + ms; let last = '';
  while (Date.now() < end) { last = (await jobStore.getJob(jobId))?.state ?? ''; if (last === want) return last; await new Promise((r) => setTimeout(r, 250)); }
  return last;
}

describe('seller round-trip over real sockets', () => {
  it('startJob → dispatch → seller callback → verify → SETTLED, artifact flows across the wire', async () => {
    const task: Task = { workId, type: 'answer', payer: `0x${'11'.repeat(20)}`, worker: `0x${'22'.repeat(20)}`, amountUsdc: 0.1, acceptance: { spec: 'answer grounded', sources: 'the seller is right' } };
    await insertTask(task);

    await engine.startJob({ jobId, workId, sellerUrl: `${sellerBase}/dispatch`, sellerProtocol: 'webhook', callbackToken: `tok-${suffix}`, resultRef: null, deadline: new Date(Date.now() + 3600_000) });

    expect(await waitForState('SETTLED')).toBe('SETTLED');

    // The seller actually received a dispatch envelope pointing back at OUR callback URL.
    expect(dispatchesReceived).toHaveLength(1);
    expect((dispatchesReceived[0] as { callbackUrl: string }).callbackUrl).toBe(`${workerBase}/webhook/callback/${jobId}`);
    // …and its route-filtered brief (Option C): the question + the sources to ground in.
    expect((dispatchesReceived[0] as { brief?: unknown }).brief).toEqual({ type: 'answer', spec: 'answer grounded', sources: 'the seller is right' });

    // The artifact that was verified is the one the seller sent over the wire (not a local shortcut).
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ workId }), deliveredArtifact);
    const row = await jobStore.getJob(jobId);
    expect(row!.outcome).toBe('release');
    expect(row!.artifact).toEqual(deliveredArtifact);
  });
});
