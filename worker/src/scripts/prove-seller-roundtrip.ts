// LIVE continuous seller round-trip on Arc — the WHOLE path over real sockets with real money:
//   fund escrow → engine.startJob → httpTransport.dispatch (real POST) → a real seller HTTP server
//   does the work → seller POSTs the signed callback (real POST) → our callback router →
//   engine.onDelivery → REAL runVerdict (Anthropic) → REAL settle on Arc. Asserts the worker was paid
//   the exact bounty. This is the single continuous flow that the WS3 tests split apart.
//
// Run:  set -a; . ./.env; set +a;  npx tsx worker/src/scripts/prove-seller-roundtrip.ts
import express from 'express';
import type { Server } from 'node:http';
import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomUUID } from 'node:crypto';
import { arcTestnet } from '../lib/chains.js';
import { fundEscrow } from '../settlement/fund-escrow.js';
import { refundExpiredOnChain } from '../settlement/expire.js';
import { runVerdict } from '../engine/orchestrator.js';
import { makeEngine } from '../lib/job-engine.js';
import type { JobStore } from '../lib/job-engine.js';
import * as jobStore from '../lib/job-store.js';
import { insertTask, getTask, recordFunded } from '../lib/db.js';
import { httpTransport } from '../lib/transport.js';
import { makeCallbackRouter } from '../routes/callback.js';
import type { CallbackDeps } from '../routes/callback.js';
import { VERDIKT_ESCROW_ABI } from '../settlement/escrow-abi.js';
import type { Task } from '../types.js';

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const USDC = '0x3600000000000000000000000000000000000000' as const;
const EXPLORER = 'https://testnet.arcscan.app';
const payer = process.env.DEMO_PAYER_ADDRESS as `0x${string}`;
const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
const AMOUNT_USDC = 0.05, FEE_USDC = 0.01, BOUNTY = 40000n;
const RUN = Date.now().toString();

const pub = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const bal = async (a: `0x${string}`) => (await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })) as bigint;
const readEscrow = async (w: `0x${string}`) => (await pub.readContract({ address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'getEscrow', args: [w] })) as { status: number; deadline: bigint };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const listen = (app: express.Express): Promise<{ server: Server; base: string }> =>
  new Promise((res) => { const s = app.listen(0, () => res({ server: s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` })); });

let onDeliveryRef: CallbackDeps['onDelivery'] = async () => {};

async function main() {
  console.log(`\nWS3 LIVE seller round-trip — escrow ${ESCROW} (${RUN})`);

  // 1. Worker callback server (real router → real engine).
  const workerApp = express();
  workerApp.use(express.json());
  workerApp.use(makeCallbackRouter((job, d) => onDeliveryRef(job, d)));
  const { server: workerServer, base: workerBase } = await listen(workerApp);

  const engine = makeEngine({
    store: jobStore as JobStore,
    transport: httpTransport({ workerPublicUrl: workerBase, allowPrivate: true }),
    verify: runVerdict, getTask, refundExpiredOnChain,
    now: () => Date.now(),
    dispatch: { maxAttempts: 2, baseDelayMs: 200, sleep },
  });
  onDeliveryRef = engine.onDelivery;

  // 2. A real seller: on dispatch it acks, "works", then POSTs a grounded answer back to us.
  const workId = keccak256(stringToHex(`rt-live-${RUN}`));
  const worker = privateKeyToAccount(keccak256(stringToHex(`rt-worker-${RUN}`))).address;
  const sellerApp = express();
  sellerApp.use(express.json());
  sellerApp.post('/dispatch', (req, res) => {
    const { callbackUrl, callbackToken } = req.body as { callbackUrl: string; callbackToken: string };
    console.log(`  [seller] received dispatch → will call back ${callbackUrl}`);
    res.status(202).json({ accepted: true });
    setTimeout(() => {
      void fetch(callbackUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Callback-Token': callbackToken },
        body: JSON.stringify({ jti: `rt-live-jti-${RUN}`, artifact: { type: 'answer', payload: 'The capital of France is Paris.' } }),
      }).catch((e) => console.error('  [seller] callback failed', e));
    }, 500);
  });
  const { server: sellerServer, base: sellerBase } = await listen(sellerApp);

  // 3. Register the task + fund a real escrow on Arc.
  const task: Task = { workId, type: 'answer', payer, worker, amountUsdc: AMOUNT_USDC, acceptance: { spec: 'answer grounded in sources', sources: 'The capital of France is Paris. Paris sits on the river Seine.' } };
  await insertTask(task);
  const fundTx = await fundEscrow({ payerKey, workId, worker, amountUsdc: AMOUNT_USDC, feeUsdc: FEE_USDC, ttlSeconds: 604800 });
  await recordFunded(workId, fundTx);
  const e = await readEscrow(workId);
  if (e.status !== 1) throw new Error('escrow not FUNDED');
  console.log(`  funded ${EXPLORER}/tx/${fundTx}`);

  // 4. Start the job → real dispatch → seller → real callback → runVerdict → real Arc settle.
  const jobId = randomUUID();
  const w0 = await bal(worker);
  await engine.startJob({ jobId, workId, sellerUrl: `${sellerBase}/dispatch`, sellerProtocol: 'webhook', callbackToken: `tok-${RUN}`, resultRef: null, deadline: new Date(Number(e.deadline) * 1000) });

  // 5. Wait for the async round-trip to land SETTLED.
  let state = '';
  for (let i = 0; i < 40; i++) { state = (await jobStore.getJob(jobId))?.state ?? ''; if (state === 'SETTLED' || state === 'ABSTAINED' || state === 'EXPIRED') break; await sleep(1000); }
  const job = await jobStore.getJob(jobId);
  const wD = (await bal(worker)) - w0;
  console.log(`  job=${state} outcome=${job?.outcome} settle=${EXPLORER}/tx/${job?.settleTxHash}`);
  console.log(`  worker Δ${wD}`);

  workerServer.close(); sellerServer.close();

  if (state !== 'SETTLED' || job?.outcome !== 'release') throw new Error(`expected SETTLED/release, got ${state}/${job?.outcome}`);
  if (wD !== BOUNTY) throw new Error(`worker should receive bounty ${BOUNTY}, got ${wD}`);
  console.log(`\n  ✅ FULL seller round-trip proven LIVE over sockets + Arc:`);
  console.log(`  dispatch(POST)→seller→callback(POST)→verify→SETTLE  worker +${Number(wD) / 1e6} USDC  \`${job?.settleTxHash}\``);
  process.exit(0);
}

main().catch((e) => { console.error('SELLER ROUND-TRIP PROOF FAILED:', e); process.exit(1); });
