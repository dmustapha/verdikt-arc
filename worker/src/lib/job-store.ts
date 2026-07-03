import { sql } from '@vercel/postgres';
import type { Artifact, Outcome, SellerBrief } from '../types.js';
import { outcomeToState } from './job-machine.js';
import type { JobState } from './job-machine.js';

// DB layer for the WS3 async job lifecycle (schema in scripts/migrate.ts: vk_jobs + vk_seen_jti).
// Every state change is an ATOMIC conditional UPDATE guarded on the allowed prior state — the same
// single-shot pattern as db.claimForJudging — so a duplicate delivery or a race can never re-run a
// step or forge an illegal transition. rowCount === 1 means this caller won the transition.

export type SellerProtocol = 'webhook' | 'a2a' | 'x402';

export interface JobRow {
  jobId: string;
  workId: `0x${string}`;
  state: JobState;
  sellerUrl: string | null;
  sellerProtocol: SellerProtocol;
  callbackToken: string;
  resultRef: string | null;
  deadline: Date;
  dispatchAttempts: number;
  artifact: Artifact | null;
  outcome: Outcome | null;
  settleTxHash: string | null;
  lastError: string | null;
  // Seller-facing brief (Option C). Resolved in-memory at dispatch (dispatch is one-shot) and attached
  // to the job the transport dispatches — NOT a DB column, so it is absent on rows read back from the
  // store. Transports include it in the envelope when present.
  brief?: SellerBrief | null;
}

interface JobDbRow {
  job_id: string; work_id: string; state: string; seller_url: string | null;
  seller_protocol: string; callback_token: string; result_ref: string | null;
  deadline: string | Date; dispatch_attempts: number; artifact: Artifact | null;
  outcome: string | null; settle_tx_hash: string | null; last_error: string | null;
}

function toRow(r: JobDbRow): JobRow {
  return {
    jobId: r.job_id,
    workId: r.work_id as `0x${string}`,
    state: r.state as JobState,
    sellerUrl: r.seller_url,
    sellerProtocol: r.seller_protocol as SellerProtocol,
    callbackToken: r.callback_token,
    resultRef: r.result_ref,
    deadline: new Date(r.deadline),
    dispatchAttempts: r.dispatch_attempts,
    artifact: r.artifact,
    outcome: r.outcome as Outcome | null,
    settleTxHash: r.settle_tx_hash,
    lastError: r.last_error,
  };
}

export async function createJob(input: {
  jobId: string;
  workId: `0x${string}`;
  sellerUrl: string | null;
  sellerProtocol: SellerProtocol;
  callbackToken: string;
  resultRef: string | null;
  deadline: Date;
}): Promise<void> {
  await sql`
    INSERT INTO vk_jobs (job_id, work_id, state, seller_url, seller_protocol, callback_token, result_ref, deadline)
    VALUES (${input.jobId}, ${input.workId}, 'FUNDED', ${input.sellerUrl}, ${input.sellerProtocol},
            ${input.callbackToken}, ${input.resultRef}, ${input.deadline.toISOString()})
    ON CONFLICT (job_id) DO NOTHING`;
}

export async function getJob(jobId: string): Promise<JobRow | null> {
  const r = await sql`SELECT * FROM vk_jobs WHERE job_id = ${jobId} LIMIT 1`;
  return r.rows.length ? toRow(r.rows[0] as JobDbRow) : null;
}

export async function getJobByWorkId(workId: string): Promise<JobRow | null> {
  const r = await sql`SELECT * FROM vk_jobs WHERE work_id = ${workId} ORDER BY created_at DESC LIMIT 1`;
  return r.rows.length ? toRow(r.rows[0] as JobDbRow) : null;
}

// WS8 dashboard: every job a given buyer funded, newest first. Joins vk_jobs to vk_tasks on the payer
// (the escrow payer, public on-chain — so this leaks nothing). Case-insensitive on the address. Bounded
// so a payer with a huge history can't force an unbounded scan. Read-only; never fabricates a job.
export async function listByPayer(payer: string): Promise<JobRow[]> {
  const r = await sql`
    SELECT j.* FROM vk_jobs j
    JOIN vk_tasks t ON t.work_id = j.work_id
    WHERE lower(t.payer) = lower(${payer})
    ORDER BY j.created_at DESC
    LIMIT 100`;
  return r.rows.map((row) => toRow(row as JobDbRow));
}

export async function listByState(states: JobState[]): Promise<JobRow[]> {
  // pg array literal for = ANY(...): '{A,B}'
  const arr = `{${states.join(',')}}`;
  const r = await sql`SELECT * FROM vk_jobs WHERE state = ANY(${arr}::text[]) ORDER BY created_at ASC`;
  return r.rows.map((row) => toRow(row as JobDbRow));
}

// ── Atomic transitions (rowCount===1 ⇔ this caller won) ──────────────────────

export async function markDispatched(jobId: string): Promise<boolean> {
  const r = await sql`UPDATE vk_jobs SET state = 'DISPATCHED', updated_at = now() WHERE job_id = ${jobId} AND state = 'FUNDED'`;
  return r.rowCount === 1;
}

export async function markAwaiting(jobId: string): Promise<boolean> {
  const r = await sql`UPDATE vk_jobs SET state = 'AWAITING_DELIVERY', updated_at = now() WHERE job_id = ${jobId} AND state = 'DISPATCHED'`;
  return r.rowCount === 1;
}

// Single-shot delivery lock: only the FIRST callback/poll for a pre-delivery job wins and stores the
// artifact. FUNDED is accepted because a very fast token-authed callback can beat the DISPATCHED write
// (the token proves the seller was dispatched to). A duplicate delivery updates 0 rows → false →
// idempotent no-op upstream.
export async function claimDelivery(jobId: string, artifact: Artifact): Promise<boolean> {
  const r = await sql`
    UPDATE vk_jobs SET state = 'DELIVERED', artifact = ${JSON.stringify(artifact)}, updated_at = now()
    WHERE job_id = ${jobId} AND state IN ('FUNDED', 'DISPATCHED', 'AWAITING_DELIVERY')`;
  return r.rowCount === 1;
}

export async function markVerifying(jobId: string): Promise<boolean> {
  const r = await sql`UPDATE vk_jobs SET state = 'VERIFYING', updated_at = now() WHERE job_id = ${jobId} AND state = 'DELIVERED'`;
  return r.rowCount === 1;
}

// Terminal settle: a definitive verdict → SETTLED, an abstain → ABSTAINED (label decides, WS2).
export async function markSettled(jobId: string, outcome: Outcome, settleTxHash: string): Promise<boolean> {
  const target = outcomeToState(outcome);
  const r = await sql`
    UPDATE vk_jobs SET state = ${target}, outcome = ${outcome}, settle_tx_hash = ${settleTxHash}, updated_at = now()
    WHERE job_id = ${jobId} AND state = 'VERIFYING'`;
  return r.rowCount === 1;
}

// No-show / keeper expiry: reachable from ANY non-terminal state; refuses once the job is terminal so
// funds are never refunded after a settle.
export async function markExpired(jobId: string, settleTxHash: string): Promise<boolean> {
  const r = await sql`
    UPDATE vk_jobs SET state = 'EXPIRED', outcome = 'refund', settle_tx_hash = ${settleTxHash}, updated_at = now()
    WHERE job_id = ${jobId} AND state NOT IN ('SETTLED', 'ABSTAINED', 'EXPIRED')`;
  return r.rowCount === 1;
}

// Persist the seller-assigned result reference discovered at dispatch (A2A task id / x402 job URL) so
// the keeper's poll and the callback re-fetch can resolve the authoritative artifact after a worker
// restart. Set-once (WHERE result_ref IS NULL) so a late re-dispatch can't clobber a live reference.
export async function setResultRef(jobId: string, ref: string): Promise<void> {
  await sql`UPDATE vk_jobs SET result_ref = ${ref}, updated_at = now() WHERE job_id = ${jobId} AND result_ref IS NULL`;
}

export async function recordDispatchAttempt(jobId: string, error?: string): Promise<void> {
  await sql`
    UPDATE vk_jobs SET dispatch_attempts = dispatch_attempts + 1, last_error = ${error ?? null}, updated_at = now()
    WHERE job_id = ${jobId}`;
}

export async function recordJobError(jobId: string, error: string): Promise<void> {
  await sql`UPDATE vk_jobs SET last_error = ${error}, updated_at = now() WHERE job_id = ${jobId}`;
}

// Atomic jti dedupe, SCOPED PER-JOB. The stored key is `${jobId}::${jti}` so two independent sellers
// that reuse a non-globally-unique jti value (e.g. a per-seller counter) don't collide — each job has
// its own replay namespace. This never weakens cross-job protection: a callback is also gated by the
// per-job callback token, so a jti lifted from job A is rejected at job B on the token check regardless.
// Composite key in the existing TEXT PK avoids a schema migration. INSERT wins once; a replay → 0 rows.
export async function recordSeenJti(jti: string, jobId: string): Promise<boolean> {
  const key = `${jobId}::${jti}`;
  const r = await sql`INSERT INTO vk_seen_jti (jti, job_id) VALUES (${key}, ${jobId}) ON CONFLICT (jti) DO NOTHING`;
  return r.rowCount === 1;
}
