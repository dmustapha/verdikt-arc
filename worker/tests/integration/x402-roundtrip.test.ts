import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { sql } from '@vercel/postgres';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { privateKeyToAccount } from 'viem/accounts';
import { insertTask, getTask } from '../../src/lib/db.js';
import * as jobStore from '../../src/lib/job-store.js';
import type { JobStore } from '../../src/lib/job-engine.js';
import { makeEngine } from '../../src/lib/job-engine.js';
import { sellerAdapter } from '../../src/lib/adapter/index.js';
import { x402Driver } from '../../src/lib/adapter/x402.js';
import { httpTransport } from '../../src/lib/transport.js';
import { pollOnce } from '../../src/lib/keeper.js';
import type { KeeperDeps } from '../../src/lib/keeper.js';
import type { Task as VkTask, Artifact, VerdictResult } from '../../src/types.js';
import type { VerdictRunResult } from '../../src/engine/orchestrator.js';

// THE continuous x402 seller round-trip over REAL sockets — the flow WS4 never ran end-to-end (only a
// fetch-layer mock). A REAL express x402 seller (402 PAYMENT-REQUIRED → accept the toll → 202 + job URL
// → serve the result) is invoked through the production adapter composition, with the driver doing REAL
// EIP-3009 signing (@x402/fetch + @x402/evm, offline) over the socket:
//   engine.startJob → sellerAdapter → x402Driver.dispatch (402 → sign sub-cent toll → 202, job URL
//   persisted via onResultRef=jobStore.setResultRef) → keeper.pollOnce → x402Driver.fetchResult (plain
//   GET, polling is free) → engine.onDelivery → verify → SETTLED.
// The RECONCILIATION invariant is asserted end-to-end: the seller collected AT MOST the toll cap, and
// exactly ONE toll — the bounty is never paid via x402. verify is a spy (no chain spend); the live Arc
// toll leg (self-hosted facilitator) is a separate concern. Closes the WS4 [IMPORTANT] gap for x402.

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const workId = `0x${Buffer.from(`x402${suffix}`).toString('hex').padEnd(64, '0').slice(0, 64)}` as `0x${string}`;
const jobId = `x402-${suffix}`;
const deliveredArtifact: Artifact = { type: 'answer', payload: 'The x402 seller delivered a grounded answer.' };

const NETWORK = 'eip155:5042002' as const; // Arc
const USDC = `0x${'11'.repeat(20)}` as `0x${string}`;
const PAY_TO = `0x${'22'.repeat(20)}` as `0x${string}`;
const TOLL_CAP = 10_000n;   // $0.01 (6-dec) hard ceiling
const TOLL = '1000';        // $0.001 — a real sub-cent toll within cap
const tollPayer = privateKeyToAccount(`0x${'a1'.repeat(32)}`); // offline signer, never touches a chain

const verdict = { verdict: 'pass', confidence: 1, citedEvidence: [], rationale: '', route: 'answer', evidenceHash: `0x${'0'.repeat(64)}`, verdictCode: 0 } as VerdictResult;
const verify = vi.fn<(t: VkTask, a: Artifact) => Promise<VerdictRunResult>>().mockResolvedValue({ verdict, outcome: 'release', txHash: '0xsettle' });

let sellerServer: Server, sellerBase = '';
let engine: ReturnType<typeof makeEngine>;
let keeperDeps: KeeperDeps;
const collected = { paidCount: 0, paidValue: null as string | null };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const listen = (app: express.Express): Promise<{ server: Server; base: string }> =>
  new Promise((resolve) => { const s = app.listen(0, () => resolve({ server: s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` })); });

function paymentRequired(base: string) {
  return {
    x402Version: 2,
    resource: { url: `${base}/dispatch`, description: 'verdikt seller toll', mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: NETWORK, asset: USDC, amount: TOLL, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' } }],
  };
}

// A REAL x402 seller. Unpaid POST → 402 (PAYMENT-REQUIRED header). Paid POST (PAYMENT-SIGNATURE header)
// → records the toll it actually collected, returns 202 + a SAME-ORIGIN job URL. GET job URL → the
// artifact. (A production seller would verify+settle the toll via a facilitator; here we only stand in
// for the seller's HTTP so the DRIVER's real signing + async poll flow is exercised over sockets.)
function makeSellerApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.post('/dispatch', (req, res) => {
    const base = `http://${req.get('host')}`; // self-consistent origin — no pre-bound port needed
    const paySig = req.get('payment-signature');
    if (!paySig) {
      res.status(402).set('PAYMENT-REQUIRED', encodePaymentRequiredHeader(paymentRequired(base))).end();
      return;
    }
    collected.paidCount++;
    try {
      const decoded = JSON.parse(Buffer.from(paySig, 'base64').toString('utf8')) as { payload: { authorization: { value: string } } };
      collected.paidValue = decoded.payload.authorization.value;
    } catch { /* leave null — the assertion will catch a malformed header */ }
    res.status(202).json({ jobUrl: `${base}/jobs/${jobId}` });
  });
  app.get('/jobs/:id', (_req, res) => { res.status(200).json({ artifact: deliveredArtifact }); });
  return app;
}

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL required');

  ({ server: sellerServer, base: sellerBase } = await listen(makeSellerApp()));

  const transport = sellerAdapter({
    webhook: httpTransport({ workerPublicUrl: '', allowPrivate: true }),
    a2a: { async dispatch() { throw new Error('a2a not under test'); }, async fetchResult() { return null; } },
    x402: x402Driver({ network: NETWORK, tollCapAtomic: TOLL_CAP, account: tollPayer, allowPrivate: true, onResultRef: jobStore.setResultRef, workerPublicUrl: '' }),
  });
  engine = makeEngine({
    store: jobStore as JobStore,
    transport, verify, getTask,
    refundExpiredOnChain: vi.fn<() => Promise<string>>().mockResolvedValue('0x'),
    now: () => Date.now(),
    dispatch: { maxAttempts: 2, baseDelayMs: 5, sleep },
  });
  keeperDeps = { engine, listByState: jobStore.listByState, transport, now: () => Date.now() };
});

afterAll(async () => {
  await new Promise<void>((r) => sellerServer.close(() => r()));
  await sql`DELETE FROM vk_jobs WHERE job_id = ${jobId}`;
  await sql`DELETE FROM vk_tasks WHERE work_id = ${workId}`;
});

async function pollForState(want: string, ms = 15_000): Promise<string> {
  const end = Date.now() + ms; let last = '';
  while (Date.now() < end) {
    await pollOnce(keeperDeps);
    last = (await jobStore.getJob(jobId))?.state ?? '';
    if (last === want) return last;
    await sleep(250);
  }
  return last;
}

describe('x402 seller round-trip over real sockets', () => {
  it('startJob → 402 → sign toll → 202 + job URL persisted → poll GET → verify → SETTLED (toll ≤ cap, paid once)', async () => {
    const task: VkTask = { workId, type: 'answer', payer: `0x${'11'.repeat(20)}`, worker: `0x${'22'.repeat(20)}`, amountUsdc: 0.1, acceptance: { spec: 'answer grounded', sources: 'The x402 seller delivered a grounded answer.' } };
    await insertTask(task);

    await engine.startJob({ jobId, workId, sellerUrl: `${sellerBase}/dispatch`, sellerProtocol: 'x402', callbackToken: `tok-${suffix}`, resultRef: null, deadline: new Date(Date.now() + 3600_000) });

    // Reconciliation invariant, proven over the wire: exactly one toll, at most the cap. Never the bounty.
    expect(collected.paidCount).toBe(1);
    expect(collected.paidValue).toBe(TOLL);
    expect(BigInt(collected.paidValue!)).toBeLessThanOrEqual(TOLL_CAP);

    // dispatch persisted the seller's async job URL as the job's resultRef.
    const afterDispatch = await jobStore.getJob(jobId);
    expect(afterDispatch!.resultRef).toBe(`${sellerBase}/jobs/${jobId}`);

    expect(await pollForState('SETTLED')).toBe('SETTLED');

    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ workId }), deliveredArtifact);
    const row = await jobStore.getJob(jobId);
    expect(row!.outcome).toBe('release');
    expect(row!.artifact).toEqual(deliveredArtifact);
    // Polling never pays: still exactly one toll after the GET-driven delivery.
    expect(collected.paidCount).toBe(1);
  });
});
