import { sql } from '@vercel/postgres';
import type { LedgerRow } from '../types';

export async function getLedger(limit = 50): Promise<LedgerRow[]> {
  const r = await sql`
    SELECT t.work_id, t.type, t.amount_usdc, v.verdict, v.cited_evidence, v.evidence_hash,
           e.outcome, e.settle_tx_hash, t.created_at
    FROM vk_tasks t
    JOIN vk_verdicts v ON v.work_id = t.work_id
    JOIN vk_escrows e ON e.work_id = t.work_id
    WHERE e.status = 'settled'
    ORDER BY t.created_at DESC LIMIT ${limit}`;
  return r.rows.map((row) => ({
    workId: row.work_id,
    type: row.type,
    verdict: row.verdict,
    outcome: row.outcome,
    amountUsdc: parseFloat(row.amount_usdc),
    evidenceHash: row.evidence_hash,
    txHash: row.settle_tx_hash,
    citedEvidence: row.cited_evidence ?? [],
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function getEvidenceBundle(workId: string): Promise<unknown | null> {
  const r = await sql`SELECT bundle FROM vk_evidence WHERE work_id = ${workId} LIMIT 1`;
  return r.rows[0]?.bundle ?? null;
}

export async function getExternalCallCount(): Promise<number> {
  const r = await sql`SELECT COUNT(*)::int AS cnt FROM vk_external_calls`;
  return r.rows[0]?.cnt ?? 0;
}

// Honest Gateway counter (C13 fix): the SUM of REAL settled x402 fees, not count × an assumed
// price. Each row is one metered /api/verdict call; demo runs are unmetered and insert no rows, so
// every row here is a genuine third-party paid call.
export async function getExternalFeeSum(): Promise<{ count: number; sumUsdc: number }> {
  const r = await sql`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(fee_usdc), 0)::float8 AS total FROM vk_external_calls`;
  return { count: r.rows[0]?.cnt ?? 0, sumUsdc: r.rows[0]?.total ?? 0 };
}
