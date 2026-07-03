// GET /evidence/:requestHash(.json) — serves the ERC-8004 evidence bundle a validationResponse
// points at. Public and read-only (no money, no PII): the bundle is chain-public verdict data, and
// serving it lets anyone verify keccak256(bundle) == the on-chain responseHash. Thin shell over a
// pure handler (mirrors routes/sellers.ts), so the logic is unit-tested without an HTTP server.
import { Router } from 'express';
import { getEvidence, type StoredEvidence } from '../lib/evidence-store.js';

const REQUEST_HASH = /^0x[0-9a-fA-F]{64}$/;

export interface EvidenceDeps {
  get(requestHash: string): StoredEvidence | undefined;
}

export type EvidenceResult =
  | { status: 200; json: string }
  | { status: 400 | 404; body: { error: string } };

// `id` may arrive as "<requestHash>" or "<requestHash>.json" (the responseURI uses the .json form).
export function handleGetEvidence(deps: EvidenceDeps, id: string): EvidenceResult {
  const requestHash = id.replace(/\.json$/i, '');
  if (!REQUEST_HASH.test(requestHash)) return { status: 400, body: { error: 'invalid requestHash' } };
  const found = deps.get(requestHash);
  if (!found) return { status: 404, body: { error: 'evidence not found' } };
  return { status: 200, json: found.json };
}

export const evidenceRouter = Router();

evidenceRouter.get('/evidence/:id', (req, res) => {
  // Public attestation doc: allow any origin to fetch and verify it.
  res.setHeader('Access-Control-Allow-Origin', '*');
  const r = handleGetEvidence({ get: getEvidence }, req.params.id);
  if (r.status === 200) {
    res.status(200).type('application/json').send(r.json);
    return;
  }
  res.status(r.status).json(r.body);
});
