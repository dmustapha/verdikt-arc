// GATE C3 (deployed) — the FULL production loop through LIVE infrastructure, HTTP only, real money:
//   POST /api/tasks (register acceptance) → fund a REAL Arc escrow → POST /api/jobs (the deployed
//   worker dispatches to the DEPLOYED reference seller) → the seller does the work with a real Claude
//   brain → callbacks the deployed worker → REAL runVerdict → REAL Arc settle. Nothing runs locally
//   except signing the escrow funding. Crucially this exercises the CODE route's Docker sandbox, which
//   runs on the Fly worker (local Docker is degraded).
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/prove-deployed-loop.ts
import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { fundEscrow } from '../settlement/fund-escrow.js';
import { arcTestnet } from '../lib/chains.js';
import type { Acceptance } from '../types.js';

const WORKER = process.env.DEPLOYED_WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const SELLERS = process.env.DEPLOYED_SELLERS_URL ?? 'https://verdikt-reference-sellers.fly.dev';
const SECRET = process.env.DEMO_SHARED_SECRET as string;
const USDC = '0x3600000000000000000000000000000000000000' as const;
const EXPLORER = 'https://testnet.arcscan.app';
const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
const AMOUNT_USDC = 0.05, FEE_USDC = 0.01, BOUNTY = 40000n;
const RUN = Date.now().toString();

const pub = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const bal = async (a: `0x${string}`) => (await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })) as bigint;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Scenario { skill: string; label: string; route: string; acceptance: Acceptance; expect: 'release' | 'not-release'; sellerUrl?: string; protocol?: 'webhook' | 'a2a' | 'x402'; }

async function runScenario(sc: Scenario): Promise<void> {
  const workId = keccak256(stringToHex(`deployed-${sc.label}-${RUN}`));
  const worker = privateKeyToAccount(keccak256(stringToHex(`deployed-w-${sc.label}-${RUN}`))).address;
  const payer = privateKeyToAccount(payerKey).address;

  // 1. Register the task on the deployed worker.
  const reg = await fetch(`${WORKER}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workId, type: sc.route, acceptance: sc.acceptance, payer, seller: worker, amountUsdc: AMOUNT_USDC }),
  });
  if (!reg.ok) throw new Error(`[${sc.label}] /api/tasks ${reg.status}: ${await reg.text()}`);

  // 2. Fund a REAL escrow on Arc (client-side EIP-3009).
  const fundTx = await fundEscrow({ payerKey, workId, worker, amountUsdc: AMOUNT_USDC, feeUsdc: FEE_USDC, ttlSeconds: 604800 });
  console.log(`\n[${sc.label}] (${sc.skill}) funded ${EXPLORER}/tx/${fundTx}`);
  // Let the fund tx propagate to the node the worker reads before it checks FUNDED.
  await sleep(4000);

  // 3. Start the job on the deployed worker (it dispatches to the deployed seller).
  const w0 = await bal(worker), p0 = await bal(payer);
  const sellerUrl = sc.sellerUrl ?? `${SELLERS}/${sc.skill}/dispatch`;
  const protocol = sc.protocol ?? 'webhook';
  const start = await fetch(`${WORKER}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Secret': SECRET },
    body: JSON.stringify({ workId, seller: { url: sellerUrl, protocol } }),
  });
  if (start.status !== 202) throw new Error(`[${sc.label}] /api/jobs ${start.status}: ${await start.text()}`);
  const { jobId } = await start.json() as { jobId: string };

  // 4. Poll the deployed worker for the terminal state (seller Claude work + Docker verdict + settle).
  type JobView = { state: string; outcome: string | null; settleTxHash: string | null };
  let job: JobView | null = null;
  for (let i = 0; i < 90; i++) {
    const r = await fetch(`${WORKER}/api/jobs/${jobId}`);
    if (r.ok) { job = await r.json() as JobView; if (['SETTLED', 'ABSTAINED', 'EXPIRED'].includes(job.state)) break; }
    await sleep(2000);
  }
  const wD = (await bal(worker)) - w0, pD = (await bal(payer)) - p0;
  console.log(`[${sc.label}] job=${job?.state} outcome=${job?.outcome} settle=${EXPLORER}/tx/${job?.settleTxHash}`);
  console.log(`[${sc.label}] worker Δ${wD}  payer Δ${pD}`);

  if (sc.expect === 'release') {
    if (job?.outcome !== 'release') throw new Error(`[${sc.label}] expected release, got ${job?.state}/${job?.outcome}`);
    if (wD !== BOUNTY) throw new Error(`[${sc.label}] worker should receive bounty ${BOUNTY}, got ${wD}`);
    console.log(`[${sc.label}] ✅ RELEASE (deployed): worker paid +${Number(wD) / 1e6} USDC`);
  } else {
    if (job?.outcome === 'release' || wD > 0n) throw new Error(`[${sc.label}] WRONGFUL RELEASE (outcome=${job?.outcome}, wΔ=${wD})`);
    console.log(`[${sc.label}] ✅ ${job?.outcome?.toUpperCase()} (deployed): seller earned nothing; buyer made whole (payer Δ${pD})`);
  }
}

async function main() {
  if (!SECRET) throw new Error('DEMO_SHARED_SECRET required');
  console.log(`GATE C3 DEPLOYED loop — worker ${WORKER}  sellers ${SELLERS}  (${RUN})`);

  const AVG_TESTS = 'from solution import average\n\ndef test_mean():\n    assert average([2, 4, 6]) == 4\n\ndef test_empty():\n    assert average([]) == 0\n';
  const A2A_URL = process.env.A2A_SELLER_URL ?? 'https://verdikt-a2a-research.fly.dev';
  const scenarios: Scenario[] = [
    // Research through the deployed stack (answer / grounding) — proves the full HTTP production loop.
    { skill: 'research', label: 'RESEARCH-RELEASE', route: 'answer', expect: 'release',
      acceptance: { spec: 'What is the capital of France, and what river runs through it?', sources: 'France is in Western Europe. Its capital is Paris. The river Seine runs through Paris.' } },
    // A2A DISPATCH path: the worker's a2aDriver resolves the card at the origin root, message/send's the
    // task, and the keeper polls tasks/get — a standard A2A seller, dispatched live (not just over sockets).
    { skill: 'research', label: 'A2A-RESEARCH-RELEASE', route: 'answer', expect: 'release', sellerUrl: A2A_URL, protocol: 'a2a',
      acceptance: { spec: 'What is the capital of France, and what river runs through it?', sources: 'France is in Western Europe. Its capital is Paris. The river Seine runs through Paris.' } },
    // Code through the deployed stack (code / DOCKER SANDBOX on Fly) — the route local Docker can't run.
    { skill: 'code', label: 'CODE-RELEASE', route: 'code', expect: 'release',
      acceptance: { spec: 'Implement average(nums): the arithmetic mean of a list; the empty list returns 0.', tests: AVG_TESTS } },
    // Refund via a HIDDEN non-obvious convention the loose brief cannot convey: the empty list must
    // return the sentinel -1 (NOT the natural 0). A loosely-briefed seller returns 0 / raises → fails
    // the strict test → refund. (A capable seller writes robust code from a fair brief, so the gap must
    // be a genuine spec quirk, not just "an edge case" — Claude handles obvious edges on its own.)
    { skill: 'code', label: 'CODE-REFUND', route: 'code', expect: 'not-release',
      acceptance: { spec: 'internal spec: average(nums) is the mean; for an EMPTY list it must return the sentinel -1.',
        sellerBrief: 'Write average(nums) that returns the arithmetic mean of a list of numbers.',
        tests: 'from solution import average\n\ndef test_mean():\n    assert average([2, 4, 6]) == 4\n\ndef test_empty_sentinel():\n    assert average([]) == -1\n' } },
  ];

  const only = process.argv[2];
  const selected = only ? scenarios.filter((s) => s.label.includes(only)) : scenarios;
  if (selected.length === 0) throw new Error(`no scenario matches '${only}'`);
  for (const sc of selected) await runScenario(sc);
  console.log('\n✅ GATE C3 proven on LIVE DEPLOYED infrastructure — including the code route Docker sandbox on Fly.');
  process.exit(0);
}

main().catch((e) => { console.error('DEPLOYED LOOP PROOF FAILED:', e); process.exit(1); });
