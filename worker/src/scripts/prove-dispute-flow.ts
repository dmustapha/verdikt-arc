// WS11 Gate H1 — prove the DISPUTE/ESCALATION flow end-to-end, LIVE on Arc.
// A disputable job HOLDS its verdict in PROPOSED (funds stay FUNDED on-chain — no money moves), then a
// party contests it; the MOCKED arbiter escalates + rules instantly and settles on-chain; the job lands
// RESOLVED. This proves (Gate H1):
//   (a) escalate → mocked arbiter → a correct on-chain settlement outcome, state transitions persisted;
//   (b) the boundary is honest — every dispute response/detail carries arbiterMock:true;
//   (c) the mock is isolated — the funds are held in the REAL escrow the whole time and settled only by
//       the arbiter's ruling through the same proven settlement wallet (no separate on-chain arbiter).
//
// The arbiter RE-READS the same evidence the engine judged and only overturns when the evidence backs
// the disputer — so a buyer contesting a clean release is (correctly) UPHELD here: the mock is not a
// rubber stamp for whoever shouts. Overturn logic is exhaustively covered by the unit suites
// (arbiter.test.ts / job-engine.test.ts); this script proves the on-chain mechanism.
//
// Run from REPO ROOT: set -a; . ./.env; set +a; WORKER_URL=https://verdikt-worker.fly.dev \
//   npx tsx worker/src/scripts/prove-dispute-flow.ts
import { parseUnits, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { USDC_DOMAIN, RECEIVE_TYPES } from '../settlement/fund-escrow.js';
import { deriveNonce } from '../routes/relayer.js';
import { readEscrowOnChain } from '../settlement/escrow-read.js';

const WORKER = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const SECRET = process.env.DEMO_SHARED_SECRET!;
const humanKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
const SELLER_WALLET = '0x665F4AF29aeeeA93cea97813f69a3ED3eAdEF8fF' as const;
const SELLERS_BASE = 'https://verdikt-reference-sellers.fly.dev';
const LOCAL = { workerDomain: 0, workerRecipient: `0x${'00'.repeat(32)}`, payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}` } as const;
const EXPLORER = 'https://testnet.arcscan.app';
const OUTCOME_LABEL: Record<number, string> = { 0: 'release', 1: 'refund', 2: 'abstain', 3: 'partial', 4: 'expired' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (c: boolean, msg: string) => { if (!c) throw new Error(`ASSERT FAILED: ${msg}`); console.log(`  ✓ ${msg}`); };

async function collectSse(workId: string, ms: number): Promise<{ type: string; data: Record<string, unknown> }[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const events: { type: string; data: Record<string, unknown> }[] = [];
  try {
    const res = await fetch(`${WORKER}/api/stream/${workId}`, { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))); } catch { /* keepalive */ } }
        }
      }
    }
  } catch { /* aborted on timeout — expected */ } finally { clearTimeout(timer); }
  return events;
}

async function detail(jobId: string) {
  return await fetch(`${WORKER}/api/jobs/${jobId}`).then((x) => x.json()) as {
    state: string; outcome: string | null; settleTxHash: string | null; fundTxHash: string | null;
    disputable: boolean; challengeDeadline: string | null;
    dispute: { by: string | null; reason: string | null; arbiterOutcome: string | null; arbiterUpheld: boolean | null; arbiterRationale: string | null; arbiterMock: boolean } | null;
    chain: { status: number; statusLabel: string; outcome: number | null; outcomeLabel: string | null } | null;
  };
}

async function main() {
  console.log('WS11 Gate H1 — dispute / escalation flow, live on Arc\n');
  const human = privateKeyToAccount(humanKey);
  const workId = keccak256(stringToHex(`ws11-dispute-${Date.now()}`));
  const total = parseUnits('0.06', 6), fee = parseUnits('0.01', 6);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - 600n, validBefore = now + 3600n, ttl = 3600n;
  const acceptance = {
    spec: 'What is Arc’s approximate block time, and how many decimals does USDC use on Arc?',
    sources: 'Arc is an EVM-compatible testnet. Its block time is approximately 0.48 seconds. USDC on Arc is exposed at a predeploy address with 6 decimals.',
  };

  // ── 1. Fund a DISPUTABLE job (challenge window wide open so the keeper can't finalize before we dispute) ──
  console.log('1) Fund a disputable escrow + start the held job:');
  const t = await fetch(`${WORKER}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workId, type: 'answer', acceptance, payer: human.address, seller: SELLER_WALLET, amountUsdc: 0.06 }) });
  if (!t.ok) throw new Error(`/api/tasks ${t.status}: ${await t.text()}`);
  const nonce = deriveNonce({ workId, worker: SELLER_WALLET, amount: total, fee, ttl, payer: human.address, routes: LOCAL });
  const signature = await human.signTypedData({ domain: USDC_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message: { from: human.address, to: ESCROW, value: total, validAfter, validBefore, nonce } });
  const r = await fetch(`${WORKER}/relayer/fund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payer: human.address, workId, worker: SELLER_WALLET, routes: LOCAL, signature, amount: total.toString(), fee: fee.toString(), ttl: ttl.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString() }) });
  const rb = await r.json() as { fundTx?: string; error?: string };
  if (!r.ok) throw new Error(`/relayer/fund ${r.status}: ${JSON.stringify(rb)}`);
  const j = await fetch(`${WORKER}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Secret': SECRET }, body: JSON.stringify({ workId, seller: { url: `${SELLERS_BASE}/research/dispatch`, protocol: 'webhook' }, disputable: true, challengeWindowMs: 10 * 60 * 1000 }) });
  const jb = await j.json() as { jobId?: string; error?: string; disputable?: boolean };
  if (!j.ok || !jb.jobId) throw new Error(`/api/jobs ${j.status}: ${JSON.stringify(jb)}`);
  const jobId = jb.jobId;
  ok(jb.disputable === true, 'job created as disputable');
  console.log(`  job ${jobId} · workId ${workId.slice(0, 14)}… · fund ${rb.fundTx?.slice(0, 12)}…`);

  // ── 2. The verdict HOLDS in PROPOSED — funds still FUNDED on-chain, nothing settled ──
  console.log('\n2) The verdict is held in PROPOSED — no money has moved:');
  let d = await detail(jobId);
  for (let i = 0; i < 60 && d.state !== 'PROPOSED'; i++) {
    if (['SETTLED', 'ABSTAINED', 'EXPIRED', 'RESOLVED'].includes(d.state)) throw new Error(`job went terminal (${d.state}) before it could be disputed`);
    await sleep(3000); d = await detail(jobId);
  }
  ok(d.state === 'PROPOSED', `job is held in PROPOSED (${d.state})`);
  ok(!!d.challengeDeadline, 'a challenge window is open (challengeDeadline set)');
  ok(!d.settleTxHash, 'no settlement tx yet — the verdict is only proposed');
  const held = await readEscrowOnChain(workId);
  ok(Number(held.status) === 1, `on-chain escrow is still FUNDED (status 1), read independently — funds held, not moved`);

  // ── 3. A party disputes → escalate → mocked arbiter → settle on-chain → RESOLVED ──
  console.log('\n3) Buyer disputes → escalate → mocked arbiter rules → on-chain settle:');
  const dr = await fetch(`${WORKER}/api/jobs/${jobId}/dispute`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Secret': SECRET }, body: JSON.stringify({ by: 'payer', reason: 'I want the answer re-checked before it is paid out.' }) });
  const drb = await dr.json() as { resolved: boolean; outcome?: string; upheld?: boolean; txHash?: string; rationale?: string; arbiterMock: boolean; reason?: string };
  if (!dr.ok || !drb.resolved) throw new Error(`/dispute ${dr.status}: ${JSON.stringify(drb)}`);
  ok(drb.arbiterMock === true, 'the dispute response is HONESTLY flagged arbiterMock:true');
  ok(!!drb.txHash, 'the arbiter ruling produced a real on-chain settlement tx');
  console.log(`  arbiter ${drb.upheld ? 'UPHELD' : 'OVERTURNED'} the verdict → ${drb.outcome} · settle ${drb.txHash?.slice(0, 12)}…`);
  console.log(`  rationale: ${drb.rationale}`);

  // ── 4. RESOLVED, and the chain agrees ──
  console.log('\n4) Terminal RESOLVED — cross-checked against Arc:');
  d = await detail(jobId);
  ok(d.state === 'RESOLVED', `job is RESOLVED (${d.state})`);
  ok(d.outcome === drb.outcome, `DB outcome === arbiter outcome ("${d.outcome}")`);
  ok(!!d.dispute, 'the dispute block is recorded on the job');
  ok(d.dispute!.by === 'payer', `dispute records who contested (${d.dispute!.by})`);
  ok(d.dispute!.arbiterMock === true, 'the recorded ruling is HONESTLY flagged arbiterMock:true');
  ok(d.dispute!.arbiterUpheld === drb.upheld, 'the recorded upheld/overturned matches the ruling');
  const e = await readEscrowOnChain(workId);
  ok(Number(e.status) === 2, 'on-chain escrow is now SETTLED (status 2), read independently');
  ok(OUTCOME_LABEL[Number(e.outcome)] === d.outcome, `independent chain outcome agrees with the ruling ("${OUTCOME_LABEL[Number(e.outcome)]}")`);

  // ── 5. The lifecycle replays the full dispute path over SSE ──
  console.log('\n5) SSE replays the dispute transitions:');
  const events = await collectSse(workId, 5000);
  const lifecycle = events.filter((ev) => ev.type === 'job_state').map((ev) => ev.data.state as string);
  console.log(`  replayed job_state: ${lifecycle.join(' → ')}`);
  for (const step of ['PROPOSED', 'DISPUTED', 'ESCALATED', 'RESOLVED']) ok(lifecycle.includes(step), `history replays ${step}`);

  console.log('\n────────────────────────────────────────────────────────');
  console.log('  ✓ GATE H1 PROVEN — dispute → escalate → mocked arbiter → on-chain settle → RESOLVED.');
  console.log(`  job:      ${jobId}`);
  console.log(`  workId:   ${workId}`);
  console.log(`  ruling:   ${drb.outcome} (${drb.upheld ? 'upheld' : 'overturned'}, arbiter=mock)`);
  console.log(`  fund tx:  ${EXPLORER}/tx/${d.fundTxHash}`);
  console.log(`  settle:   ${EXPLORER}/tx/${d.settleTxHash}`);
  console.log(`  escrow:   ${EXPLORER}/address/${ESCROW}`);
  process.exit(0);
}
main().catch((e) => { console.error('\nDISPUTE FLOW PROOF FAILED:', e.message); process.exit(1); });
