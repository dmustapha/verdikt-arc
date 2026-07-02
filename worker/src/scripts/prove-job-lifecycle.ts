// WS3 Gate C1 — prove the ASYNC JOB LIFECYCLE end-to-end LIVE on Arc, driving the REAL engine
// (real job-store + real runVerdict + real refundExpired) with a stub seller transport (delivery is
// fed inline, exactly as a webhook callback would). Two real escrows:
//   A. happy path: fund → startJob(dispatch) → onDelivery(grounded answer) → runVerdict → SETTLE (release)
//   B. no-show:    fund (short TTL) → startJob → wait past deadline → expireJob → refundExpired (buyer refunded)
// Balance deltas are asserted against the on-chain outcome; the job's terminal DB state is asserted too.
//
// Run:  set -a; . ./.env; set +a;  npx tsx worker/src/scripts/prove-job-lifecycle.ts
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
import { VERDIKT_ESCROW_ABI } from '../settlement/escrow-abi.js';
import type { SellerTransport } from '../lib/transport.js';
import type { Task, Artifact } from '../types.js';

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const USDC = '0x3600000000000000000000000000000000000000' as const;
const RPC = process.env.ARC_RPC_URL!;
const EXPLORER = 'https://testnet.arcscan.app';
const payer = process.env.DEMO_PAYER_ADDRESS as `0x${string}`;
const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;

const AMOUNT_USDC = 0.05, FEE_USDC = 0.01;
const TOTAL = 50000n, FEE = 10000n, BOUNTY = TOTAL - FEE;
const RUN = Date.now().toString();

const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const bal = async (a: `0x${string}`) => (await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })) as bigint;
const readEscrow = async (w: `0x${string}`) => (await pub.readContract({ address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'getEscrow', args: [w] })) as { status: number; outcome: number; deadline: bigint };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Stub transport: dispatch always succeeds (delivery is fed inline via onDelivery, like a webhook).
const stubTransport: SellerTransport = { dispatch: async () => {}, fetchResult: async () => null };

const engine = makeEngine({
  store: jobStore as JobStore,
  transport: stubTransport,
  verify: runVerdict,          // the REAL verify → settle path
  getTask,
  refundExpiredOnChain,        // the REAL on-chain no-show refund
  now: () => Date.now(),
  dispatch: { maxAttempts: 2, baseDelayMs: 200, sleep },
});

async function fundJob(tag: string, task: Task, ttlSeconds: number): Promise<{ jobId: string; deadline: Date; fundTx: string }> {
  await insertTask(task);
  const fundTx = await fundEscrow({ payerKey, workId: task.workId, worker: task.worker, amountUsdc: AMOUNT_USDC, feeUsdc: FEE_USDC, ttlSeconds });
  await recordFunded(task.workId, fundTx);
  const e = await readEscrow(task.workId);
  if (e.status !== 1) throw new Error(`${tag}: escrow not FUNDED`);
  const jobId = randomUUID();
  await engine.startJob({ jobId, workId: task.workId, sellerUrl: 'https://seller.example.com/dispatch', sellerProtocol: 'webhook', callbackToken: `tok-${tag}`, resultRef: null, deadline: new Date(Number(e.deadline) * 1000) });
  const job = await jobStore.getJob(jobId);
  if (job?.state !== 'AWAITING_DELIVERY') throw new Error(`${tag}: expected AWAITING_DELIVERY, got ${job?.state}`);
  console.log(`  [${tag}] funded ${EXPLORER}/tx/${fundTx} → job ${jobId.slice(0, 8)} AWAITING_DELIVERY`);
  return { jobId, deadline: new Date(Number(e.deadline) * 1000), fundTx };
}

async function partA() {
  console.log('\n── Part A: full lifecycle → SETTLE(release) ──');
  const worker = privateKeyToAccount(keccak256(stringToHex(`job-A-${RUN}`))).address;
  const workId = keccak256(stringToHex(`joblc-A-${RUN}`));
  const task: Task = {
    workId, type: 'answer', payer, worker, amountUsdc: AMOUNT_USDC,
    acceptance: { spec: 'answer grounded in sources', sources: 'The capital of France is Paris. Paris sits on the river Seine.' },
  };
  const { jobId } = await fundJob('A', task, 604800);
  const artifact: Artifact = { type: 'answer', payload: 'The capital of France is Paris.' };

  const w0 = await bal(worker), p0 = await bal(payer);
  await engine.onDelivery((await jobStore.getJob(jobId))!, { artifact });
  const job = await jobStore.getJob(jobId);
  const wD = (await bal(worker)) - w0, pD = (await bal(payer)) - p0;
  console.log(`  [A] job=${job!.state} outcome=${job!.outcome} settle=${EXPLORER}/tx/${job!.settleTxHash}`);
  console.log(`      worker Δ${wD}  payer Δ${pD}`);
  if (job!.state !== 'SETTLED' || job!.outcome !== 'release') throw new Error(`A: expected SETTLED/release, got ${job!.state}/${job!.outcome}`);
  if (wD !== BOUNTY) throw new Error(`A: worker should receive bounty ${BOUNTY}, got ${wD}`);
  return { jobId, tx: job!.settleTxHash };
}

async function partB() {
  console.log('\n── Part B: no-show → refundExpired(buyer refunded) ──');
  const worker = privateKeyToAccount(keccak256(stringToHex(`job-B-${RUN}`))).address;
  const workId = keccak256(stringToHex(`joblc-B-${RUN}`));
  const task: Task = { workId, type: 'answer', payer, worker, amountUsdc: AMOUNT_USDC, acceptance: { spec: 'never delivered', sources: 'x' } };
  const { jobId, deadline } = await fundJob('B', task, 2); // 2s TTL — expires almost immediately

  // Wait until an Arc block timestamp is past the escrow deadline (refundExpired guards on-chain time).
  console.log('  [B] waiting for a block past the deadline…');
  for (let i = 0; i < 30; i++) {
    const block = await pub.getBlock();
    if (Number(block.timestamp) > Number(deadline.getTime() / 1000)) break;
    await sleep(2000);
  }

  const p0 = await bal(payer);
  const r = await engine.expireJob(jobId);
  const job = await jobStore.getJob(jobId);
  const pD = (await bal(payer)) - p0;
  console.log(`  [B] expired=${r.expired} job=${job!.state} refundExpired=${EXPLORER}/tx/${r.txHash}`);
  console.log(`      payer Δ${pD}`);
  if (!r.expired || job!.state !== 'EXPIRED') throw new Error(`B: expected EXPIRED, got ${job!.state}`);
  if (pD !== TOTAL) throw new Error(`B: no-show should refund buyer the full ${TOTAL} (bounty+fee), got ${pD}`);
  return { jobId, tx: r.txHash };
}

async function main() {
  console.log(`\nWS3 job-lifecycle live e2e — escrow ${ESCROW} (${RUN})`);
  const a = await partA();
  const b = await partB();
  console.log('\n  ✅ WS3 lifecycle proven LIVE on Arc:');
  console.log(`  | happy path  | dispatch→deliver→verify→SETTLE(release) | \`${a.tx}\` |`);
  console.log(`  | no-show     | expire→refundExpired (buyer refunded)   | \`${b.tx}\` |`);
}

main().catch((e) => { console.error('JOB LIFECYCLE PROOF FAILED:', e); process.exit(1); });
