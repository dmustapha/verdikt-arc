import type { SellerTransport } from './transport.js';
import type { JobRow } from './job-store.js';

// Dispatch a job to its seller with bounded exponential-backoff retry (WS3 Gate C1: "unreachable →
// retry then fail"). A transient/unreachable seller throws; we retry up to maxAttempts. Every attempt
// — success or failure — is recorded so the job row shows the real dispatch history. On exhaustion we
// return false and leave the job FUNDED; the keeper refunds the buyer at the deadline (funds are never
// stranded). Injected deps keep this unit-testable with no real network, DB, or wall-clock.

export interface DispatchDeps {
  recordDispatchAttempt(jobId: string, error?: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  maxAttempts: number;
  baseDelayMs: number;
}

export async function dispatchWithRetry(job: JobRow, transport: SellerTransport, deps: DispatchDeps): Promise<boolean> {
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    try {
      await transport.dispatch(job);
      await deps.recordDispatchAttempt(job.jobId); // success (no error)
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await deps.recordDispatchAttempt(job.jobId, msg);
      if (attempt < deps.maxAttempts) {
        await deps.sleep(deps.baseDelayMs * 2 ** (attempt - 1)); // 100, 200, 400, …
      }
    }
  }
  return false;
}
