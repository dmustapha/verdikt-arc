import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getJob, recordSeenJti } from '../lib/job-store.js';
import type { JobRow } from '../lib/job-store.js';
import { isTerminal } from '../lib/job-machine.js';
import { assertSafeUrl } from '../lib/ssrf.js';
import type { Artifact, ArtifactType } from '../types.js';

// Seller delivery callbacks (WS3). A seller signals "work delivered" here. The endpoint is the
// security surface, so it does the AUTH + REPLAY + SSRF work and NOTHING that moves money itself:
//  - webhook: the seller POSTs the artifact inline (signed by the per-job callback token).
//  - a2a:     the push is only a NUDGE. We NEVER trust a pushed body — we hand a re-fetch handle
//             (resultRef) to onDelivery, which fetches the authoritative result from the registered
//             seller origin (A2A tasks/get semantics). resultRef is SSRF-guarded to that origin.
// onDelivery (the job-engine, wired in WS3.3) runs async; the callback acks 202 immediately.

export type Delivery = { artifact: Artifact } | { resultRef: string };

export interface CallbackDeps {
  getJob(jobId: string): Promise<JobRow | null>;
  recordSeenJti(jti: string, jobId: string): Promise<boolean>;
  onDelivery(job: JobRow, delivery: Delivery): Promise<void>;
}

export interface CallbackInput {
  protocol: 'webhook' | 'a2a';
  jobId: string;
  token?: string;
  jti?: string;
  artifact?: unknown;   // webhook: inline artifact
  resultRef?: string;   // a2a: authoritative-result URL (or fall back to the registered one)
}

export interface CallbackResult { status: number; body: Record<string, unknown>; }

const ARTIFACT_TYPES: ArtifactType[] = ['code', 'tool_output', 'answer', 'execution', 'tool_trace'];

// Constant-time token compare. Different lengths ⇒ not equal (no throw, no early-exit timing leak).
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function validArtifact(a: unknown): a is Artifact {
  if (!a || typeof a !== 'object') return false;
  const art = a as Record<string, unknown>;
  return ARTIFACT_TYPES.includes(art.type as ArtifactType)
    && typeof art.payload === 'string' && art.payload.trim() !== '';
}

// Origins a re-fetch URL is allowed to hit: the registered seller URL's origin and any preset
// resultRef origin. Ties the authoritative re-fetch to the seller that was registered for this job.
function allowedOriginsFor(job: JobRow): string[] {
  const origins: string[] = [];
  for (const u of [job.sellerUrl, job.resultRef]) {
    if (!u) continue;
    try { origins.push(new URL(u).origin); } catch { /* ignore unparseable stored URL */ }
  }
  return origins;
}

export async function handleCallback(deps: CallbackDeps, input: CallbackInput): Promise<CallbackResult> {
  const job = await deps.getJob(input.jobId);
  if (!job) return { status: 404, body: { error: 'unknown job' } };

  // AUTH first — a forged callback (no/wrong token) learns nothing beyond "job exists".
  if (!tokenMatches(input.token, job.callbackToken)) {
    return { status: 401, body: { error: 'invalid callback token' } };
  }
  if (isTerminal(job.state)) {
    return { status: 409, body: { error: `job already ${job.state.toLowerCase()}` } };
  }
  if (!input.jti) return { status: 400, body: { error: 'jti required' } };

  // REPLAY defense before any delivery work: a replayed jti is rejected atomically.
  const fresh = await deps.recordSeenJti(input.jti, input.jobId);
  if (!fresh) return { status: 409, body: { error: 'duplicate callback (jti already seen)' } };

  let delivery: Delivery;
  if (input.protocol === 'webhook') {
    if (!validArtifact(input.artifact)) return { status: 400, body: { error: 'valid inline artifact required' } };
    delivery = { artifact: input.artifact };
  } else {
    const ref = input.resultRef ?? job.resultRef;
    if (!ref) return { status: 400, body: { error: 'resultRef required (no registered result URL for this job)' } };
    try {
      assertSafeUrl(ref, { allowedOrigins: allowedOriginsFor(job) });
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : 'unsafe resultRef' } };
    }
    delivery = { resultRef: ref };
  }

  // Fire-and-forget: the verify→settle path runs async; downstream failures leave the job non-terminal
  // for the keeper to expire at the deadline. Ack fast.
  void deps.onDelivery(job, delivery).catch(() => { /* engine records its own errors */ });
  return { status: 202, body: { jobId: job.jobId, accepted: true } };
}

// ── Express wrapper ──────────────────────────────────────────────────────────
// onDelivery is injected at mount time (WS3.3 job-engine) so this file stays money-free and testable.
export function makeCallbackRouter(onDelivery: CallbackDeps['onDelivery']): Router {
  const router = Router();
  const deps: CallbackDeps = { getJob, recordSeenJti, onDelivery };

  const handler = (protocol: 'webhook' | 'a2a') => async (req: import('express').Request, res: import('express').Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const headerToken = req.header('x-callback-token') ?? bearer(req.header('authorization'));
    const input: CallbackInput = {
      protocol,
      jobId: req.params.jobId,
      token: headerToken,
      jti: typeof body.jti === 'string' ? body.jti : undefined,
      artifact: body.artifact,
      resultRef: typeof body.resultRef === 'string' ? body.resultRef : undefined,
    };
    const r = await handleCallback(deps, input);
    res.status(r.status).json(r.body);
  };

  router.post('/webhook/callback/:jobId', handler('webhook'));
  router.post('/a2a/callback/:jobId', handler('a2a'));
  return router;
}

function bearer(auth: string | undefined): string | undefined {
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : undefined;
}
