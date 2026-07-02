import { assertSafeUrl } from './ssrf.js';
import { makeGuardedFetch } from './adapter/guarded-fetch.js';
import type { SellerProtocol } from './job-store.js';

// Seller registry logic (WS4). A seller becomes a listable catalog entry only by (1) presenting a
// valid, terms-accepted registration and (2) passing a live HEALTH PROBE against its own endpoint.
// Both steps are pure/injectable so the accept-vs-withhold decision is testable without a DB or a live
// seller. The registry is a thin curated surface, NOT a crawler (MASTER-PLAN: "NOT a marketplace").

export interface SellerRegistration {
  endpoint: string;               // the seller's base URL (a2a agent base / webhook dispatch / x402 resource)
  protocol: SellerProtocol;       // webhook | a2a | x402
  capability: string;             // what it does (skill/capability label)
  wallet: string;                 // payout wallet on its home chain
  payoutDomain: number;           // CCTP domain id of that home chain
  agentId?: string;               // optional ERC-8004 identity
  termsAccepted: boolean;         // MUST accept deliver-then-settle (paid only on verified delivery)
}

const PROTOCOLS: SellerProtocol[] = ['webhook', 'a2a', 'x402'];
const WALLET = /^0x[0-9a-fA-F]{40}$/;

export type ValidationResult =
  | { ok: true; value: SellerRegistration }
  | { ok: false; error: string };

export function validateRegistration(input: unknown): ValidationResult {
  const b = (input ?? {}) as Record<string, unknown>;
  if (typeof b.endpoint !== 'string' || !b.endpoint) return fail('endpoint is required');
  try {
    // HTTPS-only, no private/loopback — the registry never lists an internal or plaintext endpoint.
    assertSafeUrl(b.endpoint);
  } catch (e) {
    return fail(`endpoint: ${e instanceof Error ? e.message : 'unsafe URL'}`);
  }
  if (typeof b.protocol !== 'string' || !PROTOCOLS.includes(b.protocol as SellerProtocol)) {
    return fail(`protocol must be one of ${PROTOCOLS.join('|')}`);
  }
  if (typeof b.capability !== 'string' || b.capability.trim() === '') return fail('capability is required');
  if (typeof b.wallet !== 'string' || !WALLET.test(b.wallet)) return fail('wallet must be a 20-byte hex address');
  if (typeof b.payoutDomain !== 'number' || !Number.isInteger(b.payoutDomain) || b.payoutDomain < 0) {
    return fail('payoutDomain must be a non-negative integer (CCTP domain id)');
  }
  if (b.agentId !== undefined && typeof b.agentId !== 'string') return fail('agentId must be a string when present');
  if (b.termsAccepted !== true) return fail('deliver-then-settle terms must be accepted (termsAccepted: true)');
  return {
    ok: true,
    value: {
      endpoint: b.endpoint, protocol: b.protocol as SellerProtocol, capability: b.capability.trim(),
      wallet: b.wallet, payoutDomain: b.payoutDomain, agentId: b.agentId as string | undefined, termsAccepted: true,
    },
  };
}

function fail(error: string): ValidationResult { return { ok: false, error }; }

export interface ProbeOpts { fetchFn: typeof fetch; timeoutMs: number; allowPrivate?: boolean }

// A live handshake against the seller's own endpoint before it can be listed. Per protocol:
//   a2a     → the agent card resolves and has the required shape (name + url + skills)
//   webhook → the endpoint answers at all (any non-5xx; a POST-only endpoint replying 405 is up)
//   x402    → the endpoint challenges for payment (402) — proof it is a real x402 resource
// SSRF-guarded + time-bounded; any network error or block ⇒ unhealthy (withheld from the catalog).
export async function probeSeller(seller: Pick<SellerRegistration, 'endpoint' | 'protocol'>, opts: ProbeOpts): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(seller.endpoint).origin;
    assertSafeUrl(seller.endpoint, { allowPrivate: opts.allowPrivate });
  } catch {
    return false; // malformed or private endpoint — never probe it
  }
  const guarded = makeGuardedFetch({ fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs, allowedOrigins: [origin], allowPrivate: opts.allowPrivate });

  try {
    if (seller.protocol === 'a2a') {
      const cardUrl = new URL('/.well-known/agent-card.json', seller.endpoint).href;
      const res = await guarded(cardUrl, { method: 'GET' });
      if (!res.ok) return false;
      const card = await res.json().catch(() => null) as Record<string, unknown> | null;
      return !!card && typeof card.name === 'string' && typeof card.url === 'string' && Array.isArray(card.skills);
    }
    if (seller.protocol === 'x402') {
      const res = await guarded(seller.endpoint, { method: 'GET' });
      return res.status === 402; // an x402 resource challenges for payment
    }
    // webhook: reachable ⇒ answered with any non-5xx status.
    const res = await guarded(seller.endpoint, { method: 'GET' });
    return res.status < 500;
  } catch {
    return false; // network error / timeout / SSRF block ⇒ unhealthy
  }
}
