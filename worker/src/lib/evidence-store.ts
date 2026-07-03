// In-memory store for ERC-8004 evidence bundles, keyed by requestHash. The on-chain responseURI
// (served by routes/evidence.ts) resolves here so anyone can refetch the bundle and recompute the
// responseHash the registry anchored. Ephemeral by design: it lives on the single worker process
// (fine for a demo / single-machine Fly). A durable store (DB row, keyed by requestHash) is the
// hardening follow-up — the bundle is deterministic, so it could equally be rebuilt on demand.
import type { Erc8004Attestation } from './erc8004-evidence.js';

export interface StoredEvidence {
  requestHash: `0x${string}`;
  responseHash: `0x${string}`;
  json: string;                 // the exact canonical bundle bytes hashed into responseHash
}

const store = new Map<string, StoredEvidence>();

const norm = (h: string) => h.toLowerCase();

export function putEvidence(att: Erc8004Attestation): void {
  store.set(norm(att.requestHash), {
    requestHash: att.requestHash,
    responseHash: att.responseHash,
    json: att.bundleJson,
  });
}

export function getEvidence(requestHash: string): StoredEvidence | undefined {
  return store.get(norm(requestHash));
}

export function evidenceCount(): number {
  return store.size;
}

// Test-only: reset between suites.
export function _clearEvidence(): void {
  store.clear();
}
