import { sql } from '@vercel/postgres';

// NOTE: tables are prefixed `vk_` because this Postgres instance is shared with
// solv-001, whose own `tasks` table has an incompatible schema (id PK, different
// columns). Prefixing isolates the verdikt domain so neither project clobbers the
// other. See DEV-003. Keep this prefix in sync with worker/src/lib/db.ts and web/src/lib/db.ts.
async function migrate() {
  await sql`CREATE TABLE IF NOT EXISTS vk_tasks (
    work_id TEXT PRIMARY KEY, type TEXT NOT NULL, payer TEXT NOT NULL, worker TEXT NOT NULL,
    amount_usdc NUMERIC(10,6) NOT NULL, acceptance JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS vk_escrows (
    work_id TEXT PRIMARY KEY REFERENCES vk_tasks(work_id), status TEXT NOT NULL DEFAULT 'funded',
    fund_tx_hash TEXT, settle_tx_hash TEXT, outcome TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS vk_verdicts (
    work_id TEXT PRIMARY KEY REFERENCES vk_tasks(work_id), verdict TEXT NOT NULL, verdict_code INT NOT NULL,
    confidence NUMERIC(4,3), route TEXT NOT NULL, cited_evidence JSONB NOT NULL DEFAULT '[]',
    rationale TEXT, abstain_reason TEXT, evidence_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS vk_evidence (
    work_id TEXT PRIMARY KEY REFERENCES vk_tasks(work_id), bundle JSONB NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS vk_receipts (
    work_id TEXT PRIMARY KEY REFERENCES vk_tasks(work_id), receipt JSONB NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS vk_external_calls (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, work_id TEXT, fee_usdc NUMERIC(10,6),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;

  // WS3 — async job lifecycle. A job is the orchestration record above a funded escrow: dispatched
  // to a seller, awaits async delivery, then verifies + settles. state ∈ job-machine.JOB_STATES.
  await sql`CREATE TABLE IF NOT EXISTS vk_jobs (
    job_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES vk_tasks(work_id),
    state TEXT NOT NULL DEFAULT 'FUNDED',
    seller_url TEXT,
    seller_protocol TEXT NOT NULL DEFAULT 'webhook',
    callback_token TEXT NOT NULL,
    result_ref TEXT,
    deadline TIMESTAMPTZ NOT NULL,
    dispatch_attempts INT NOT NULL DEFAULT 0,
    artifact JSONB,
    outcome TEXT,
    settle_tx_hash TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS vk_jobs_state_idx ON vk_jobs(state)`;

  // Replay defense for signed callbacks: a jti (JWT id / per-task id) may be redeemed once. The PK
  // makes the dedupe atomic — a replayed jti fails the INSERT and is rejected upstream.
  await sql`CREATE TABLE IF NOT EXISTS vk_seen_jti (
    jti TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;

  console.log('migrate: schema ready');
}

migrate().catch((e) => { console.error(e); process.exit(1); });
