// GATE C3 — the FULL loop for a live reference seller, over real sockets, with real money on Arc:
//   spawn the REAL reference-seller service (Claude-powered) → register + fund a REAL escrow on Arc →
//   engine.startJob → httpTransport.dispatch (real POST) → the seller does the work with a real Claude
//   brain → seller POSTs the signed callback → our callback router → engine.onDelivery → REAL runVerdict
//   (grounding) → REAL settle on Arc. Two scenarios prove the money gate both ways:
//     RELEASE — a groundable question → grounded answer → PASS → the worker (seller payout) is paid the bounty.
//     REFUND  — an ungroundable question → the seller HONESTLY refuses → not grounded → ABSTAIN/REFUND;
//               the buyer is refunded and the seller earns nothing (never a wrongful release).
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/prove-reference-loop.ts
import express from 'express';
import type { Server } from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
import type { Task, Acceptance, Outcome } from '../types.js';

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const USDC = '0x3600000000000000000000000000000000000000' as const;
const EXPLORER = 'https://testnet.arcscan.app';
const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
const AMOUNT_USDC = 0.05, FEE_USDC = 0.01, BOUNTY = 40000n; // bounty = (amount - fee) in atomic USDC
const SELLER_PORT = 8799;
const RUN = Date.now().toString();

const pub = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const bal = async (a: `0x${string}`) => (await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })) as bigint;
const readEscrow = async (w: `0x${string}`) => (await pub.readContract({ address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'getEscrow', args: [w] })) as { status: number; deadline: bigint };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const listen = (app: express.Express): Promise<{ server: Server; base: string }> =>
  new Promise((res) => { const s = app.listen(0, () => res({ server: s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` })); });

let onDeliveryRef: CallbackDeps['onDelivery'] = async () => {};

// Spawn the real reference-seller service as a separate process (a faithful remote seller) and wait for health.
async function startSeller(): Promise<{ proc: ChildProcess; base: string }> {
  const cwd = fileURLToPath(new URL('../../../agents/reference', import.meta.url));
  // detached:true puts the seller (npx + its node child) in its own PROCESS GROUP so we can kill the
  // WHOLE tree with kill(-pid) — killing just `npx` leaves an orphaned node holding our stdout pipe open
  // (which hangs any `| tail` wrapper long after this process exits). pipe stdout so it never inherits ours.
  const proc = spawn('npx', ['tsx', 'src/server.ts'], { cwd, env: { ...process.env, PORT: String(SELLER_PORT) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const base = `http://127.0.0.1:${SELLER_PORT}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return { proc, base }; } catch { /* not up yet */ }
    await sleep(500);
  }
  killTree(proc);
  throw new Error('reference seller did not become healthy');
}

// Kill the seller's whole process group (npx + node child); fall back to a direct kill.
function killTree(proc: ChildProcess): void {
  try { if (proc.pid) process.kill(-proc.pid, 'SIGKILL'); }
  catch { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }
}

interface Scenario { skill: string; label: string; route: Task['type']; acceptance: Acceptance; expect: 'release' | 'not-release'; }

async function runScenario(sc: Scenario, transport: ReturnType<typeof httpTransport>, sellerBase: string): Promise<void> {
  const engine = makeEngine({
    store: jobStore as JobStore, transport, verify: runVerdict, getTask, refundExpiredOnChain,
    now: () => Date.now(), dispatch: { maxAttempts: 2, baseDelayMs: 200, sleep },
  });
  onDeliveryRef = engine.onDelivery;

  const workId = keccak256(stringToHex(`refloop-${sc.label}-${RUN}`));
  const worker = privateKeyToAccount(keccak256(stringToHex(`refworker-${sc.label}-${RUN}`))).address;
  const task: Task = { workId, type: sc.route, payer: privateKeyToAccount(payerKey).address, worker, amountUsdc: AMOUNT_USDC, acceptance: sc.acceptance };
  await insertTask(task);

  const fundTx = await fundEscrow({ payerKey, workId, worker, amountUsdc: AMOUNT_USDC, feeUsdc: FEE_USDC, ttlSeconds: 604800 });
  await recordFunded(workId, fundTx);
  const e = await readEscrow(workId);
  if (e.status !== 1) throw new Error(`[${sc.label}] escrow not FUNDED`);
  console.log(`\n[${sc.label}] (${sc.skill}) funded ${EXPLORER}/tx/${fundTx}`);

  const jobId = randomUUID();
  const w0 = await bal(worker), p0 = await bal(task.payer);
  await engine.startJob({ jobId, workId, sellerUrl: `${sellerBase}/${sc.skill}/dispatch`, sellerProtocol: 'webhook', callbackToken: `tok-${sc.label}-${RUN}`, resultRef: null, deadline: new Date(Number(e.deadline) * 1000) });

  let state = '';
  for (let i = 0; i < 90; i++) { state = (await jobStore.getJob(jobId))?.state ?? ''; if (['SETTLED', 'ABSTAINED', 'EXPIRED'].includes(state)) break; await sleep(1000); }
  const job = await jobStore.getJob(jobId);
  const wD = (await bal(worker)) - w0, pD = (await bal(task.payer)) - p0;
  console.log(`[${sc.label}] job=${state} outcome=${job?.outcome} settle=${EXPLORER}/tx/${job?.settleTxHash}`);
  console.log(`[${sc.label}] artifact: ${JSON.stringify(job?.artifact).slice(0, 120)}`);
  console.log(`[${sc.label}] worker Δ${wD}  payer Δ${pD}`);

  const outcome = job?.outcome as Outcome | undefined;
  if (sc.expect === 'release') {
    if (state !== 'SETTLED' || outcome !== 'release') throw new Error(`[${sc.label}] expected SETTLED/release, got ${state}/${outcome}`);
    if (wD !== BOUNTY) throw new Error(`[${sc.label}] worker should receive bounty ${BOUNTY}, got ${wD}`);
    console.log(`[${sc.label}] ✅ RELEASE: worker paid +${Number(wD) / 1e6} USDC for verified-good work`);
  } else {
    if (outcome === 'release' || wD > 0n) throw new Error(`[${sc.label}] WRONGFUL RELEASE — bad output must never pay the seller (outcome=${outcome}, wΔ=${wD})`);
    console.log(`[${sc.label}] ✅ ${outcome?.toUpperCase()}: seller earned nothing; buyer made whole (payer Δ${pD})`);
  }
}

// The tool_output verdict runs ajv (no sandbox) and the answer route runs grounding (no sandbox), so
// those run anywhere. The code route runs the payer's pytest in a Docker sandbox — gate the code
// scenarios on Docker being up so a degraded Docker is reported honestly, never silently skipped.
function dockerUp(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 6000 }); return true; }
  catch { return false; }
}

async function main() {
  console.log(`GATE C3 reference-seller loop — escrow ${ESCROW} (${RUN})`);
  const { proc, base: sellerBase } = await startSeller();
  console.log(`reference seller healthy @ ${sellerBase}`);

  const workerApp = express();
  workerApp.use(express.json());
  workerApp.use(makeCallbackRouter((job, d) => onDeliveryRef(job, d)));
  const { server: workerServer, base: workerBase } = await listen(workerApp);
  const transport = httpTransport({ workerPublicUrl: workerBase, allowPrivate: true });

  const personSchema = (required: string[]) => ({ type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' }, occupation: { type: 'string' } }, required, additionalProperties: false });
  const AVG_TESTS = 'from solution import average\n\ndef test_mean():\n    assert average([2, 4, 6]) == 4\n\ndef test_empty():\n    assert average([]) == 0\n';

  const scenarios: Scenario[] = [
    // Research (answer / grounding).
    { skill: 'research', label: 'RESEARCH-RELEASE', route: 'answer', expect: 'release',
      acceptance: { spec: 'What is the capital of France, and what river runs through it?', sources: 'France is in Western Europe. Its capital is Paris. The river Seine runs through Paris.' } },
    { skill: 'research', label: 'RESEARCH-REFUND', route: 'answer', expect: 'not-release',
      acceptance: { spec: 'What is the population of Tokyo?', sources: 'France is in Western Europe. Its capital is Paris. The river Seine runs through Paris.' } },
    // Data-transform (tool_output / ajv schema).
    { skill: 'data-transform', label: 'DT-RELEASE', route: 'tool_output', expect: 'release',
      acceptance: { spec: 'Extract the person from this text: "Ada Lovelace is a 36-year-old mathematician."', jsonSchema: personSchema(['name', 'age', 'occupation']) } },
    { skill: 'data-transform', label: 'DT-REFUND', route: 'tool_output', expect: 'not-release',
      acceptance: { spec: 'Extract the person from this text: "Ada Lovelace is 36 years old." (occupation is required by the schema but is not stated)', jsonSchema: personSchema(['name', 'age', 'occupation']) } },
    // Code (code / Docker sandbox) — release = fair mode (seller sees the test); refund = informal brief
    // hides the empty-list edge, so a loosely-briefed seller writes sum/len and fails it.
    { skill: 'code', label: 'CODE-RELEASE', route: 'code', expect: 'release',
      acceptance: { spec: 'Implement average(nums): the arithmetic mean of a list; the empty list returns 0.', tests: AVG_TESTS } },
    { skill: 'code', label: 'CODE-REFUND', route: 'code', expect: 'not-release',
      acceptance: { spec: 'internal: average(nums) with empty-list == 0', sellerBrief: 'Write average(nums) that returns the arithmetic mean of a list of numbers.', tests: AVG_TESTS } },
  ];

  const codeReady = dockerUp();
  try {
    for (const sc of scenarios) {
      if (sc.route === 'code' && !codeReady) { console.log(`\n[${sc.label}] SKIPPED — Docker sandbox unavailable (code-route verification is Docker-gated). The seller's code correctness is proven separately by running its output in Python (agents/reference prove-sellers-local.ts).`); continue; }
      await runScenario(sc, transport, sellerBase);
    }
    console.log(`\n✅ GATE C3 proven LIVE on Arc — verified-good → release; bad output → refund/abstain; never a wrongful release.`);
    console.log(`   research + data-transform: full loop live. code: ${codeReady ? 'full loop live' : 'seller proven; sandbox verification Docker-gated (env)'}.`);
  } finally {
    workerServer.close();
    killTree(proc);
  }
  process.exit(0);
}

main().catch((e) => { console.error('REFERENCE LOOP PROOF FAILED:', e); process.exit(1); });
