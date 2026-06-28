import { sql } from '@vercel/postgres';
import type { EvidenceBundle, Task, VerdictResult, SignedReceipt, Outcome } from '../types.js';

// ── Schema (run via scripts/migrate.ts) ──────────────────────────────────────
// Tables are prefixed `vk_` because this Postgres instance is shared with solv-001,
// whose own `tasks` table has an incompatible schema. See DEV-003 / scripts/migrate.ts.
// CREATE TABLE IF NOT EXISTS vk_tasks (
//   work_id TEXT PRIMARY KEY, type TEXT NOT NULL, payer TEXT NOT NULL, worker TEXT NOT NULL,
//   amount_usdc NUMERIC(10,6) NOT NULL, acceptance JSONB NOT NULL,
//   created_at TIMESTAMPTZ NOT NULL DEFAULT now());
// CREATE TABLE IF NOT EXISTS vk_escrows (
//   work_id TEXT PRIMARY KEY REFERENCES vk_tasks(work_id), status TEXT NOT NULL DEFAULT 'funded',
//   fund_tx_hash TEXT, settle_tx_hash TEXT, outcome TEXT,
//   created_at TIMESTAMPTZ NOT NULL DEFAULT now());
// CREATE TABLE IF NOT EXISTS vk_verdicts (
//   work_id TEXT PRIMARY KEY REFERENCES vk_tasks(work_id), verdict TEXT NOT NULL, verdict_code INT NOT NULL,
//   confidence NUMERIC(4,3), route TEXT NOT NULL, cited_evidence JSONB NOT NULL DEFAULT '[]',
//   rationale TEXT, abstain_reason TEXT, evidence_hash TEXT NOT NULL,
//   created_at TIMESTAMPTZ NOT NULL DEFAULT now());
// CREATE TABLE IF NOT EXISTS vk_evidence (
//   work_id TEXT PRIMARY KEY REFERENCES vk_tasks(work_id), bundle JSONB NOT NULL);
// CREATE TABLE IF NOT EXISTS vk_receipts (
//   work_id TEXT PRIMARY KEY REFERENCES vk_tasks(work_id), receipt JSONB NOT NULL);
// CREATE TABLE IF NOT EXISTS vk_external_calls (
//   id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, work_id TEXT, fee_usdc NUMERIC(10,6),
//   created_at TIMESTAMPTZ NOT NULL DEFAULT now());

export async function insertTask(t: Task): Promise<void> {
  await sql`
    INSERT INTO vk_tasks (work_id, type, payer, worker, amount_usdc, acceptance)
    VALUES (${t.workId}, ${t.type}, ${t.payer}, ${t.worker}, ${t.amountUsdc}, ${JSON.stringify(t.acceptance)})
    ON CONFLICT (work_id) DO NOTHING`;
}

export async function getTask(workId: string): Promise<Task | null> {
  const r = await sql`SELECT * FROM vk_tasks WHERE work_id = ${workId} LIMIT 1`;
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    workId: row.work_id as `0x${string}`,
    type: row.type,
    payer: row.payer as `0x${string}`,
    worker: row.worker as `0x${string}`,
    amountUsdc: parseFloat(row.amount_usdc as string),
    acceptance: row.acceptance,
  };
}

export async function recordFunded(workId: string, fundTxHash: string): Promise<void> {
  await sql`
    INSERT INTO vk_escrows (work_id, status, fund_tx_hash) VALUES (${workId}, 'funded', ${fundTxHash})
    ON CONFLICT (work_id) DO UPDATE SET status = 'funded', fund_tx_hash = ${fundTxHash}`;
}

// H-2 single-shot lock: atomically move an escrow from 'funded' to 'judging'. Returns true ONLY
// for the one caller that wins the transition; a replay or race against an already-judged/settled
// workId updates 0 rows → false → 409 upstream. Stops an attacker from re-judging a funded escrow
// with a crafted artifact during the compute window.
export async function claimForJudging(workId: string): Promise<boolean> {
  const r = await sql`UPDATE vk_escrows SET status = 'judging' WHERE work_id = ${workId} AND status = 'funded'`;
  return r.rowCount === 1;
}

export async function recordEvidence(workId: string, bundle: EvidenceBundle): Promise<void> {
  await sql`
    INSERT INTO vk_evidence (work_id, bundle) VALUES (${workId}, ${JSON.stringify(bundle)})
    ON CONFLICT (work_id) DO UPDATE SET bundle = ${JSON.stringify(bundle)}`;
}

export async function recordVerdict(workId: string, v: VerdictResult): Promise<void> {
  await sql`
    INSERT INTO vk_verdicts (work_id, verdict, verdict_code, confidence, route, cited_evidence, rationale, abstain_reason, evidence_hash)
    VALUES (${workId}, ${v.verdict}, ${v.verdictCode}, ${v.confidence}, ${v.route},
            ${JSON.stringify(v.citedEvidence)}, ${v.rationale}, ${v.abstainReason ?? null}, ${v.evidenceHash})
    ON CONFLICT (work_id) DO UPDATE SET verdict = ${v.verdict}, verdict_code = ${v.verdictCode},
      confidence = ${v.confidence}, route = ${v.route}, cited_evidence = ${JSON.stringify(v.citedEvidence)},
      rationale = ${v.rationale}, abstain_reason = ${v.abstainReason ?? null}, evidence_hash = ${v.evidenceHash}`;
}

export async function recordSettled(workId: string, outcome: Outcome, settleTxHash: string): Promise<void> {
  const r = await sql`UPDATE vk_escrows SET status = 'settled', outcome = ${outcome}, settle_tx_hash = ${settleTxHash} WHERE work_id = ${workId}`;
  // Affected-row guard (debug Phase 8): a 0-row update means an on-chain settle has no
  // matching escrow row — silent chain/DB divergence. Surface it rather than no-op.
  if (r.rowCount === 0) console.error(`[db] recordSettled: no vk_escrows row for ${workId} (tx ${settleTxHash})`);
}

// Mark a settlement that threw before completing, so the row doesn't linger as 'funded'
// and the divergence is queryable (the ledger only surfaces status='settled'). debug Phase 8.
export async function recordSettleFailed(workId: string, errorMsg: string): Promise<void> {
  await sql`UPDATE vk_escrows SET status = 'settle_failed' WHERE work_id = ${workId} AND status != 'settled'`;
  console.error(`[db] settle failed for ${workId}: ${errorMsg}`);
}

export async function recordReceipt(workId: string, receipt: SignedReceipt): Promise<void> {
  await sql`
    INSERT INTO vk_receipts (work_id, receipt) VALUES (${workId}, ${JSON.stringify(receipt)})
    ON CONFLICT (work_id) DO UPDATE SET receipt = ${JSON.stringify(receipt)}`;
}

export async function recordExternalCall(workId: string, feeUsdc: number): Promise<void> {
  await sql`INSERT INTO vk_external_calls (work_id, fee_usdc) VALUES (${workId}, ${feeUsdc})`;
}
