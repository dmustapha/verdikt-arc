// Post-settle ERC-8004 attestation: after a definitive settlement on Arc, Verdikt records its verdict
// as a validationResponse on the canonical Validation Registry (Base Sepolia). This is BEST-EFFORT and
// OFF the money path — it NEVER throws, so a failed attestation can never undo or block a settlement.
// Env-gated: unconfigured (no agentId / attestor key) → a silent no-op, which keeps every existing
// test and the sync verdict path unaffected.
import type { Task, VerdictResult, Settlement } from '../types.js';
import { privateKeyToAccount } from 'viem/accounts';
import { buildAttestation } from './erc8004-evidence.js';
import { putEvidence } from './evidence-store.js';
import { readValidationStatus } from './erc8004.js';
import { openValidationRequest, postValidationResponse } from './erc8004-writer.js';

export type AttestResult =
  | { status: 'attested'; requestHash: `0x${string}`; requestTxHash: `0x${string}` | null; responseTxHash: `0x${string}`; alreadyOpen: boolean }
  | { status: 'skipped'; reason: string; requestHash?: `0x${string}` }
  | { status: 'error'; reason: string; requestHash?: `0x${string}` };

interface AttestorConfig {
  agentId: bigint;
  attestorKey: `0x${string}`;
  validator: `0x${string}`;
  baseUrl: string;
}

// Resolve config from env, or null when unconfigured (→ no-op). The validator address is DERIVED from
// the key so it always matches msg.sender (the registry requires response caller == named validator).
function loadConfig(): AttestorConfig | null {
  if (process.env.ERC8004_ATTEST_ENABLED === 'false') return null;
  const agentIdRaw = (process.env.ERC8004_AGENT_ID ?? '').trim();
  const attestorKey = (process.env.ERC8004_ATTESTOR_KEY ?? process.env.DEMO_PAYER_KEY ?? '').trim() as `0x${string}`;
  if (!agentIdRaw || !attestorKey) return null;
  let agentId: bigint;
  try { agentId = BigInt(agentIdRaw); } catch { return null; }
  const validator = privateKeyToAccount(attestorKey).address;
  const baseUrl = (process.env.WORKER_PUBLIC_URL ?? process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev').trim();
  return { agentId, attestorKey, validator, baseUrl };
}

// Reconstruct the Settlement the attestation needs from the async engine's run result. (The engine
// hands back verdict + outcome + txHash + bps; circleTxId isn't needed by the evidence bundle.)
export function settlementFromRun(
  task: Task, verdict: VerdictResult, outcome: Settlement['outcome'], txHash: string, bps?: number,
): Settlement {
  return { workId: task.workId, outcome, verdictCode: verdict.verdictCode, evidenceHash: verdict.evidenceHash, txHash, circleTxId: '', bps };
}

// Attest a settled verdict. Guarantees: never throws; abstain is skipped (nothing was validated);
// idempotent (a settlement already carrying a response on-chain is skipped). Returns a structured
// result the caller can log/publish.
export async function attestSettlement(
  task: Task, verdict: VerdictResult, settlement: Settlement, cfg: AttestorConfig | null = loadConfig(),
): Promise<AttestResult> {
  try {
    if (!cfg) return { status: 'skipped', reason: 'not-configured' };
    if (settlement.outcome === 'abstain') return { status: 'skipped', reason: 'abstain (no validation performed)' };
    if (!settlement.txHash) return { status: 'skipped', reason: 'no settlement tx' };

    const att = buildAttestation({ verdict, settlement, task, validator: cfg.validator, baseUrl: cfg.baseUrl });
    // Serve the evidence first so the responseURI resolves the instant the tx lands.
    putEvidence(att);

    // Idempotency: skip only if a RESPONSE already exists. An open-but-unanswered request also has
    // lastUpdate > 0 (and a set validatorAddress) — the tell for "already responded" is a non-empty
    // tag / non-zero responseHash. Keying on lastUpdate alone would wrongly skip re-posting a response
    // after a request opened but its response failed (exactly the load-balanced-RPC failure mode).
    const ZERO_HASH = `0x${'00'.repeat(32)}`;
    const existing = await readValidationStatus(att.requestHash);
    if (existing && (existing.tag !== '' || existing.responseHash.toLowerCase() !== ZERO_HASH)) {
      return { status: 'skipped', reason: 'already attested on-chain', requestHash: att.requestHash };
    }

    const req = await openValidationRequest({
      attestorKey: cfg.attestorKey, agentId: cfg.agentId, validator: cfg.validator,
      requestHash: att.requestHash, requestURI: att.requestURI,
    });
    const responseTxHash = await postValidationResponse({
      attestorKey: cfg.attestorKey, requestHash: att.requestHash, response: att.response,
      responseURI: att.responseURI, responseHash: att.responseHash, tag: att.tag,
    });
    return { status: 'attested', requestHash: att.requestHash, requestTxHash: req.txHash, responseTxHash, alreadyOpen: req.alreadyOpen };
  } catch (e) {
    return { status: 'error', reason: String((e as Error)?.message ?? e) };
  }
}
