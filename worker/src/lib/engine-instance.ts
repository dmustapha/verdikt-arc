import * as jobStore from './job-store.js';
import { httpTransport } from './transport.js';
import { runVerdict } from '../engine/orchestrator.js';
import { getTask } from './db.js';
import { refundExpiredOnChain } from '../settlement/expire.js';
import { makeEngine } from './job-engine.js';
import type { JobStore } from './job-engine.js';
import { startKeeper } from './keeper.js';

// Production job engine, wired to the real store / HTTP transport / verdict engine / on-chain refund.
// A single shared instance so the jobs routes, the callback router, and the keeper all drive the same
// lifecycle. The job-store module structurally satisfies JobStore.
const store: JobStore = jobStore;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Shared with the keeper so poll-fetch and dispatch use one SSRF-guarded HTTP transport.
export const transport = httpTransport({ workerPublicUrl: process.env.WORKER_PUBLIC_URL ?? '' });

export const engine = makeEngine({
  store,
  transport,
  verify: runVerdict,
  getTask,
  refundExpiredOnChain,
  now: () => Date.now(),
  dispatch: {
    maxAttempts: Number(process.env.DISPATCH_MAX_ATTEMPTS ?? 3),
    baseDelayMs: Number(process.env.DISPATCH_BASE_DELAY_MS ?? 1000),
    sleep,
  },
});

// Start the background keeper (poll fallback + no-show expiry). Env-guarded: importing this module
// never spawns timers; the server opts in. Poll faster than expire; both jittered by the interval.
export function startWorkerKeeper(): () => void {
  return startKeeper(
    { engine, listByState: jobStore.listByState, transport, now: () => Date.now() },
    {
      pollMs: Number(process.env.KEEPER_POLL_MS ?? 15_000),
      expireMs: Number(process.env.KEEPER_EXPIRE_MS ?? 60_000),
    },
  );
}
