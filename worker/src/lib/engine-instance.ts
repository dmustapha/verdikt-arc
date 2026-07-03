import * as jobStore from './job-store.js';
import { httpTransport } from './transport.js';
import type { SellerTransport } from './transport.js';
import { sellerAdapter } from './adapter/index.js';
import { a2aDriver } from './adapter/a2a.js';
import { x402Driver } from './adapter/x402.js';
import { runVerdict, computeVerdict, settleGivenVerdict } from '../engine/orchestrator.js';
import { getTask, getVerdict, getEvidence } from './db.js';
import { refundExpiredOnChain } from '../settlement/expire.js';
import { makeEngine } from './job-engine.js';
import type { JobStore } from './job-engine.js';
import { startKeeper } from './keeper.js';
import { sseBus } from './sse-bus.js';
import { arbitrate } from './arbiter.js';
import type { VerdictResult, VerdictLabel, ArtifactType } from '../types.js';

// Reconstruct the held (proposed) verdict from its recorded row so the dispute/finalize path can settle
// it. Lossless for settlement: the score is re-derived from confidence exactly as the engine emitted it
// (score = round(confidence*100)), and planSettlement falls back to confidence anyway.
async function getProposedVerdict(workId: string): Promise<VerdictResult | null> {
  const vv = await getVerdict(workId);
  if (!vv) return null;
  return {
    verdict: vv.verdict as VerdictLabel,
    confidence: vv.confidence ?? 0,
    score: vv.confidence != null ? Math.round(vv.confidence * 100) : undefined,
    citedEvidence: Array.isArray(vv.citedEvidence) ? (vv.citedEvidence as string[]) : [],
    rationale: vv.rationale ?? '',
    route: vv.route as ArtifactType,
    evidenceHash: vv.evidenceHash as `0x${string}`,
    verdictCode: vv.verdictCode,
  };
}

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
  // WS8: publish every won job-state transition on the same per-workId SSE channel the courtroom uses,
  // so the returnable dashboard streams the live lifecycle (and replays it on late connect).
  emit: (workId, state) => sseBus.publish(workId, 'job_state', { state }),
  // NOTE: post-settle ERC-8004 attestation fires inside runVerdict (the single settle chokepoint),
  // not here — so both the async job path and the sync /verdict route are covered by construction.
  now: () => Date.now(),
  dispatch: {
    maxAttempts: Number(process.env.DISPATCH_MAX_ATTEMPTS ?? 3),
    baseDelayMs: Number(process.env.DISPATCH_BASE_DELAY_MS ?? 1000),
    sleep,
  },
  // WS11 dispute wiring. A disputable job HOLDS via computeVerdict (verify, no settle), then settles the
  // held or arbiter-ruled verdict via settleGivenVerdict — the SAME money path (records + attests +
  // receipts). The arbiter is the deterministic mock (arbiter.ts). challengeWindowMs is the default hold
  // length; keep it well under the escrow TTL so an undisputed job finalizes before the no-show clock.
  propose: computeVerdict,
  settleGiven: settleGivenVerdict,
  getProposedVerdict,
  getEvidence,
  arbitrate,
  challengeWindowMs: Number(process.env.CHALLENGE_WINDOW_MS ?? 5 * 60 * 1000),
});

// Start the background keeper (poll fallback + no-show expiry). Env-guarded: importing this module
// never spawns timers; the server opts in. Poll faster than expire; both jittered by the interval.
export function startWorkerKeeper(): () => void {
  return startKeeper(
    { engine, listByState: jobStore.listByState, transport, now: () => Date.now() },
    {
      pollMs: Number(process.env.KEEPER_POLL_MS ?? 15_000),
      expireMs: Number(process.env.KEEPER_EXPIRE_MS ?? 60_000),
      // WS11: finalize undisputed PROPOSED jobs as soon as their (short) challenge window closes.
      finalizeMs: Number(process.env.KEEPER_FINALIZE_MS ?? 15_000),
    },
  );
}
