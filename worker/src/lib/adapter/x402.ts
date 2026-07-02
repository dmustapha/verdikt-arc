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

  // THE reconciliation chokepoint: pick the requirement on our network and refuse anything over cap.
  const selectTollOnly: SelectPaymentRequirements = (_version, requirements: PaymentRequirements[]) => {
    const match = requirements.find((r) => r.network === opts.network) ?? requirements[0];
    if (!match) throw new Error('x402: seller offered no payable requirement');
    if (BigInt(match.amount) > opts.tollCapAtomic) {
      throw new Error(`x402: required ${match.amount} exceeds toll cap ${opts.tollCapAtomic} — refusing (the bounty is never paid via x402)`);
    }
    return match;
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
      const res = await payFetch(job)(job.sellerUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope),
      });
      if (!res.ok) throw new Error(`x402 dispatch failed: seller returned ${res.status}`);
      const jobUrl = await readJobUrl(res);
      if (!jobUrl) throw new Error('x402 seller returned no job URL (async 202 + job URL expected)');
      if (opts.onResultRef) await opts.onResultRef(job.jobId, jobUrl);
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
