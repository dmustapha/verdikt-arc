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

  // WS4 — seller registry. A curated (NOT crawled) surface of agents that registered on Verdikt's
  // open standard, accepted deliver-then-settle terms, and passed a live health probe. Only `healthy`
  // rows are listed in the catalog; `status` is re-probed on registration. protocol ∈ webhook|a2a|x402.
  await sql`CREATE TABLE IF NOT EXISTS vk_sellers (
    seller_id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    protocol TEXT NOT NULL,
    capability TEXT NOT NULL,
    wallet TEXT NOT NULL,
    payout_domain INT NOT NULL,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'unhealthy',
    terms_accepted BOOLEAN NOT NULL DEFAULT false,
    last_probe_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS vk_sellers_status_idx ON vk_sellers(status)`;
  // WS7 — catalog acceptance template: { spec, inputLabel } shown per catalog agent so the human
  // buyer supplies ONLY their input and the governing criterion is pre-built. Added via ALTER so
  // existing sellers rows are preserved (nullable — pre-WS7 sellers simply have no template).
  await sql`ALTER TABLE vk_sellers ADD COLUMN IF NOT EXISTS acceptance_template JSONB`;

  // WS6 — ERC-8004 attestation evidence, keyed by requestHash. bundle_json is TEXT (NOT JSONB) on
  // purpose: the served bytes must be byte-identical to what keccak256 hashed into the on-chain
  // responseHash — re-serializing through JSONB would reorder/reformat and break verification.
  // Durable so a validationResponse's on-chain responseURI keeps resolving across worker restarts.
  await sql`CREATE TABLE IF NOT EXISTS vk_erc8004_evidence (
    request_hash TEXT PRIMARY KEY,
    response_hash TEXT NOT NULL,
    bundle_json TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;

  console.log('migrate: schema ready');
}

migrate().catch((e) => { console.error(e); process.exit(1); });
