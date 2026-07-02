import { assertSafeUrl } from './ssrf.js';
import { extractArtifact } from './adapter/normalize.js';
import type { JobRow } from './job-store.js';
import type { Artifact } from '../types.js';

// The seller transport seam (WS3). A job is dispatched to a seller and its result is fetched back.
// WS3 ships ONE concrete transport (signed HTTP webhook + generic GET re-fetch) — enough for the
// async lifecycle + a live proof. WS4 replaces/extends this with the generic adapter's three real
// drivers (A2A `@a2a-js/sdk`, x402 `@x402/evm`, signed-webhook), normalizing to this same interface.

export interface SellerTransport {
  // Hand the task to the seller. THROW on unreachable/transient failure so the dispatcher retries.
  dispatch(job: JobRow): Promise<void>;
  // Authoritative result fetch (A2A tasks/get / webhook poll). null ⇒ not ready yet (poller retries).
  fetchResult(job: JobRow, resultRef?: string): Promise<Artifact | null>;
}

// Default HTTP transport. dispatch() POSTs a signed envelope telling the seller WHERE to call back
// (our callback URL) and with WHAT per-job token; the seller does the work async and either POSTs to
// the callback (webhook) or exposes the result at resultRef for us to GET (a2a-style). Both the
// dispatch URL and the re-fetch URL are SSRF-guarded to the registered seller origin.
// fetchFn is injectable so the transport is unit-testable without a live network (default = global
// fetch). allowPrivate is an escape hatch for a localhost end-to-end wire proof only — never prod.
export function httpTransport(opts: { workerPublicUrl: string; timeoutMs?: number; fetchFn?: typeof fetch; allowPrivate?: boolean } = { workerPublicUrl: '' }): SellerTransport {
  const timeout = opts.timeoutMs ?? 10_000;
  const doFetch = opts.fetchFn ?? fetch;
  return {
    async dispatch(job: JobRow): Promise<void> {
      if (!job.sellerUrl) throw new Error('job has no sellerUrl to dispatch to');
      assertSafeUrl(job.sellerUrl, { allowPrivate: opts.allowPrivate }); // block private/loopback dispatch targets
      const callbackPath = job.sellerProtocol === 'a2a' ? 'a2a' : 'webhook';
      const envelope = {
        workId: job.workId,
        brief: job.brief ?? null, // the seller's route-filtered input (Option C)
        callbackUrl: `${opts.workerPublicUrl}/${callbackPath}/callback/${job.jobId}`,
        callbackToken: job.callbackToken,
        deadline: job.deadline.toISOString(),
      };
      const res = await fetchWithTimeout(doFetch, job.sellerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      }, timeout);
      if (!res.ok) throw new Error(`dispatch failed: seller returned ${res.status}`);
    },

    async fetchResult(job: JobRow, resultRef?: string): Promise<Artifact | null> {
      const ref = resultRef ?? job.resultRef;
      if (!ref) return null;
      const origins: string[] = [];
      for (const u of [job.sellerUrl, job.resultRef]) { if (u) try { origins.push(new URL(u).origin); } catch { /* ignore */ } }
      assertSafeUrl(ref, { allowedOrigins: origins, allowPrivate: opts.allowPrivate });
      const res = await fetchWithTimeout(doFetch, ref, { method: 'GET' }, timeout);
      if (res.status === 404 || res.status === 204) return null; // not ready yet
      if (!res.ok) throw new Error(`fetchResult failed: ${res.status}`);
      const body = await res.json().catch(() => null);
      // The seller may wrap the artifact under `artifact`, or return it bare (shared normalizer).
      return extractArtifact(body);
    },
  };
}

async function fetchWithTimeout(doFetch: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await doFetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
