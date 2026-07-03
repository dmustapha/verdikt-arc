import { sql } from '@vercel/postgres';
import type { Artifact, Outcome, SellerBrief } from '../types.js';
import { outcomeToState } from './job-machine.js';
import type { JobState } from './job-machine.js';
import type { DisputeParty, ArbiterOutcome } from './arbiter.js';

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
  // WS11 — dispute/escalation fields. `disputable` opts the job into the challenge-window path;
  // challengeWindowMs is the window length (null ⇒ engine default); challengeDeadline is when it closes
  // (set on PROPOSED). disputedBy/disputeReason record the contest; arbiter* record the mocked ruling.
  // Optional on the type (nullable/defaulted at the DB layer): toRow always populates them for a real
  // store row, and the engine treats an absent `disputable` as false — the safe non-disputable default.
  disputable?: boolean;
  challengeWindowMs?: number | null;
  challengeDeadline?: Date | null;
  disputedBy?: DisputeParty | null;
  disputeReason?: string | null;
  arbiterOutcome?: ArbiterOutcome | null;
  arbiterUpheld?: boolean | null;
  arbiterRationale?: string | null;
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
  disputable: boolean | null; challenge_window_ms: number | null; challenge_deadline: string | Date | null;
  disputed_by: string | null; dispute_reason: string | null;
  arbiter_outcome: string | null; arbiter_upheld: boolean | null; arbiter_rationale: string | null;
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
    disputable: r.disputable ?? false,
    challengeWindowMs: r.challenge_window_ms ?? null,
    challengeDeadline: r.challenge_deadline ? new Date(r.challenge_deadline) : null,
    disputedBy: (r.disputed_by as DisputeParty | null) ?? null,
    disputeReason: r.dispute_reason ?? null,
    arbiterOutcome: (r.arbiter_outcome as ArbiterOutcome | null) ?? null,
    arbiterUpheld: r.arbiter_upheld ?? null,
    arbiterRationale: r.arbiter_rationale ?? null,
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
  disputable?: boolean;
  challengeWindowMs?: number | null;
}): Promise<void> {
  await sql`
    INSERT INTO vk_jobs (job_id, work_id, state, seller_url, seller_protocol, callback_token, result_ref,
                         deadline, disputable, challenge_window_ms)
    VALUES (${input.jobId}, ${input.workId}, 'FUNDED', ${input.sellerUrl}, ${input.sellerProtocol},
            ${input.callbackToken}, ${input.resultRef}, ${input.deadline.toISOString()},
            ${input.disputable ?? false}, ${input.challengeWindowMs ?? null})
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

// ── WS11 dispute/escalation transitions (all atomic, single-shot: rowCount===1 ⇔ this caller won) ──

// Hold settlement: a disputable job's verdict has been computed → PROPOSED, opening the challenge
// window (challenge_deadline). Funds stay FUNDED on-chain. Only a VERIFYING job can be held.
export async function markProposed(jobId: string, challengeDeadline: Date): Promise<boolean> {
  const r = await sql`
    UPDATE vk_jobs SET state = 'PROPOSED', challenge_deadline = ${challengeDeadline.toISOString()}, updated_at = now()
    WHERE job_id = ${jobId} AND state = 'VERIFYING'`;
  return r.rowCount === 1;
}

// Undisputed finalize: the challenge window closed with no dispute → settle the proposed verdict, landing
// SETTLED (definitive) or ABSTAINED (abstain), same terminal mapping as the direct path. Only from PROPOSED.
export async function finalizeProposed(jobId: string, outcome: Outcome, settleTxHash: string): Promise<boolean> {
  const target = outcomeToState(outcome);
  const r = await sql`
    UPDATE vk_jobs SET state = ${target}, outcome = ${outcome}, settle_tx_hash = ${settleTxHash}, updated_at = now()
    WHERE job_id = ${jobId} AND state = 'PROPOSED'`;
  return r.rowCount === 1;
}

// Open a dispute: a party contests the proposed verdict in-window → DISPUTED. Single-shot on PROPOSED, so
// only the FIRST dispute wins (a second contest updates 0 rows → idempotent no-op).
export async function openDispute(jobId: string, by: DisputeParty, reason: string): Promise<boolean> {
  const r = await sql`
    UPDATE vk_jobs SET state = 'DISPUTED', disputed_by = ${by}, dispute_reason = ${reason}, updated_at = now()
    WHERE job_id = ${jobId} AND state = 'PROPOSED'`;
  return r.rowCount === 1;
}

// Hand the dispute to the arbiter → ESCALATED. Only from DISPUTED.
export async function markEscalated(jobId: string): Promise<boolean> {
  const r = await sql`UPDATE vk_jobs SET state = 'ESCALATED', updated_at = now() WHERE job_id = ${jobId} AND state = 'DISPUTED'`;
  return r.rowCount === 1;
}

// Terminal resolve: the arbiter's ruling settled on-chain → RESOLVED. Records the money outcome plus the
// arbiter's before/after (upheld) and rationale for an honest audit trail. Only from ESCALATED.
export async function markResolved(
  jobId: string,
  outcome: ArbiterOutcome,
  upheld: boolean,
  rationale: string,
  settleTxHash: string,
): Promise<boolean> {
  const r = await sql`
    UPDATE vk_jobs SET state = 'RESOLVED', outcome = ${outcome}, arbiter_outcome = ${outcome},
      arbiter_upheld = ${upheld}, arbiter_rationale = ${rationale}, settle_tx_hash = ${settleTxHash}, updated_at = now()
    WHERE job_id = ${jobId} AND state = 'ESCALATED'`;
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
