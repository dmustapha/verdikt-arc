import type { Artifact, Outcome, Task, VerdictResult, EvidenceBundle } from '../types.js';
import type { JobRow, SellerProtocol } from './job-store.js';
import type { SellerTransport } from './transport.js';
import type { Delivery } from '../routes/callback.js';
import type { VerdictRunResult } from '../engine/orchestrator.js';
import type { ArbiterRuling, DisputeParty, ArbiterOutcome } from './arbiter.js';
import { isTerminal, outcomeToState } from './job-machine.js';
import type { JobState } from './job-machine.js';
import { dispatchWithRetry } from './dispatcher.js';
import { buildSellerBrief } from './seller-brief.js';

// Default challenge window for a disputable job (overridable per-job or via the engine dep). Kept short
// so the demo resolves quickly; it MUST be well under the escrow's on-chain TTL so an undisputed job
// finalizes before the no-show clock could expire it.
const DEFAULT_CHALLENGE_WINDOW_MS = 5 * 60 * 1000;

// The WS3 job engine: the ONE place that drives a funded escrow through the async lifecycle
// (dispatch → await delivery → verify → settle) and the no-show path (expire → refundExpired). Every
// external effect — the store, the seller transport, the verdict engine, the on-chain refund, the
// clock — is injected, so the whole lifecycle is unit-testable with no DB/network/wallet, and Gate C1
// exercises the SAME code with a real DB + mock seller harness.

// The store surface the engine needs (the real job-store implements all of these).
export interface JobStore {
  createJob(input: {
    jobId: string; workId: `0x${string}`; sellerUrl: string | null; sellerProtocol: SellerProtocol;
    callbackToken: string; resultRef: string | null; deadline: Date;
    disputable?: boolean; challengeWindowMs?: number | null;
  }): Promise<void>;
  getJob(jobId: string): Promise<JobRow | null>;
  markDispatched(jobId: string): Promise<boolean>;
  markAwaiting(jobId: string): Promise<boolean>;
  claimDelivery(jobId: string, artifact: Artifact): Promise<boolean>;
  markVerifying(jobId: string): Promise<boolean>;
  markSettled(jobId: string, outcome: Outcome, settleTxHash: string): Promise<boolean>;
  markExpired(jobId: string, settleTxHash: string): Promise<boolean>;
  recordDispatchAttempt(jobId: string, error?: string): Promise<void>;
  recordJobError(jobId: string, error: string): Promise<void>;
  listByState(states: JobRow['state'][]): Promise<JobRow[]>;
  // WS11 dispute transitions — optional so the engine stays constructible without the dispute wiring
  // (a job is only disputable when the production engine-instance provides all of these).
  markProposed?(jobId: string, challengeDeadline: Date): Promise<boolean>;
  finalizeProposed?(jobId: string, outcome: Outcome, settleTxHash: string): Promise<boolean>;
  openDispute?(jobId: string, by: DisputeParty, reason: string): Promise<boolean>;
  markEscalated?(jobId: string): Promise<boolean>;
  markResolved?(jobId: string, outcome: ArbiterOutcome, upheld: boolean, rationale: string, settleTxHash: string): Promise<boolean>;
}

export interface EngineDeps {
  store: JobStore;
  transport: SellerTransport;
  verify(task: Task, artifact: Artifact): Promise<VerdictRunResult>;   // default: orchestrator.runVerdict
  getTask(workId: string): Promise<Task | null>;
  refundExpiredOnChain(workId: `0x${string}`): Promise<string>;        // default: settlement/expire
  now(): number;
  dispatch: { maxAttempts: number; baseDelayMs: number; sleep(ms: number): Promise<void> };
  // WS8: fire-and-forget SSE hook, called ONLY on a won transition (never a lost race). Optional so the
  // engine stays pure in unit tests; the production wiring publishes 'job_state' on the sseBus. It must
  // never throw — a broken stream can never stall the money path — so every call is wrapped below.
  emit?(workId: `0x${string}`, state: JobState): void;
  // ── WS11 dispute path (all optional — a disputable job requires all of these to be wired) ──
  // Compute a verdict WITHOUT settling (default: orchestrator.computeVerdict) — used to HOLD a
  // disputable job's verdict in PROPOSED. Settle a GIVEN verdict (default: settleGivenVerdict) — used to
  // settle both an undisputed finalize and the arbiter's ruling through the one proven money path.
  propose?(task: Task, artifact: Artifact): Promise<{ verdict: VerdictResult; bundle: EvidenceBundle }>;
  settleGiven?(task: Task, verdict: VerdictResult): Promise<VerdictRunResult>;
  getProposedVerdict?(workId: string): Promise<VerdictResult | null>; // the held verdict, for finalize/dispute
  getEvidence?(workId: string): Promise<EvidenceBundle | null>;       // the arbiter's factual basis
  arbitrate?(input: { workId: `0x${string}`; proposed: VerdictResult; evidence: EvidenceBundle; dispute: { by: DisputeParty; reason: string } }): ArbiterRuling;
  challengeWindowMs?: number;                                          // default DEFAULT_CHALLENGE_WINDOW_MS
}

export interface CreateJobInput {
  jobId: string;
  workId: `0x${string}`;
  sellerUrl: string | null;
  sellerProtocol: SellerProtocol;
  callbackToken: string;
  resultRef: string | null;
  deadline: Date;
  disputable?: boolean;
  challengeWindowMs?: number | null;
}

export interface DisputeResult {
  resolved: boolean;
  reason?: string;
  txHash?: string;
  outcome?: ArbiterOutcome;
  upheld?: boolean;
  rationale?: string;
}

export interface FinalizeResult {
  finalized: boolean;
  reason?: string;
  txHash?: string;
  outcome?: string;
}

export interface JobEngine {
  startJob(input: CreateJobInput): Promise<JobRow | null>;
  onDelivery(job: JobRow, delivery: Delivery): Promise<void>;
  expireJob(jobId: string): Promise<{ expired: boolean; reason?: string; txHash?: string }>;
  // WS11: a party contests a PROPOSED verdict in-window → escalate → mocked arbiter → settle → RESOLVED.
  disputeJob(jobId: string, by: DisputeParty, reason: string): Promise<DisputeResult>;
  // WS11: the challenge window closed undisputed → settle the held verdict (SETTLED/ABSTAINED).
  finalizeProposedJob(jobId: string): Promise<FinalizeResult>;
}

export function makeEngine(deps: EngineDeps): JobEngine {
  const { store, transport, verify, getTask, refundExpiredOnChain, now } = deps;

  // Safe emit: swallow any error so a broken SSE bus can NEVER interrupt the lifecycle / money path.
  const emit = (workId: `0x${string}`, state: JobState) => {
    try { deps.emit?.(workId, state); } catch { /* SSE is best-effort, off the money path */ }
  };

  async function startJob(input: CreateJobInput): Promise<JobRow | null> {
    await store.createJob(input);
    const job = await store.getJob(input.jobId);
    if (!job) return null;
    emit(input.workId, 'FUNDED'); // the job exists and is escrowed; the dashboard's first live state

    // Resolve the seller-facing brief (Option C) in-memory and attach it to the job we dispatch, so the
    // transport can carry it in the envelope. Dispatch is one-shot (the keeper only polls/expires, never
    // re-dispatches), so the brief needs no persistence. A missing task ⇒ no brief (the seller is only a
    // reference agent that needs it; a bare dispatch still works for a canned seller).
    const task = await getTask(job.workId);
    const jobForDispatch = task ? { ...job, brief: buildSellerBrief(task) } : job;

    const ok = await dispatchWithRetry(jobForDispatch, transport, {
      recordDispatchAttempt: store.recordDispatchAttempt,
      sleep: deps.dispatch.sleep,
      maxAttempts: deps.dispatch.maxAttempts,
      baseDelayMs: deps.dispatch.baseDelayMs,
    });

    if (ok) {
      if (await store.markDispatched(input.jobId)) emit(input.workId, 'DISPATCHED');
      if (await store.markAwaiting(input.jobId)) emit(input.workId, 'AWAITING_DELIVERY');
    } else {
      // Dispatch exhausted — the job stays FUNDED (funds locked). The keeper refunds the buyer via
      // refundExpired at the deadline; funds are never stranded.
      await store.recordJobError(input.jobId, 'dispatch exhausted — seller unreachable');
    }
    return store.getJob(input.jobId);
  }

  async function onDelivery(job: JobRow, delivery: Delivery): Promise<void> {
    // No-show cutoff, enforced at the single choke point so it holds for EVERY transport (a webhook
    // callback and a poll both flow through here). Past the deadline the buyer is entitled to a refund;
    // a late delivery is declined and the keeper's expiry refunds them. Without this, a webhook that
    // beat the keeper could still settle while a polled delivery (pollOnce skips past-deadline jobs)
    // would not — transport-dependent behavior. The FUNDED-once contract remains the definitive guard
    // for the residual race where the deadline lapses mid-verify.
    if (now() >= job.deadline.getTime()) {
      await store.recordJobError(job.jobId, 'delivery arrived after the deadline — deferring to no-show expiry');
      return;
    }

    // Resolve the AUTHORITATIVE artifact. webhook: inline (already validated at the callback).
    // a2a: re-fetch from the registered seller (the push was only a nudge). null ⇒ not ready → the
    // poller/keeper will retry; we leave the job untouched.
    const artifact: Artifact | null =
      'artifact' in delivery ? delivery.artifact : await transport.fetchResult(job, delivery.resultRef);
    if (!artifact) {
      await store.recordJobError(job.jobId, 'delivery produced no authoritative artifact');
      return;
    }

    // Single-shot delivery lock — a duplicate callback/poll loses the race and no-ops (idempotent).
    if (!(await store.claimDelivery(job.jobId, artifact))) return;
    emit(job.workId, 'DELIVERED');
    if (await store.markVerifying(job.jobId)) emit(job.workId, 'VERIFYING');

    const task = await getTask(job.workId);
    if (!task) { await store.recordJobError(job.jobId, 'task row missing for delivered job'); return; }

    // WS11 HOLD: a disputable, fully-wired job computes its verdict but does NOT settle — it parks in
    // PROPOSED and opens a challenge window so a party can contest before any money moves (funds stay
    // FUNDED on-chain). The keeper finalizes it undisputed once the window closes. If the dispute deps
    // are absent (an unwired engine), we fall through to the normal settle so funds are never stranded.
    if (job.disputable && deps.propose && store.markProposed) {
      await deps.propose(task, artifact); // records evidence + verdict + streams the courtroom, no settle
      const windowMs = job.challengeWindowMs ?? deps.challengeWindowMs ?? DEFAULT_CHALLENGE_WINDOW_MS;
      const challengeDeadline = new Date(now() + windowMs);
      if (await store.markProposed(job.jobId, challengeDeadline)) emit(job.workId, 'PROPOSED');
      return;
    }

    // Verify → settle. runVerdict is escrow-gated and idempotent at the chain (FUNDED-once), so this
    // is the money path. A definitive verdict settles; abstain refunds+ABSTAINED; a settle that never
    // confirms leaves the job non-terminal for the keeper to expire at the deadline.
    const result = await verify(task, artifact);
    if (result.txHash) {
      if (await store.markSettled(job.jobId, result.outcome as Outcome, result.txHash)) {
        emit(job.workId, outcomeToState(result.outcome as Outcome)); // SETTLED or ABSTAINED per the label
      }
      // NOTE: the post-settle ERC-8004 attestation fires inside verify() (orchestrator.runVerdict) —
      // the single chokepoint both this async path and the sync /verdict route settle through — so it
      // is NOT re-fired here. It is fire-and-forget and off the money path by construction.
    } else {
      await store.recordJobError(job.jobId, result.error ?? 'settlement did not confirm');
    }
  }

  async function expireJob(jobId: string): Promise<{ expired: boolean; reason?: string; txHash?: string }> {
    const job = await store.getJob(jobId);
    if (!job) return { expired: false, reason: 'unknown job' };
    if (isTerminal(job.state)) return { expired: false, reason: `already ${job.state.toLowerCase()}` };
    if (now() < job.deadline.getTime()) return { expired: false, reason: 'before deadline' };

    // The on-chain escrow is FUNDED-once: refundExpired reverts if a settle already fired, so the
    // contract is the definitive no-double-settle guard. The job-level terminal check above just
    // avoids doomed txs. refundExpired refunds the buyer via their route.
    const txHash = await refundExpiredOnChain(job.workId);
    const ok = await store.markExpired(jobId, txHash);
    if (ok) emit(job.workId, 'EXPIRED'); // no-show refund landed; dashboard shows the terminal truth
    return { expired: ok, txHash, reason: ok ? undefined : 'raced to terminal' };
  }

  // WS11 — a party contests a PROPOSED verdict in-window. The whole path is synchronous and instant
  // (the arbiter is a mocked, deterministic module): DISPUTED → ESCALATED → arbiter rules → settle the
  // ruling on-chain (same proven money path) → RESOLVED. Every step is a single-shot store transition,
  // so a concurrent dispute/finalize race can never double-act. If any step fails after ESCALATED, the
  // job stays non-terminal and the escrow deadline's no-show refund is the backstop (funds never stuck).
  async function disputeJob(jobId: string, by: DisputeParty, reason: string): Promise<DisputeResult> {
    if (!deps.arbitrate || !deps.getEvidence || !deps.getProposedVerdict || !deps.settleGiven
        || !store.openDispute || !store.markEscalated || !store.markResolved) {
      return { resolved: false, reason: 'dispute engine not wired' };
    }
    const job = await store.getJob(jobId);
    if (!job) return { resolved: false, reason: 'unknown job' };
    if (job.state !== 'PROPOSED') return { resolved: false, reason: `job is not open to dispute (state=${job.state})` };
    if (now() >= (job.challengeDeadline?.getTime() ?? 0)) return { resolved: false, reason: 'challenge window has closed' };

    // 1. Open the dispute (single-shot on PROPOSED — a second contest loses the race and no-ops).
    if (!(await store.openDispute(jobId, by, reason))) return { resolved: false, reason: 'already disputed or window closed' };
    emit(job.workId, 'DISPUTED');

    // 2. Escalate to the arbiter.
    if (!(await store.markEscalated(jobId))) return { resolved: false, reason: 'raced past DISPUTED' };
    emit(job.workId, 'ESCALATED');

    // 3. Gather the arbiter's factual basis (task + held verdict + the evidence it was judged on).
    const [task, proposed, evidence] = await Promise.all([
      getTask(job.workId), deps.getProposedVerdict(job.workId), deps.getEvidence(job.workId),
    ]);
    if (!task || !proposed || !evidence) {
      await store.recordJobError(jobId, 'dispute basis missing (task/proposed-verdict/evidence)');
      return { resolved: false, reason: 'dispute basis missing' };
    }

    // 4. Rule (pure, deterministic mock) and settle the ruling on-chain through the one money path.
    const ruling = deps.arbitrate({ workId: job.workId, proposed, evidence, dispute: { by, reason } });
    const result = await deps.settleGiven(task, ruling.verdict);
    if (!result.txHash) {
      await store.recordJobError(jobId, result.error ?? 'arbiter settlement did not confirm');
      return { resolved: false, reason: result.error ?? 'settlement did not confirm' };
    }

    // 5. Terminal RESOLVED — records the money outcome + the arbiter's before/after + rationale.
    const ok = await store.markResolved(jobId, ruling.outcome, ruling.upheld, ruling.rationale, result.txHash);
    if (ok) emit(job.workId, 'RESOLVED');
    return { resolved: ok, txHash: result.txHash, outcome: ruling.outcome, upheld: ruling.upheld, rationale: ruling.rationale };
  }

  // WS11 — the challenge window closed with no dispute: settle the held (proposed) verdict exactly as the
  // direct path would have, landing SETTLED/ABSTAINED. Only acts on a PROPOSED job past its window.
  async function finalizeProposedJob(jobId: string): Promise<FinalizeResult> {
    if (!deps.getProposedVerdict || !deps.settleGiven || !store.finalizeProposed) {
      return { finalized: false, reason: 'dispute engine not wired' };
    }
    const job = await store.getJob(jobId);
    if (!job) return { finalized: false, reason: 'unknown job' };
    if (job.state !== 'PROPOSED') return { finalized: false, reason: `not proposed (state=${job.state})` };
    if (now() < (job.challengeDeadline?.getTime() ?? Number.POSITIVE_INFINITY)) return { finalized: false, reason: 'challenge window still open' };

    const task = await getTask(job.workId);
    if (!task) { await store.recordJobError(jobId, 'task row missing for proposed job'); return { finalized: false, reason: 'task missing' }; }
    const verdict = await deps.getProposedVerdict(job.workId);
    if (!verdict) { await store.recordJobError(jobId, 'held verdict missing for proposed job'); return { finalized: false, reason: 'verdict missing' }; }

    const result = await deps.settleGiven(task, verdict);
    if (!result.txHash) {
      await store.recordJobError(jobId, result.error ?? 'finalize settlement did not confirm');
      return { finalized: false, reason: result.error ?? 'settlement did not confirm' };
    }
    const ok = await store.finalizeProposed(jobId, result.outcome as Outcome, result.txHash);
    if (ok) emit(job.workId, outcomeToState(result.outcome as Outcome));
    return { finalized: ok, txHash: result.txHash, outcome: result.outcome };
  }

  return { startJob, onDelivery, expireJob, disputeJob, finalizeProposedJob };
}
