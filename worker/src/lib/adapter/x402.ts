import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import type { PaymentRequirements, SelectPaymentRequirements } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import type { SellerTransport } from '../transport.js';
import type { JobRow } from '../job-store.js';
import type { Artifact } from '../../types.js';
import { makeGuardedFetch } from './guarded-fetch.js';
import { extractArtifact } from './normalize.js';

// x402 driver (@x402 v2 scoped packages). Invokes a seller registered as `x402` by paying ONLY a
// sub-cent ACCESS TOLL — never the bounty. The bounty is always escrowed on Arc and released only by
// the verdict (MASTER-PLAN "payment reconciliation" crux). The invariant is enforced BY CONSTRUCTION,
// not by trust: the requirements selector THROWS when the 402 asks for more than `tollCapAtomic`, so
// `createPaymentPayload` never runs and nothing is ever signed for a bounty-sized ask.
//
//   dispatch    → POST the task envelope through a payment-wrapped fetch. A 402 is auto-answered with
//                 an EIP-3009 `transferWithAuthorization` toll (offline-signed by the payer key); the
//                 seller returns 202 + a job URL, which we persist (onResultRef) for polling.
//   fetchResult → GET the job URL through a PLAIN guarded fetch (polling is free — never paid) and
//                 normalize the body to our Artifact. Not-ready ⇒ null (deadline refunds a no-show).
//
// x402 has no native async, so `202 + job URL + poll` is our own convention layered on top. The toll
// payer key is worker-fixed (env), never client-supplied; the seller can extract at most the capped
// toll, never a payout.

// A viem LocalAccount is a structural ClientEvmSigner for the EIP-3009 path (address + signTypedData).
type EvmSigner = ConstructorParameters<typeof ExactEvmScheme>[0];

export interface X402DriverOpts {
  network: `eip155:${string}`;                                 // CAIP-2 target (Arc = eip155:5042002)
  tollCapAtomic: bigint;                                       // hard ceiling in atomic USDC (6-dec); above ⇒ refuse
  account?: EvmSigner;                                         // toll payer (a viem account); or…
  privateKey?: `0x${string}`;                                  // …derive one from a key
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  allowPrivate?: boolean;                                      // local mock only
  workerPublicUrl?: string;
  onResultRef?: (jobId: string, ref: string) => Promise<void>; // persist the seller's job URL
}

export function x402Driver(opts: X402DriverOpts): SellerTransport {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const baseFetch = opts.fetchFn ?? fetch;
  const signer: EvmSigner = opts.account
    ?? (opts.privateKey ? (privateKeyToAccount(opts.privateKey) as unknown as EvmSigner) : undefined as unknown as EvmSigner);
  if (!signer) throw new Error('x402Driver requires an account or privateKey (the toll payer)');

  // THE reconciliation chokepoint. The core client has already filtered `requirements` to our
  // registered network+scheme, so pick the CHEAPEST offer and refuse if even that exceeds the cap.
  // Picking the minimum (not the first) means a seller can't grief us by listing a bounty-sized decoy
  // ahead of a legitimate sub-cent toll — and the cap guarantees the bounty is never paid via x402.
  const selectTollOnly: SelectPaymentRequirements = (_version, requirements: PaymentRequirements[]) => {
    if (requirements.length === 0) throw new Error('x402: seller offered no payable requirement');
    const cheapest = requirements.reduce((lo, r) => (BigInt(r.amount) < BigInt(lo.amount) ? r : lo));
    if (BigInt(cheapest.amount) > opts.tollCapAtomic) {
      throw new Error(`x402: cheapest requirement ${cheapest.amount} exceeds toll cap ${opts.tollCapAtomic} — refusing (the bounty is never paid via x402)`);
    }
    return cheapest;
  };

  function payFetch(job: JobRow): typeof fetch {
    const guarded = makeGuardedFetch({ fetchFn: baseFetch, timeoutMs, allowedOrigins: originsFor(job), allowPrivate: opts.allowPrivate });
    const client = new x402Client(selectTollOnly).register(opts.network, new ExactEvmScheme(signer));
    return wrapFetchWithPayment(guarded, client);
  }

  function originsFor(job: JobRow): string[] {
    const origins: string[] = [];
    for (const u of [job.sellerUrl, job.resultRef]) { if (u) try { origins.push(new URL(u).origin); } catch { /* ignore */ } }
    return origins;
  }

  return {
    async dispatch(job: JobRow): Promise<void> {
      if (!job.sellerUrl) throw new Error('x402 job has no sellerUrl to dispatch to');
      const envelope = {
        workId: job.workId,
        callbackUrl: `${opts.workerPublicUrl ?? ''}/webhook/callback/${job.jobId}`,
        callbackToken: job.callbackToken,
        deadline: job.deadline.toISOString(),
      };

      // ── Pay phase (RETRYABLE) ──────────────────────────────────────────────────────────────────
      // A throw here has NOT spent a toll — the selector refuses an over-cap ask before signing, and an
      // unreachable seller never receives a signed authorization — so it is safe for dispatchWithRetry
      // to retry. Once payFetch RETURNS, the toll has been paid.
      const res = await payFetch(job)(job.sellerUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope),
      });

      // A still-402 response means the seller never accepted the payment → the toll was NOT settled, so
      // this one IS retryable (throw).
      if (res.status === 402) throw new Error('x402 dispatch failed: seller did not accept the toll payment');

      // ── Post-payment (NEVER RE-PAY) ────────────────────────────────────────────────────────────
      // The toll is now spent. From here we MUST NOT throw: a throw would make dispatchWithRetry invoke
      // dispatch again and pay a SECOND toll. Any problem below is terminal-for-dispatch — the job goes
      // AWAITING with no pollable ref, no-shows at the deadline, and the buyer is refunded (having lost
      // only the single sub-cent toll, never a second).
      if (!res.ok) return; // seller took the toll but rejected the task → let it no-show, don't re-pay
      const jobUrl = await readJobUrl(res).catch(() => null);
      if (jobUrl && opts.onResultRef) {
        // Best-effort persistence — a DB blip must not cost a second toll.
        try { await opts.onResultRef(job.jobId, jobUrl); } catch { /* unpersisted → job no-shows */ }
      }
    },

    async fetchResult(job: JobRow, resultRef?: string): Promise<Artifact | null> {
      const url = resultRef ?? job.resultRef ?? undefined;
      if (!url) return null;
      // Polling is FREE — a plain guarded GET, never the payment-wrapped fetch (a poll must never pay).
      const guarded = makeGuardedFetch({ fetchFn: baseFetch, timeoutMs, allowedOrigins: originsFor(job), allowPrivate: opts.allowPrivate });
      const res = await guarded(url, { method: 'GET' });
      if (res.status === 404 || res.status === 204) return null; // not ready yet
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      return extractArtifact(body);
    },
  };
}

// The seller's async job URL: a `Location` header or a `jobUrl`/`resultUrl` body field.
async function readJobUrl(res: Response): Promise<string | null> {
  const location = res.headers.get('location');
  if (location) return location;
  const body = await res.json().catch(() => null);
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.jobUrl === 'string') return b.jobUrl;
    if (typeof b.resultUrl === 'string') return b.resultUrl;
  }
  return null;
}
