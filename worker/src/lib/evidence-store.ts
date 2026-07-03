// Store for ERC-8004 evidence bundles, keyed by requestHash. The on-chain responseURI (served by
// routes/evidence.ts) resolves here so anyone can refetch the bundle and recompute the responseHash
// the registry anchored.
//
// Two layers: an in-memory Map (fast path) and a DURABLE Postgres row (survives worker restarts, so
// the on-chain responseURI keeps resolving forever — the fix for the "in-memory only → dead links on
// restart" gap). DB persistence is opt-in via enableEvidencePersistence() called at server boot, so
// unit tests stay DB-free and Map-only. DB writes/reads are best-effort: a DB outage degrades to the
// Map, never throws into the attestation or the route.
import type { Erc8004Attestation } from './erc8004-evidence.js';
import { insertErc8004Evidence, getErc8004Evidence } from './db.js';

export interface StoredEvidence {
  requestHash: `0x${string}`;
  responseHash: `0x${string}`;
  json: string;                 // the exact canonical bundle bytes hashed into responseHash
}

const cache = new Map<string, StoredEvidence>();
let dbEnabled = false;

const norm = (h: string) => h.toLowerCase();

// Called once at server boot (production) to turn on durable persistence. Unit tests never call it.
export function enableEvidencePersistence(): void { dbEnabled = true; }

export async function putEvidence(att: Erc8004Attestation): Promise<void> {
  cache.set(norm(att.requestHash), { requestHash: att.requestHash, responseHash: att.responseHash, json: att.bundleJson });
  if (dbEnabled) {
    try { await insertErc8004Evidence(norm(att.requestHash), att.responseHash, att.bundleJson); }
    catch (e) { console.warn(`[erc8004] evidence DB persist failed (cache still serves): ${String((e as Error)?.message ?? e)}`); }
  }
}

// Cache first; on a miss, fall back to the durable row (repopulating the cache) so a URL served by a
// restarted worker still resolves. Returns undefined only when neither layer has it.
export async function getEvidence(requestHash: string): Promise<StoredEvidence | undefined> {
  const hit = cache.get(norm(requestHash));
  if (hit) return hit;
  if (!dbEnabled) return undefined;
  try {
    const row = await getErc8004Evidence(norm(requestHash));
    if (!row) return undefined;
    const stored: StoredEvidence = { requestHash: requestHash as `0x${string}`, responseHash: row.responseHash as `0x${string}`, json: row.json };
    cache.set(norm(requestHash), stored);
    return stored;
  } catch (e) {
    console.warn(`[erc8004] evidence DB read failed: ${String((e as Error)?.message ?? e)}`);
    return undefined;
  }
}

export function evidenceCacheSize(): number { return cache.size; }

// Test-only: reset the in-memory cache between suites.
export function _clearEvidence(): void { cache.clear(); }
