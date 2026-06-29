import { PayerAgent } from './payer-agent.js';
import { SellerAgent, type SellerStyle } from './seller-agent.js';

// Orchestrates a real agent-to-agent transaction on Arc: a payer agent reasons out criteria + escrows
// USDC + signs an offer; a seller agent reasons out + generates the deliverable + submits. The verdict
// engine settles. Nothing here is a fixture — the criteria AND the deliverable are LLM-generated.

const ENDPOINT = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const WEB = process.env.WEB_URL ?? 'https://verdikt-arc-damilolas-projects-fafdf859.vercel.app';
const RPC = process.env.ARC_RPC_URL;
const EXPLORER = 'https://testnet.arcscan.app/tx/';
const AMOUNT = Number(process.env.AGENTS_AMOUNT_USDC ?? 0.1);

const PAYER_KEY = (process.env.DEMO_PAYER_KEY ?? '').trim() as `0x${string}`;
const SELLER_KEY = (process.env.WORKER_GATEWAY_KEY ?? '').trim() as `0x${string}`;

interface Scenario {
  title: string; goal: string; style: SellerStyle; expect: string; fixedSources?: string;
  // Optional TERSER brief handed to the seller instead of the payer's full one. Models the real gap
  // between an informal ask and strict acceptance tests: the seller builds to the terse ask and the
  // hidden edge-case test still governs the money. Honest — the brief genuinely omits what the test enforces.
  sellerBrief?: string;
}

const SCENARIOS: Scenario[] = [
  {
    title: 'RELEASE — good work, paid',
    goal: 'I need a Python function `build_sum(a, b)` that returns the sum of two numbers. Test it with a couple of cases including negatives.',
    style: 'diligent',
    expect: 'release (tests pass, scan clean → seller paid)',
  },
  {
    title: 'REFUND — work fails the spec, money back',
    goal: 'I need a Python function `average(nums)` that returns the arithmetic mean of a list of numbers. CRITICAL EDGE CASE: for an empty list it MUST return 0.0, it must NOT raise. Provide a pytest that imports `solution` and asserts both a normal case AND that `average([]) == 0.0`.',
    // The seller is briefed informally (no edge case mentioned) — the strict empty-list test still governs payment.
    sellerBrief: 'Write a Python function `average(nums)` in solution.py that returns the arithmetic mean of a list of numbers.',
    style: 'hasty',
    expect: 'refund (empty-list test fails on the naive sum/len → payer refunded)',
  },
  {
    title: 'ABSTAIN — unverifiable, money back',
    goal: 'I need an answer to: "What consensus mechanism does Arc use, and what is its native gas token?" The answer must be grounded in my sources.',
    fixedSources: 'Arc is an EVM-compatible testnet. Its block time is approximately 0.48 seconds. Transactions are denominated in USDC.',
    style: 'diligent',
    expect: 'abstain (answer not grounded in the provided sources → payer refunded)',
  },
];

function link(tx: string | null | undefined): string { return tx ? `${EXPLORER}${tx}` : '(none)'; }
const line = (s = '') => console.log(s);

async function runScenario(payer: PayerAgent, seller: SellerAgent, s: Scenario, i: number) {
  line(`\n━━━ Scenario ${i + 1}: ${s.title} ━━━`);
  line(`  goal: ${s.goal}`);

  line('  · payer agent reasoning out acceptance criteria + escrowing on Arc…');
  const c = await payer.commission(s.goal, seller.address, AMOUNT, s.fixedSources);
  line(`    route=${c.route}  workId=${c.workId.slice(0, 12)}…  escrow funded: ${link(c.escrowTx)}`);
  line(`    seller brief: ${c.sellerBrief.replace(/\s+/g, ' ').slice(0, 140)}…`);

  // Watch this exact run live in the UI (the courtroom subscribes read-only to the agent's workId).
  line(`    watch live: ${WEB}/courtroom?workId=${c.workId}`);

  const briefForSeller = s.sellerBrief ?? c.sellerBrief;
  line(`  · seller agent (${s.style}) generating the deliverable + submitting…`);
  const seen = new Set<string>();
  const onStep = (st: { type: string; data: Record<string, unknown> }) => {
    if (st.type === 'route_selected') line(`      ⟶ arbiter route: ${st.data.route}`);
    else if (st.type === 'evidence_item') { const d = st.data as { label?: string; status?: string }; line(`      ⟶ evidence: ${d.label} → ${String(d.status).toUpperCase()}`); }
    else if (st.type === 'verdict' && !seen.has('v')) { seen.add('v'); line(`      ⟶ verdict: ${String(st.data.verdict).toUpperCase()}`); }
    else if (st.type === 'settled' && !seen.has('s')) { seen.add('s'); line(`      ⟶ settled: ${st.data.outcome}`); }
  };
  const { delivery, result } = await seller.fulfill(c.offer, c.route, briefForSeller, s.style, onStep);
  if (delivery.note) line(`    seller note: ${delivery.note.replace(/\s+/g, ' ').slice(0, 120)}`);
  line(`    deliverable (head): ${delivery.payload.replace(/\n/g, ' ⏎ ').slice(0, 120)}…`);

  line(`  → VERDICT: ${result.verdict.toUpperCase()}  OUTCOME: ${result.status.toUpperCase()}  fee: ${result.feeUsdc} USDC`);
  line(`    settled on Arc: ${link(result.settlementTx)}`);
  line(`    expected: ${s.expect}`);
  return { scenario: s.title, verdict: result.verdict, outcome: result.status, settlementTx: result.settlementTx };
}

async function main() {
  if (!PAYER_KEY || !SELLER_KEY) throw new Error('DEMO_PAYER_KEY and WORKER_GATEWAY_KEY required in env');
  const only = process.argv[2]; // optional: "release" | "refund" | "abstain"
  const payer = new PayerAgent(ENDPOINT, RPC, PAYER_KEY);
  const seller = new SellerAgent(ENDPOINT, RPC, SELLER_KEY);

  line(`Verdikt agents → ${ENDPOINT}`);
  line(`  payer  ${payer.address}`);
  line(`  seller ${seller.address}`);
  line('  · seller onboarding onto Circle Gateway (idempotent)…');
  const ob = await seller.onboard();
  line(`    onboarded=${ob.onboarded} deposited=${ob.deposited} available=${ob.availableUsdc} USDC${ob.depositTxHash ? ` (deposit ${link(ob.depositTxHash)})` : ''}`);

  const chosen = only ? SCENARIOS.filter((s) => s.title.toLowerCase().startsWith(only.toLowerCase())) : SCENARIOS;
  const results = [];
  for (let i = 0; i < chosen.length; i++) results.push(await runScenario(payer, seller, chosen[i], i));

  line('\n━━━ Summary ━━━');
  for (const r of results) line(`  ${r.outcome.padEnd(9)} ${r.verdict.padEnd(7)} ${r.scenario}  ${link(r.settlementTx)}`);
}

main().then(() => line('\n[agents done]')).catch((e) => { console.error('\n[agents FATAL]', e); process.exit(1); });
