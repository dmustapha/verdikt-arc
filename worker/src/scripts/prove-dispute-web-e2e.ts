// WS11 review follow-up (c)+(d)+(a) — prove the DISPUTE flow through the WEB PROXY end-to-end, and
// verify the exact data the dispute UI (JobDetail) renders. Unlike prove-dispute-flow.ts (which hits the
// worker directly), this drives the dispute through https://verdikt-arc.vercel.app/api/jobs/:id/dispute
// and reads the web /api/jobs/:id proxy — i.e. the real browser path.
//
// It also HONESTLY attempts an overturn: after the verdict is held, it reads the proposed outcome and
// disputes from the party whose grievance the recorded evidence could support, then reports whether the
// mocked arbiter UPHELD or OVERTURNED. (With the honest reference sellers the engine and arbiter read the
// same evidence and therefore usually AGREE — so an uphold is the expected, truthful result; the overturn
// path is proven deterministically in the unit suites.)
//
// Run from REPO ROOT: set -a; . ./.env; set +a; WORKER_URL=https://verdikt-worker.fly.dev \
//   WEB_URL=https://verdikt-arc.vercel.app npx tsx worker/src/scripts/prove-dispute-web-e2e.ts
import { parseUnits, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { USDC_DOMAIN, RECEIVE_TYPES } from '../settlement/fund-escrow.js';
import { deriveNonce } from '../routes/relayer.js';
import { readEscrowOnChain } from '../settlement/escrow-read.js';

const WORKER = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const WEB = process.env.WEB_URL ?? 'https://verdikt-arc.vercel.app';
const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const SECRET = process.env.DEMO_SHARED_SECRET!;
const humanKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
const SELLER_WALLET = '0x665F4AF29aeeeA93cea97813f69a3ED3eAdEF8fF' as const;
const SELLERS_BASE = 'https://verdikt-reference-sellers.fly.dev';
const LOCAL = { workerDomain: 0, workerRecipient: `0x${'00'.repeat(32)}`, payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}` } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (c: boolean, msg: string) => { if (!c) throw new Error(`ASSERT FAILED: ${msg}`); console.log(`  ✓ ${msg}`); };

// Read the returnable detail through the WEB proxy (exactly what the JobDetail component fetches).
async function webDetail(jobId: string) {
  return await fetch(`${WEB}/api/jobs/${jobId}`, { cache: 'no-store' as RequestCache }).then((x) => x.json()) as {
    state: string; outcome: string | null; disputable?: boolean; challengeDeadline?: string | null;
    verdict?: { verdict: string } | null;
    dispute?: { by: string | null; reason: string | null; arbiterOutcome: string | null; arbiterUpheld: boolean | null; arbiterRationale: string | null; arbiterMock: boolean } | null;
  };
}

async function main() {
  console.log('WS11 e2e — dispute through the WEB proxy + verify the UI data (review follow-up)\n');
  const human = privateKeyToAccount(humanKey);
  const workId = keccak256(stringToHex(`ws11-web-e2e-${Date.now()}`));
  const total = parseUnits('0.06', 6), fee = parseUnits('0.01', 6);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - 600n, validBefore = now + 3600n, ttl = 3600n;
  const acceptance = {
    spec: 'What is Arc’s approximate block time, and how many decimals does USDC use on Arc?',
    sources: 'Arc is an EVM-compatible testnet. Its block time is approximately 0.48 seconds. USDC on Arc is exposed at a predeploy address with 6 decimals.',
  };

  // Fund a disputable job (worker create; the WEB path is exercised for the DISPUTE + reads).
  console.log('1) Fund a disputable job:');
  const t = await fetch(`${WORKER}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workId, type: 'answer', acceptance, payer: human.address, seller: SELLER_WALLET, amountUsdc: 0.06 }) });
  if (!t.ok) throw new Error(`/api/tasks ${t.status}: ${await t.text()}`);
  const nonce = deriveNonce({ workId, worker: SELLER_WALLET, amount: total, fee, ttl, payer: human.address, routes: LOCAL });
  const signature = await human.signTypedData({ domain: USDC_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message: { from: human.address, to: ESCROW, value: total, validAfter, validBefore, nonce } });
  const r = await fetch(`${WORKER}/relayer/fund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payer: human.address, workId, worker: SELLER_WALLET, routes: LOCAL, signature, amount: total.toString(), fee: fee.toString(), ttl: ttl.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString() }) });
  if (!r.ok) throw new Error(`/relayer/fund ${r.status}: ${await r.text()}`);
  const j = await fetch(`${WORKER}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Secret': SECRET }, body: JSON.stringify({ workId, seller: { url: `${SELLERS_BASE}/research/dispatch`, protocol: 'webhook' }, disputable: true, challengeWindowMs: 10 * 60 * 1000 }) });
  const jb = await j.json() as { jobId?: string };
  if (!j.ok || !jb.jobId) throw new Error(`/api/jobs ${j.status}: ${JSON.stringify(jb)}`);
  const jobId = jb.jobId;
  console.log(`  job ${jobId}`);

  // Wait for PROPOSED, reading through the WEB proxy.
  console.log('\n2) The WEB proxy exposes the held verdict + challenge window (what the dispute UI renders):');
  let d = await webDetail(jobId);
  for (let i = 0; i < 60 && d.state !== 'PROPOSED'; i++) {
    if (['SETTLED', 'ABSTAINED', 'EXPIRED', 'RESOLVED'].includes(d.state)) throw new Error(`went terminal (${d.state}) before dispute`);
    await sleep(3000); d = await webDetail(jobId);
  }
  ok(d.state === 'PROPOSED', `web detail shows PROPOSED (${d.state})`);
  ok(d.disputable === true, 'web detail exposes disputable:true (dispute action renders)');
  ok(!!d.challengeDeadline, 'web detail exposes challengeDeadline (countdown renders)');
  const proposed = d.verdict?.verdict ?? '(none)';
  console.log(`  proposed verdict: ${proposed}`);

  // Choose the dispute direction whose grievance the evidence MIGHT support (to give overturn a chance):
  // engine leaning release/partial → the PAYER contests (asks for less); refund/abstain → the WORKER contests.
  const by = (proposed === 'fail' || proposed === 'abstain') ? 'worker' : 'payer';
  console.log(`\n3) Dispute via the WEB proxy as the ${by} (POST ${WEB}/api/jobs/:id/dispute):`);
  const dr = await fetch(`${WEB}/api/jobs/${jobId}/dispute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by, reason: 'Please have the arbiter review this before it settles.' }) });
  const drb = await dr.json() as { resolved: boolean; outcome?: string; upheld?: boolean; rationale?: string; arbiterMock: boolean; reason?: string };
  ok(dr.ok && drb.resolved === true, `web dispute proxy resolved the dispute (HTTP ${dr.status})`);
  ok(drb.arbiterMock === true, 'web dispute response is honestly flagged arbiterMock:true');
  console.log(`  arbiter ${drb.upheld ? 'UPHELD' : 'OVERTURNED'} → ${drb.outcome}`);
  console.log(`  rationale: ${drb.rationale}`);

  // Verify the resolved detail the UI renders, and cross-check on-chain.
  console.log('\n4) The WEB proxy exposes the arbiter ruling (what the ruling panel renders) + chain agrees:');
  d = await webDetail(jobId);
  ok(d.state === 'RESOLVED', `web detail shows RESOLVED (${d.state})`);
  ok(!!d.dispute, 'web detail carries the dispute block (ruling panel has data)');
  ok(d.dispute!.arbiterMock === true, 'the recorded ruling is flagged arbiterMock:true (mock badge renders)');
  ok(!!d.dispute!.arbiterRationale, 'arbiter rationale present (renders in the panel)');
  ok(d.dispute!.arbiterOutcome === drb.outcome, `ruling outcome consistent (${d.dispute!.arbiterOutcome})`);
  const e = await readEscrowOnChain(workId);
  ok(Number(e.status) === 2, 'on-chain escrow SETTLED (status 2), read independently');

  console.log('\n────────────────────────────────────────────────────────');
  console.log('  ✓ WEB dispute path proven e2e; UI data verified; on-chain settled.');
  console.log(`  job ${jobId} · proposed=${proposed} · arbiter=${drb.upheld ? 'upheld' : 'OVERTURNED'} → ${drb.outcome}`);
  if (drb.upheld) console.log('  NOTE: uphold is the expected honest result — the mock arbiter re-reads the SAME');
  console.log('  evidence the engine judged, so it agrees on clean evidence. Overturn is unit-tested.');
  process.exit(0);
}
main().catch((e) => { console.error('\nWEB E2E PROOF FAILED:', e.message); process.exit(1); });
