import { keccak256, toBytes } from 'viem';

// Byte-exact mirror of worker/src/lib/hash.ts `canonical()` + `hashEvidence()`. The web recomputes
// the evidence hash from the stored bundle and proves it equals BOTH the DB mirror AND the on-chain
// anchor — a live tamper-evident round-trip (F-005). This MUST stay identical to the worker's
// function; tests/hash-parity.test.ts guards against drift.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashEvidence(bundle: unknown): `0x${string}` {
  return keccak256(toBytes(canonical(bundle)));
}
