import { keccak256, toBytes } from 'viem';
import type { EvidenceBundle } from '../types.js';

// Deterministic, key-sorted JSON so the same bundle always hashes identically.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashEvidence(bundle: EvidenceBundle): `0x${string}` {
  return keccak256(toBytes(canonical(bundle)));
}
