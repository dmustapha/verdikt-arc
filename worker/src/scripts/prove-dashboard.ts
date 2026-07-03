// WS8 Gate E2 — prove the async job DASHBOARD is returnable and TRUTHFUL, live.
// Runs one real human-path job to a terminal state, then — as a returning buyer would — proves:
//   1. LEAVE-AND-RETURN (detail): a fresh GET /api/jobs/:id shows the correct terminal state, and its
//      DB outcome === the independent on-chain escrow outcome (read straight from Arc). No optimistic lie.
//   2. LIST-BY-PAYER: GET /api/jobs?payer= lists the job for the funding wallet (source of truth).
//   3. SSE LEAVE-AND-RETURN: a FRESH SSE subscription (opened AFTER settlement) replays the full
//      job_state lifecycle from history — exactly what a dashboard opened late reconstructs from.
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/prove-dashboard.ts
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
const TERMINAL = new Set(['SETTLED', 'ABSTAINED', 'EXPIRED']);
const OUTCOME_LABEL: Record<number, string> = { 0: 'release', 1: 'refund', 2: 'abstain', 3: 'partial', 4: 'expired' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (c: boolean, msg: string) => { if (!c) throw new Error(`ASSERT FAILED: ${msg}`); console.log(`  ✓ ${msg}`); };

// Minimal SSE reader over fetch: collect events for `ms`, then abort. Returns every parsed event.
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
          if (line.startsWith('data: ')) {
            try { events.push(JSON.parse(line.slice(6))); } catch { /* comment/keepalive */ }
          }
        }
      }
    }
  } catch { /* aborted on timeout — expected */ } finally { clearTimeout(timer); }
  return events;
}

async function main() {
  console.log('WS8 Gate E2 — returnable, truthful async job dashboard\n');
  const human = privateKeyToAccount(humanKey);
  const workId = keccak256(stringToHex(`ws8-dash-${Date.now()}`));
  const total = parseUnits('0.06', 6), fee = parseUnits('0.01', 6);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - 600n, validBefore = now + 3600n, ttl = 3600n;
  const acceptance = {
    spec: 'What is Arc’s approximate block time, and how many decimals does USDC use on Arc?',
    sources: 'Arc is an EVM-compatible testnet. Its block time is approximately 0.48 seconds. USDC on Arc is exposed at a predeploy address with 6 decimals.',
  };

  // ── Fund + dispatch one real job (the human path) ─────────────────────────
  const t = await fetch(`${WORKER}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workId, type: 'answer', acceptance, payer: human.address, seller: SELLER_WALLET, amountUsdc: 0.06 }) });
  if (!t.ok) throw new Error(`/api/tasks ${t.status}: ${await t.text()}`);
  const nonce = deriveNonce({ workId, worker: SELLER_WALLET, amount: total, fee, ttl, payer: human.address, routes: LOCAL });
  const signature = await human.signTypedData({ domain: USDC_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message: { from: human.address, to: ESCROW, value: total, validAfter, validBefore, nonce } });
  const r = await fetch(`${WORKER}/relayer/fund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payer: human.address, workId, worker: SELLER_WALLET, routes: LOCAL, signature, amount: total.toString(), fee: fee.toString(), ttl: ttl.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString() }) });
  const rb = await r.json() as { fundTx?: string; error?: string };
  if (!r.ok) throw new Error(`/relayer/fund ${r.status}: ${JSON.stringify(rb)}`);
  const j = await fetch(`${WORKER}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Secret': SECRET }, body: JSON.stringify({ workId, seller: { url: `${SELLERS_BASE}/research/dispatch`, protocol: 'webhook' } }) });
  const jb = await j.json() as { jobId?: string; error?: string };
  if (!j.ok || !jb.jobId) throw new Error(`/api/jobs ${j.status}: ${JSON.stringify(jb)}`);
  const jobId = jb.jobId;
  console.log(`  job ${jobId} · workId ${workId.slice(0, 14)}… · gasless fund ${rb.fundTx?.slice(0, 12)}…`);

  // Wait for a terminal state (poll the detail endpoint, as the dashboard does).
  let state = 'FUNDED';
  for (let i = 0; i < 50; i++) {
    await sleep(3000);
    const s = await fetch(`${WORKER}/api/jobs/${jobId}`).then((x) => x.json()) as { state: string };
    if (s.state !== state) { state = s.state; process.stdout.write(` ${state}`); }
    if (TERMINAL.has(state)) break;
  }
  process.stdout.write('\n\n');
  ok(TERMINAL.has(state), `job reached a terminal state (${state})`);

  // ── 1. LEAVE-AND-RETURN (detail truth-vs-chain) ───────────────────────────
  console.log('1) Leave-and-return — fresh detail fetch, cross-checked against Arc:');
  const d = await fetch(`${WORKER}/api/jobs/${jobId}`).then((x) => x.json()) as {
    state: string; outcome: string | null; fundTxHash: string | null; settleTxHash: string | null;
    verdict: unknown | null;
    chain: { status: number; statusLabel: string; outcome: number | null; outcomeLabel: string | null; amountUsdc: string; feeUsdc: string } | null;
  };
  ok(d.state === state, `detail state matches (${d.state})`);
  ok(!!d.chain, 'detail carries an independent on-chain escrow read');
  ok(d.chain!.statusLabel === 'SETTLED', `chain status = SETTLED (${d.chain!.statusLabel})`);
  ok(d.outcome === d.chain!.outcomeLabel, `DB outcome === chain outcome ("${d.outcome}" == "${d.chain!.outcomeLabel}")`);
  ok(!!d.fundTxHash && !!d.settleTxHash, 'per-job proof links present (fund + settle tx)');
  ok(!!d.verdict, 'recorded verdict present for the result view');

  // Independent read straight from the chain — the ultimate source of truth — must agree with the API.
  const e = await readEscrowOnChain(workId);
  const chainOutcome = OUTCOME_LABEL[Number(e.outcome)];
  ok(Number(e.status) === 2, `on-chain escrow status = SETTLED (2), read independently`);
  ok(chainOutcome === d.outcome, `independent chain read agrees with the dashboard ("${chainOutcome}")`);

  // ── 2. LIST-BY-PAYER ──────────────────────────────────────────────────────
  console.log('\n2) List-by-payer — the returnable job list:');
  const list = await fetch(`${WORKER}/api/jobs?payer=${human.address}`).then((x) => x.json()) as { jobs: { jobId: string; state: string; outcome: string | null }[] };
  const mine = list.jobs.find((x) => x.jobId === jobId);
  ok(!!mine, `job appears in the payer's list (${list.jobs.length} total)`);
  ok(mine!.state === state && mine!.outcome === d.outcome, `list row matches terminal state + outcome`);

  // ── 3. SSE LEAVE-AND-RETURN (fresh subscribe replays the lifecycle) ────────
  console.log('\n3) SSE leave-and-return — a fresh subscription replays the full lifecycle:');
  const events = await collectSse(workId, 5000);
  const lifecycle = events.filter((ev) => ev.type === 'job_state').map((ev) => ev.data.state as string);
  console.log(`  replayed job_state: ${lifecycle.join(' → ')}`);
  for (const step of ['FUNDED', 'DELIVERED', 'VERIFYING', state]) {
    ok(lifecycle.includes(step), `history replays ${step}`);
  }

  console.log('\n────────────────────────────────────────────────────────');
  console.log('  ✓ GATE E2 PROVEN — returnable, real-time, truthful-vs-chain.');
  console.log(`  job:      ${jobId}`);
  console.log(`  workId:   ${workId}`);
  console.log(`  fund tx:  ${EXPLORER}/tx/${d.fundTxHash}`);
  console.log(`  settle:   ${EXPLORER}/tx/${d.settleTxHash}`);
  console.log(`  escrow:   ${EXPLORER}/address/${ESCROW}`);
  console.log(`  outcome:  ${d.outcome} (chain-confirmed)`);
  process.exit(0);
}
main().catch((e) => { console.error('\nDASHBOARD PROOF FAILED:', e.message); process.exit(1); });
