import { keccak256, toBytes, recoverMessageAddress } from 'viem';
import type { Account } from 'viem';
import type { Acceptance, TaskOffer } from './types.js';

// MUST stay byte-identical to worker/src/lib/task-offer.ts + hash.ts canonical(), or criteriaHash /
// offerMessage / artifactMessage will not match across the SDK and the worker. The hash-parity
// principle from the web tier applies here too.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function criteriaHash(acceptance: Acceptance): `0x${string}` {
  return keccak256(toBytes(canonical(acceptance)));
}

// The message the SELLER signs to bind an artifact to (workId, payload) — matches the worker's
// artifactMessage() so the worker's H-2 signature check (recover === task.seller) passes.
export function artifactMessage(workId: string, payload: string): string {
  return `Verdikt:${workId}:${keccak256(toBytes(payload))}`;
}

// The message the PAYER signs over a Task Offer — matches the worker's offerMessage().
export function offerMessage(o: TaskOffer): string {
  return `VerdiktTaskOffer\n${canonical(o)}`;
}

export async function signOffer(account: Account, o: TaskOffer): Promise<`0x${string}`> {
  if (!account.signMessage) throw new Error('signer cannot sign messages');
  return account.signMessage({ message: offerMessage(o) });
}

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
