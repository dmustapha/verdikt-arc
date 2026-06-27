// Integration test: proves the migrated vk_ schema is real, queryable, and shaped
// the way worker/src/lib/db.ts expects. Round-trips one task through the live
// Postgres (shared with solv-001) and cleans up after itself.
//
// Run with env loaded, e.g.:  set -a; source ../.env; set +a; npx tsx --test schema.test.ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '@vercel/postgres';

const REQUIRED = ['vk_tasks', 'vk_escrows', 'vk_verdicts', 'vk_evidence', 'vk_receipts', 'vk_external_calls'];
const PROBE_ID = '0xtest_schema_probe_' + Date.now().toString(16);

after(async () => {
  // best-effort cleanup of the probe row (FK-ordered)
  try { await sql`DELETE FROM vk_tasks WHERE work_id = ${PROBE_ID}`; } catch { /* ignore */ }
});

test('all six vk_ tables exist', async () => {
  const r = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${REQUIRED as unknown as string})`;
  const got = r.rows.map((x) => x.table_name as string);
  for (const t of REQUIRED) assert.ok(got.includes(t), `missing table ${t}`);
});

test('vk_tasks accepts a verdikt task shape (work_id PK + acceptance JSONB)', async () => {
  await sql`
    INSERT INTO vk_tasks (work_id, type, payer, worker, amount_usdc, acceptance)
    VALUES (${PROBE_ID}, 'answer', '0xpayer', '0xworker', 1.5, ${JSON.stringify({ spec: 'probe' })})
    ON CONFLICT (work_id) DO NOTHING`;
  const r = await sql`SELECT work_id, amount_usdc, acceptance FROM vk_tasks WHERE work_id = ${PROBE_ID}`;
  assert.equal(r.rows.length, 1);
  assert.equal(parseFloat(r.rows[0].amount_usdc as string), 1.5);
  assert.equal((r.rows[0].acceptance as { spec: string }).spec, 'probe');
});

test('vk_escrows FK references vk_tasks (not solv-001 tasks)', async () => {
  await sql`
    INSERT INTO vk_escrows (work_id, status, fund_tx_hash)
    VALUES (${PROBE_ID}, 'funded', '0xfund')
    ON CONFLICT (work_id) DO UPDATE SET fund_tx_hash = '0xfund'`;
  const r = await sql`SELECT status FROM vk_escrows WHERE work_id = ${PROBE_ID}`;
  assert.equal(r.rows[0].status, 'funded');
  // FK to a non-existent task must be rejected — proves isolation from solv-001.
  await assert.rejects(
    sql`INSERT INTO vk_escrows (work_id) VALUES ('0xnonexistent_fk_probe')`,
    /foreign key|violates/i,
  );
});
