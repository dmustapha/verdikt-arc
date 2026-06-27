// Phase 3 integration: the /proof counter reads vk_external_calls, and the x402
// meter is the only thing that writes it (via verdict route → recordExternalCall
// with res.locals.feeUsdc). This proves a metered verdict call increments that
// table by exactly one row carrying the fee. We exercise the db boundary
// recordExternalCall directly (the meter's downstream effect) against the real
// shared Postgres, with FK-safe setup/teardown.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@vercel/postgres';
import { recordExternalCall, insertTask } from '../../src/lib/db.js';
import { VERDICT_FEE_USDC } from '../../src/lib/x402-meter.js';
import type { Task } from '../../src/types.js';

const WORK_ID = ('0x' + 'ec'.repeat(16)) as `0x${string}`; // 32-byte probe id

const probeTask: Task = {
  workId: WORK_ID,
  type: 'answer',
  acceptance: { spec: 'external-call probe' },
  payer: '0xpayer',
  worker: '0xworker',
  amountUsdc: 1,
};

async function callCount(): Promise<number> {
  const r = await sql`SELECT COUNT(*)::int AS n FROM vk_external_calls WHERE work_id = ${WORK_ID}`;
  return r.rows[0].n as number;
}

describe('x402-meter → vk_external_calls', () => {
  beforeAll(async () => {
    // FK: vk_external_calls.work_id is loose, but insert the task so the row is realistic.
    await insertTask(probeTask);
    await sql`DELETE FROM vk_external_calls WHERE work_id = ${WORK_ID}`;
  });

  afterAll(async () => {
    await sql`DELETE FROM vk_external_calls WHERE work_id = ${WORK_ID}`;
    await sql`DELETE FROM vk_tasks WHERE work_id = ${WORK_ID}`;
  });

  it('the metered fee constant is sub-cent and positive', () => {
    expect(VERDICT_FEE_USDC).toBeGreaterThan(0);
    expect(VERDICT_FEE_USDC).toBeLessThan(0.01);
  });

  it('recordExternalCall (what the verdict route runs after settle) inserts exactly one row with the fee', async () => {
    const before = await callCount();
    await recordExternalCall(WORK_ID, VERDICT_FEE_USDC);
    const after = await callCount();
    expect(after).toBe(before + 1);

    const r = await sql`SELECT fee_usdc FROM vk_external_calls WHERE work_id = ${WORK_ID} ORDER BY created_at DESC LIMIT 1`;
    expect(parseFloat(r.rows[0].fee_usdc as string)).toBeCloseTo(VERDICT_FEE_USDC, 6);
  });

  it('a second metered call increments the counter again (the /proof counter is cumulative)', async () => {
    const before = await callCount();
    await recordExternalCall(WORK_ID, VERDICT_FEE_USDC);
    expect(await callCount()).toBe(before + 1);
  });
});
