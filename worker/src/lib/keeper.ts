import type { JobRow } from './job-store.js';
import type { SellerTransport } from './transport.js';
import type { JobEngine } from './job-engine.js';
import { JOB_STATES, isTerminal } from './job-machine.js';
import type { JobState } from './job-machine.js';

// The keeper — two idempotent sweeps that run on a timer (WS3):
//  - pollOnce:   delivery fallback for sellers without push. It fetches the authoritative result for
//                each awaiting job; a hit feeds onDelivery (verify → settle). Past-deadline jobs are
//                left to expiry, so a late delivery can't beat the no-show refund.
//  - expireOnce: no-show refund. Any non-terminal job past its deadline is refunded to the buyer.
// Every effect is injected, so both sweeps are unit-testable with no timers/network/chain, and each
// job is isolated (one seller's failure never aborts the batch).

export interface KeeperDeps {
  engine: Pick<JobEngine, 'onDelivery' | 'expireJob'>;
  listByState(states: JobState[]): Promise<JobRow[]>;
  transport: SellerTransport;
  now(): number;
}

const NON_TERMINAL = JOB_STATES.filter((s) => !isTerminal(s));

export async function pollOnce(deps: KeeperDeps): Promise<number> {
  const jobs = await deps.listByState(['AWAITING_DELIVERY']);
  let delivered = 0;
  for (const job of jobs) {
    if (deps.now() >= job.deadline.getTime()) continue; // expiry owns past-deadline jobs
    try {
      const artifact = await deps.transport.fetchResult(job);
      if (artifact) {
        await deps.engine.onDelivery(job, { artifact }); // the poll IS the authoritative fetch
        delivered++;
      }
    } catch {
      /* transient seller failure — the next tick retries */
    }
  }
  return delivered;
}

export async function expireOnce(deps: KeeperDeps): Promise<number> {
  const jobs = await deps.listByState(NON_TERMINAL);
  let expired = 0;
  for (const job of jobs) {
    if (deps.now() < job.deadline.getTime()) continue;
    try {
      const r = await deps.engine.expireJob(job.jobId);
      if (r.expired) expired++;
    } catch {
      /* refundExpired failed (e.g. a race with settlement) — the next tick retries or the job settled */
    }
  }
  return expired;
}

// Start the background sweeps. Env-guarded by the caller so imports/tests never spawn timers.
export function startKeeper(deps: KeeperDeps, opts: { pollMs: number; expireMs: number }): () => void {
  const poll = setInterval(() => { void pollOnce(deps); }, opts.pollMs);
  const expire = setInterval(() => { void expireOnce(deps); }, opts.expireMs);
  poll.unref?.(); expire.unref?.(); // never keep the process alive just for the keeper
  return () => { clearInterval(poll); clearInterval(expire); };
}
