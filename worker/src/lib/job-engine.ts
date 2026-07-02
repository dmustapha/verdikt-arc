import type { Artifact, Outcome, Task } from '../types.js';
import type { JobRow, SellerProtocol } from './job-store.js';
import type { SellerTransport } from './transport.js';
import type { Delivery } from '../routes/callback.js';
import type { VerdictRunResult } from '../engine/orchestrator.js';
import { isTerminal } from './job-machine.js';
import { dispatchWithRetry } from './dispatcher.js';

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
}

export interface EngineDeps {
  store: JobStore;
  transport: SellerTransport;
  verify(task: Task, artifact: Artifact): Promise<VerdictRunResult>;   // default: orchestrator.runVerdict
  getTask(workId: string): Promise<Task | null>;
  refundExpiredOnChain(workId: `0x${string}`): Promise<string>;        // default: settlement/expire
  now(): number;
  dispatch: { maxAttempts: number; baseDelayMs: number; sleep(ms: number): Promise<void> };
}

export interface CreateJobInput {
  jobId: string;
  workId: `0x${string}`;
  sellerUrl: string | null;
  sellerProtocol: SellerProtocol;
  callbackToken: string;
  resultRef: string | null;
  deadline: Date;
}

export interface JobEngine {
  startJob(input: CreateJobInput): Promise<JobRow | null>;
  onDelivery(job: JobRow, delivery: Delivery): Promise<void>;
  expireJob(jobId: string): Promise<{ expired: boolean; reason?: string; txHash?: string }>;
}

export function makeEngine(deps: EngineDeps): JobEngine {
  const { store, transport, verify, getTask, refundExpiredOnChain, now } = deps;

  async function startJob(input: CreateJobInput): Promise<JobRow | null> {
    await store.createJob(input);
    const job = await store.getJob(input.jobId);
    if (!job) return null;

    const ok = await dispatchWithRetry(job, transport, {
      recordDispatchAttempt: store.recordDispatchAttempt,
      sleep: deps.dispatch.sleep,
      maxAttempts: deps.dispatch.maxAttempts,
      baseDelayMs: deps.dispatch.baseDelayMs,
    });

    if (ok) {
      await store.markDispatched(input.jobId);
      await store.markAwaiting(input.jobId);
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
    await store.markVerifying(job.jobId);

    const task = await getTask(job.workId);
    if (!task) { await store.recordJobError(job.jobId, 'task row missing for delivered job'); return; }

    // Verify → settle. runVerdict is escrow-gated and idempotent at the chain (FUNDED-once), so this
    // is the money path. A definitive verdict settles; abstain refunds+ABSTAINED; a settle that never
    // confirms leaves the job non-terminal for the keeper to expire at the deadline.
    const result = await verify(task, artifact);
    if (result.txHash) {
      await store.markSettled(job.jobId, result.outcome as Outcome, result.txHash);
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
    return { expired: ok, txHash, reason: ok ? undefined : 'raced to terminal' };
  }

  return { startJob, onDelivery, expireJob };
}
