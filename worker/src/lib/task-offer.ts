import { keccak256, toBytes, recoverMessageAddress } from 'viem';
import type { Acceptance, ArtifactType } from '../types.js';

// Deterministic, key-sorted JSON so the same value always hashes/serializes identically
// (mirror of lib/hash.ts canonical()). Keeps criteriaHash and the offer message stable.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Commit the offer to exactly the criteria that will be judged. A seller (or anyone) can recompute
// this from the registered acceptance and confirm the payer did not swap the criteria after the fact.
export function criteriaHash(acceptance: Acceptance): `0x${string}` {
  return keccak256(toBytes(canonical(acceptance)));
}

// A signed Task Offer is the job-ticket a payer hands an independent seller: it names the work, the
// money, the escrow, both parties, and a deadline, signed by the payer. The seller verifies the
// signature + (separately) that the escrow is funded on-chain BEFORE doing any work. This replaces
// the off-band workId handoff and is what makes independent payer/seller coordination trust-minimized.
export interface TaskOffer {
  workId: `0x${string}`;
  type: ArtifactType;
  criteriaHash: `0x${string}`;
  amountUsdc: number;
  escrow: `0x${string}`;
  payer: `0x${string}`;
  seller: `0x${string}`;
  chainId: number;
  feeUsdc: number;
  expiresAt: number; // unix seconds
}

// The exact message a payer signs over an offer. personal_sign over canonical JSON (EIP-712 typed
// offers are a v2 upgrade). Published so a seller can reproduce + verify it independently.
export function offerMessage(o: TaskOffer): string {
  return `VerdiktTaskOffer\n${canonical(o)}`;
}

// Verify a signed offer: signature must recover to o.payer, and the offer must not be expired.
// The on-chain "is the escrow actually funded for this workId/seller/amount" check is done
// separately by the seller via RPC (it needs chain access); this validates the ticket itself.
export async function verifyOffer(
  o: TaskOffer,
  signature: `0x${string}`,
  nowSeconds: number,
): Promise<{ ok: boolean; reason?: string }> {
  if (!Number.isFinite(o.expiresAt) || o.expiresAt <= nowSeconds) return { ok: false, reason: 'offer expired' };
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message: offerMessage(o), signature });
  } catch {
    return { ok: false, reason: 'malformed signature' };
  }
  if (signer.toLowerCase() !== o.payer.toLowerCase()) return { ok: false, reason: 'signature does not match payer' };
  return { ok: true };
}
