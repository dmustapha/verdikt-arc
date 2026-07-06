// WS12b — FULL-SCOPE exercise of Verdikt's verdict engine against the LIVE worker.
//
// WHY THIS EXISTS: the two live ACP jobs (live-job.ts) only touched ONE of Verdikt's five verdict
// routes — `tool_output` (deterministic JSON-Schema validation) — plus ACP's on-chain settlement.
// That proves the wiring, not the brain. This script exercises the WHOLE brain: every route, each
// with a deliverable that SHOULD pass and one that SHOULD NOT, so you can see the task issued, the
// result delivered, and exactly how Verdikt graded it.
//
// It hits the same public seam the ACP evaluator uses — POST /api/evaluate — which renders a pure
// verdict and settles NOTHING. No escrow, no USDC, no gas. Running the full app's grading costs $0.
//
// Run:  npx tsx agents/acp-evaluator/src/full-scope-test.ts
//       WORKER_URL=https://verdikt-worker.fly.dev  (default)

const WORKER = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';

// A real, mined Arc-testnet settle tx (receipt present, status success). Its actual recipient is
// 0x4e1a4238… — the execution route reads the live receipt and checks the claim against it.
const ARC_CHAIN_ID = 5042002;
const REAL_ARC_TX = '0x6da4a716383dbbf081fc2d529c02e607bede4a2050a81f3f76fff27a867bdd19';
const REAL_ARC_TO = '0x4e1a423815294dfd1903d849d4be84e3391ea771';
const FAKE_TX = '0x' + 'de'.repeat(32); // well-formed but never mined → no receipt

interface Case {
  route: string;
  label: string;
  expect: 'approve' | 'deny'; // approve = pass/partial; deny = fail/abstain
  task: string; // human summary of what the buyer asked for (the acceptance ground truth)
  deliverable: string; // human summary of what the seller submitted
  body: Record<string, unknown>;
}

// The JSON-Schema contract reused by the tool_output cases (mirrors the ACP job's risk schema).
const RISK_SCHEMA = {
  type: 'object',
  required: ['ticker', 'riskScore', 'rating'],
  properties: {
    ticker: { type: 'string' },
    riskScore: { type: 'integer', minimum: 0, maximum: 100 },
    rating: { enum: ['low', 'medium', 'high'] },
  },
  additionalProperties: false,
};
const TRACE_SCHEMA = {
  type: 'object',
  required: ['tool', 'args'],
  properties: { tool: { type: 'string' }, args: { type: 'object' } },
  additionalProperties: false,
};
const SOURCES = 'Verdikt renders verdicts over agent deliverables and settles the outcome on the Arc testnet using USDC as the settlement asset.';

const CASES: Case[] = [
  // 1. CODE — payer ships a pytest suite; Verdikt runs it in a sandbox against the seller's solution.
  {
    route: 'code', label: 'correct implementation', expect: 'approve',
    task: 'pytest: add(2,3) must equal 5', deliverable: 'def add(a,b): return a+b',
    body: { route: 'code', acceptance: { tests: 'from solution import add\ndef test_add():\n    assert add(2,3)==5\n' }, artifact: { language: 'python', payload: 'def add(a,b):\n    return a+b\n' } },
  },
  {
    route: 'code', label: 'buggy implementation', expect: 'deny',
    task: 'pytest: add(2,3) must equal 5', deliverable: 'def add(a,b): return a-b  # wrong',
    body: { route: 'code', acceptance: { tests: 'from solution import add\ndef test_add():\n    assert add(2,3)==5\n' }, artifact: { language: 'python', payload: 'def add(a,b):\n    return a-b\n' } },
  },
  // 2. TOOL_OUTPUT — the exact route the ACP jobs used: JSON validated against a declared schema.
  {
    route: 'tool_output', label: 'schema-valid JSON', expect: 'approve',
    task: 'risk schema: riskScore 0-100 int, rating in {low,medium,high}', deliverable: '{"ticker":"VIRTUAL","riskScore":27,"rating":"low"}',
    body: { route: 'tool_output', acceptance: { jsonSchema: RISK_SCHEMA }, artifact: { payload: '{"ticker":"VIRTUAL","riskScore":27,"rating":"low"}' } },
  },
  {
    route: 'tool_output', label: 'out-of-range + bad enum', expect: 'deny',
    task: 'risk schema: riskScore 0-100 int, rating in {low,medium,high}', deliverable: '{"ticker":"VIRTUAL","riskScore":250,"rating":"catastrophic"}',
    body: { route: 'tool_output', acceptance: { jsonSchema: RISK_SCHEMA }, artifact: { payload: '{"ticker":"VIRTUAL","riskScore":250,"rating":"catastrophic"}' } },
  },
  // 3. ANSWER — the claim must be grounded in a verbatim, substantive span of the payer's sources.
  {
    route: 'answer', label: 'grounded in sources', expect: 'approve',
    task: `answer grounded in: "${SOURCES.slice(0, 48)}…"`, deliverable: 'It settles the outcome on the Arc testnet using USDC as the settlement asset.',
    body: { route: 'answer', acceptance: { sources: SOURCES }, artifact: { payload: 'How does Verdikt settle? It settles the outcome on the Arc testnet using USDC as the settlement asset.' } },
  },
  {
    route: 'answer', label: 'ungrounded / hallucinated', expect: 'deny',
    task: `answer grounded in: "${SOURCES.slice(0, 48)}…"`, deliverable: 'Arc settles trades in Bitcoin on chain id 1.',
    body: { route: 'answer', acceptance: { sources: SOURCES }, artifact: { payload: 'Arc settles trades in Bitcoin on chain id 1.' } },
  },
  // 4. EXECUTION — payload is a tx hash; Verdikt reads the LIVE receipt and checks it against the claim.
  {
    route: 'execution', label: 'real Arc tx, criteria match', expect: 'approve',
    task: `Arc tx to ${REAL_ARC_TO.slice(0, 10)}… with status=success`, deliverable: `${REAL_ARC_TX.slice(0, 12)}… (real, mined)`,
    body: { route: 'execution', acceptance: { execution: { chainId: ARC_CHAIN_ID, status: 'success', to: REAL_ARC_TO } }, artifact: { payload: REAL_ARC_TX } },
  },
  {
    route: 'execution', label: 'fabricated tx, no receipt', expect: 'deny',
    task: 'Arc tx with status=success', deliverable: `${FAKE_TX.slice(0, 12)}… (never mined)`,
    body: { route: 'execution', acceptance: { execution: { chainId: ARC_CHAIN_ID, status: 'success' } }, artifact: { payload: FAKE_TX } },
  },
  // 5. TOOL_TRACE — each recorded tool call must conform to the declared per-call JSON Schema.
  {
    route: 'tool_trace', label: 'trace conforms to schema', expect: 'approve',
    task: 'each call: {tool:string, args:object}, no extras', deliverable: '[{tool:getPrice,args:{…}},{tool:getRisk,args:{…}}]',
    body: { route: 'tool_trace', acceptance: { toolTrace: { perCall: true, jsonSchema: TRACE_SCHEMA } }, artifact: { payload: '[{"tool":"getPrice","args":{"sym":"VIRTUAL"}},{"tool":"getRisk","args":{"sym":"VIRTUAL"}}]' } },
  },
  {
    route: 'tool_trace', label: 'missing field + rogue prop', expect: 'deny',
    task: 'each call: {tool:string, args:object}, no extras', deliverable: '[{tool:getPrice} /*no args*/,{…,rogue:true}]',
    body: { route: 'tool_trace', acceptance: { toolTrace: { perCall: true, jsonSchema: TRACE_SCHEMA } }, artifact: { payload: '[{"tool":"getPrice"},{"tool":"getRisk","args":{},"rogue":true}]' } },
  },
];

interface Verdict {
  verdict: string; approve: boolean; score: number; confidence: number; rationale: string;
  evidence?: { id: string; status: string; detail: string }[];
}

async function evaluate(body: Record<string, unknown>): Promise<Verdict> {
  const res = await fetch(`${WORKER}/api/evaluate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${res.status}: ${(d as { error?: string }).error ?? 'error'}`);
  return d as unknown as Verdict;
}

async function main(): Promise<void> {
  console.log(`\nVerdikt FULL-SCOPE verdict test — live engine at ${WORKER}/api/evaluate`);
  console.log('Five routes × {should-pass, should-fail}. No escrow, no USDC, no gas — pure verdicts.\n');

  let ok = 0;
  const rows: string[] = [];
  for (const c of CASES) {
    process.stdout.write(`▸ ${c.route.padEnd(12)} ${c.label.padEnd(28)} `);
    let v: Verdict;
    try {
      v = await evaluate(c.body);
    } catch (e) {
      console.log(`ERROR ${e instanceof Error ? e.message : e}`);
      rows.push(`| ${c.route} | ${c.label} | ${c.expect} | ERROR |`);
      continue;
    }
    const granted = v.approve; // pass/partial → true; fail/abstain → false
    const correct = c.expect === 'approve' ? granted : !granted;
    if (correct) ok++;
    console.log(`→ ${v.verdict.toUpperCase().padEnd(8)} approve=${granted} score=${v.score} conf=${v.confidence}  ${correct ? '✅' : '❌ UNEXPECTED'}`);
    console.log(`    task:   ${c.task}`);
    console.log(`    submit: ${c.deliverable}`);
    console.log(`    grade:  ${(v.rationale || '').slice(0, 180)}`);
    for (const it of v.evidence ?? []) console.log(`      · [${it.status}] ${it.id}: ${(it.detail || '').slice(0, 120)}`);
    console.log('');
    rows.push(`| ${c.route} | ${c.label} | ${c.expect} | ${v.verdict} (score ${v.score}) | ${correct ? '✓' : '✗'} |`);
  }

  console.log('── Markdown summary (for proof.md) ────────────────────────────────────');
  console.log('| Route | Case | Expected | Verdikt graded | Match |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) console.log(r);
  console.log(`\n${ok}/${CASES.length} cases graded as expected.`);
  process.exit(ok === CASES.length ? 0 : 1);
}

main().catch((e) => { console.error('[full-scope-test] fatal:', e instanceof Error ? e.message : e); process.exit(1); });
