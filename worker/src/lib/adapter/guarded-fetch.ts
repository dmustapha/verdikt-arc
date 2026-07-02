import { assertSafeUrl } from '../ssrf.js';

// A `fetch`-shaped wrapper that SSRF-guards and time-bounds every outbound request to a
// seller-controlled URL. The A2A driver hands it to `@a2a-js/sdk` (guarding the card fetch AND the
// card.url JSON-RPC calls) and the x402 driver hands it to `wrapFetchWithPayment` (guarding the 402
// endpoint AND the poll URL). Because the guard runs on EVERY call, a malicious agent card that points
// its `url` at an internal host, or a redirect to cloud metadata, is blocked at the socket — the SDKs
// never reach it. Requests are also aborted past `timeoutMs` so a hung seller can't stall a sweep.

export interface GuardedFetchOpts {
  fetchFn: typeof fetch;
  timeoutMs: number;
  allowedOrigins?: string[]; // if set, the request origin MUST be one of these (registered seller origins)
  allowPrivate?: boolean;    // local-mock escape hatch only — never in prod
}

// fetch accepts string | URL | Request. Recover the target URL uniformly (x402's wrapper passes Request).
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url; // Request
}

export function makeGuardedFetch(opts: GuardedFetchOpts): typeof fetch {
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    assertSafeUrl(urlOf(input), { allowedOrigins: opts.allowedOrigins, allowPrivate: opts.allowPrivate });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      return await opts.fetchFn(input, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  return guarded as typeof fetch;
}
