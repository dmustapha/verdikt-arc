import type { SellerTransport } from '../transport.js';
import type { JobRow, SellerProtocol } from '../job-store.js';

// The generic seller adapter (WS4). ONE SellerTransport the engine/keeper/callback keep talking to,
// with three real drivers underneath — signed-webhook, A2A, x402 — chosen per job by its registered
// protocol. This is the seam WS3 reserved: it REPLACES the single httpTransport in engine-instance,
// normalizing every protocol back to the same { dispatch, fetchResult } surface (Gate C2).

export interface SellerDrivers {
  webhook: SellerTransport; // = the proven httpTransport (signed-webhook path)
  a2a: SellerTransport;     // = a2aDriver (@a2a-js/sdk)
  x402: SellerTransport;    // = x402Driver (@x402/evm, toll-only)
}

export function sellerAdapter(drivers: SellerDrivers): SellerTransport {
  const pick = (protocol: SellerProtocol): SellerTransport => {
    const driver = drivers[protocol as keyof SellerDrivers];
    if (!driver) throw new Error(`no seller driver for protocol '${protocol}'`);
    return driver;
  };
  return {
    // async so an unknown protocol surfaces as a REJECTION (the dispatcher's retry loop expects a
    // thrown/rejected promise), not a synchronous throw that would escape the fire-and-forget path.
    async dispatch(job: JobRow): Promise<void> { return pick(job.sellerProtocol).dispatch(job); },
    async fetchResult(job: JobRow, resultRef?: string) { return pick(job.sellerProtocol).fetchResult(job, resultRef); },
  };
}

export { makeGuardedFetch } from './guarded-fetch.js';
export { parseArtifact, extractArtifact } from './normalize.js';
