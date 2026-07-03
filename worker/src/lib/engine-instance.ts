import * as jobStore from './job-store.js';
import { httpTransport } from './transport.js';
import type { SellerTransport } from './transport.js';
import { sellerAdapter } from './adapter/index.js';
import { a2aDriver } from './adapter/a2a.js';
import { x402Driver } from './adapter/x402.js';
import { runVerdict } from '../engine/orchestrator.js';
import { getTask } from './db.js';
import { refundExpiredOnChain } from '../settlement/expire.js';
import { makeEngine } from './job-engine.js';
import type { JobStore } from './job-engine.js';
import { startKeeper } from './keeper.js';
import type { Outcome } from '../types.js';
import { attestSettlement, settlementFromRun } from './attestor.js';

// Production job engine, wired to the real store / generic seller adapter / verdict engine / on-chain
// refund. A single shared instance so the jobs routes, the callback router, and the keeper all drive
// the same lifecycle. The job-store module structurally satisfies JobStore.
const store: JobStore = jobStore;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const workerPublicUrl = process.env.WORKER_PUBLIC_URL ?? '';
// Both A2A and x402 discover the seller's authoritative reference at dispatch (task id / job URL);
// persist it so the keeper poll + callback re-fetch resolve after a restart.
const onResultRef = jobStore.setResultRef;

// x402 needs a funded toll payer. Absent a key (most envs), x402 sellers are unsupported rather than
// crashing the worker at import — the driver refuses on dispatch and the no-show deadline refunds.
function buildX402Driver(): SellerTransport {
  const key = process.env.X402_TOLL_PAYER_KEY as `0x${string}` | undefined;
  if (!key) {
    return {
      async dispatch() { throw new Error('x402 seller support not configured (set X402_TOLL_PAYER_KEY)'); },
      async fetchResult() { return null; },
    };
  }
  return x402Driver({
    network: (process.env.X402_NETWORK as `eip155:${string}`) ?? 'eip155:5042002', // Arc
    tollCapAtomic: BigInt(process.env.X402_TOLL_CAP_ATOMIC ?? '10000'),             // $0.01 hard ceiling
    privateKey: key,
    workerPublicUrl,
    onResultRef,
  });
}

// The generic seller adapter: ONE SellerTransport over three real drivers, routed by job.sellerProtocol.
// Shared with the keeper so poll-fetch and dispatch use the same adapter (all SSRF-guarded).
export const transport: SellerTransport = sellerAdapter({
  webhook: httpTransport({ workerPublicUrl }),
  a2a: a2aDriver({ workerPublicUrl, onResultRef }),
  x402: buildX402Driver(),
});

export const engine = makeEngine({
  store,
  transport,
  verify: runVerdict,
  getTask,
  refundExpiredOnChain,
  // Post-settle ERC-8004 attestation (best-effort, env-gated — no-op unless ERC8004_AGENT_ID + an
  // attestor key are configured). Reconstructs the Settlement from the run result and records the
  // verdict as a validationResponse on the canonical Base Sepolia registry.
  attest: async (task, run) => {
    if (!run.txHash) return;
    const settlement = settlementFromRun(task, run.verdict, run.outcome as Outcome, run.txHash, run.bps);
    const r = await attestSettlement(task, run.verdict, settlement);
    const detail = r.status === 'attested'
      ? `req=${r.requestHash} resp=${r.responseTxHash}`
      : `${r.requestHash ? `req=${r.requestHash} ` : ''}${r.reason}`;
    console.log(`[erc8004] ${task.workId} attest: ${r.status} (${detail})`);
  },
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
