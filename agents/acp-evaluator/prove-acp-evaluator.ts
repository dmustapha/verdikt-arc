// WS12 Gate I1 (mock-adapter proof) — prove Verdikt's ACP evaluator LOGIC end-to-end against an
// ACP-shaped mock, using the REAL live verdict engine. Simulates two `job.submitted` events (a good and
// a bad structured-data deliverable) and asserts the evaluator calls session.complete() vs reject()
// correctly, driven by Verdikt's actual verdict. The real AcpJobSession is swapped in acp-client.ts;
// this proves the decision + the live /api/evaluate call without needing a live buyer/seller.
//
// Run: set -a; . agents/acp-evaluator/.env; set +a; npx tsx agents/acp-evaluator/prove-acp-evaluator.ts
import { evaluateSubmitted } from './src/judge.js';
import type { EvalSession } from './src/judge.js';

const ok = (c: boolean, msg: string) => { if (!c) throw new Error(`ASSERT FAILED: ${msg}`); console.log(`  ✓ ${msg}`); };

// A mock ACP session recording which terminal action the evaluator took.
function mockSession(): EvalSession & { action: string | null; note: string | null } {
  const s = {
    action: null as string | null, note: null as string | null,
    async complete(reason: string) { s.action = 'complete'; s.note = reason; },
    async reject(reason: string) { s.action = 'reject'; s.note = reason; },
  };
  return s;
}

// The concrete structured-data service Verdikt evaluates: a user-profile JSON contract.
const jsonSchema = {
  type: 'object',
  required: ['name', 'age', 'email'],
  properties: {
    name: { type: 'string', minLength: 1 },
    age: { type: 'integer', minimum: 0 },
    email: { type: 'string', format: 'email' },
  },
  additionalProperties: false,
};

async function main() {
  console.log('WS12 Gate I1 (mock adapter) — Verdikt ACP evaluator over a live verdict\n');

  console.log('1) A GOOD deliverable (valid JSON per the schema) → evaluator COMPLETES:');
  const good = mockSession();
  const goodDeliverable = JSON.stringify({ name: 'Ada Lovelace', age: 36, email: 'ada@example.com' });
  const r1 = await evaluateSubmitted({ deliverable: goodDeliverable, jsonSchema }, good);
  console.log(`  Verdikt verdict=${r1.verdict} approve=${r1.approve} → session.${good.action}`);
  ok(r1.approve === true, 'Verdikt approved the valid deliverable');
  ok(good.action === 'complete', 'evaluator called session.complete()');

  console.log('\n2) A BAD deliverable (missing required + wrong type) → evaluator REJECTS:');
  const bad = mockSession();
  const badDeliverable = JSON.stringify({ name: '', age: 'thirty' }); // empty name, age not integer, no email
  const r2 = await evaluateSubmitted({ deliverable: badDeliverable, jsonSchema }, bad);
  console.log(`  Verdikt verdict=${r2.verdict} approve=${r2.approve} → session.${bad.action}`);
  ok(r2.approve === false, 'Verdikt did NOT approve the invalid deliverable');
  ok(bad.action === 'reject', 'evaluator called session.reject()');

  console.log('\n3) A MISSING deliverable → evaluator REJECTS (no false approval):');
  const empty = mockSession();
  const r3 = await evaluateSubmitted({ deliverable: null, jsonSchema }, empty);
  ok(r3.approve === false && empty.action === 'reject', 'missing deliverable rejected');

  console.log('\n────────────────────────────────────────────────────────');
  console.log('  ✓ Verdikt ACP evaluator proven against an ACP-shaped mock, over the LIVE verdict engine.');
  console.log('  Good→complete, bad→reject, missing→reject. Real /api/evaluate rendered each verdict.');
  console.log(`  evidence anchors: good ${r1.evidenceHash.slice(0, 14)}… · bad ${r2.evidenceHash.slice(0, 14)}…`);
  process.exit(0);
}
main().catch((e) => { console.error('\nACP EVALUATOR PROOF FAILED:', e.message); process.exit(1); });
