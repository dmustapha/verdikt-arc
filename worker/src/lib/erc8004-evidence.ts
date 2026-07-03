// Evidence bundle for an ERC-8004 validationResponse. Built purely from the verdict + settlement so
// the on-chain responseHash is REPRODUCIBLE: anyone with the workId + settlement can refetch the
// bundle and recompute keccak256(bundle) to confirm Verdikt attested honestly. Deliberately carries
// NO wall-clock (the registry's lastUpdate records time) and NO raw task input / artifact / acceptance
// spec — only chain-public facts and the verdict's own reasoning (Gate D1 no-PII requirement).
import { keccak256, toBytes, encodeAbiParameters } from 'viem';
import type { VerdictResult, Settlement, Task } from '../types.js';
import { ARC_CHAIN_ID, ARC_EXPLORER } from './chains.js';

const clamp100 = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// The ERC-8004 `response` is a 0..100 quality score of the seller's WORK, not confidence in the
// verdict. A confident FAIL is bad work → a LOW score, so we map by outcome (never by raw confidence):
//   release → confidence-scaled goodness · partial → the released proportion (bps%) · refund/abstain → 0.
export function responseScore(v: VerdictResult, settlement: Settlement): number {
  switch (settlement.outcome) {
    case 'release': return clamp100((v.confidence ?? 0) * 100);
    case 'partial': return clamp100((settlement.bps ?? 0) / 100);
    case 'refund':
    case 'abstain':
    default: return 0;
  }
}

// requestHash keys the validation in the registry. Bind it to the exact settlement (workId + the Arc
// settle tx) so re-attesting a different settlement can't collide, and the same settlement is idempotent.
export function deriveRequestHash(workId: `0x${string}`, settleTxHash: string): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }],
    [workId, settleTxHash as `0x${string}`],
  ));
}

export interface Erc8004EvidenceBundle {
  schema: 'verdikt.validation.v1';
  workId: `0x${string}`;
  outcome: Settlement['outcome'];
  verdict: VerdictResult['verdict'];
  verdictCode: number;
  response: number;                 // 0..100 work-quality score (== on-chain response)
  confidence: number;               // verdict confidence 0..1
  route: VerdictResult['route'];
  bps?: number;                     // partial settlements only
  rationale: string;                // the verdict's own reasoning (no user PII)
  citedEvidence: string[];          // evidence ids the verdict cited
  verifyEvidenceHash: `0x${string}`;// keccak of the verification bundle, anchored on Arc at settle
  validator: `0x${string}`;         // Verdikt's ERC-8004 validator/attestor
  settlement: {
    chain: 'arc-testnet';
    chainId: number;
    txHash: string;                 // the Arc settlement tx (Gate D1: must be present)
    explorerUrl: string;
  };
}

export interface Erc8004Attestation {
  requestHash: `0x${string}`;
  responseHash: `0x${string}`;
  responseURI: string;
  requestURI: string;
  tag: string;                      // "verdikt:<outcome>"
  response: number;
  bundle: Erc8004EvidenceBundle;
  bundleJson: string;               // canonical serialization hashed into responseHash
}

// Canonical JSON with a FIXED key order → a stable, reproducible responseHash. (Objects here are
// built in a fixed literal order, and JSON.stringify preserves string-key insertion order in JS.)
function canonicalJson(bundle: Erc8004EvidenceBundle): string {
  return JSON.stringify(bundle);
}

export function buildAttestation(params: {
  verdict: VerdictResult;
  settlement: Settlement;
  task: Task;
  validator: `0x${string}`;
  baseUrl: string;                  // worker public origin serving /evidence
}): Erc8004Attestation {
  const { verdict, settlement, validator } = params;
  const response = responseScore(verdict, settlement);
  const requestHash = deriveRequestHash(settlement.workId, settlement.txHash);

  const bundle: Erc8004EvidenceBundle = {
    schema: 'verdikt.validation.v1',
    workId: settlement.workId,
    outcome: settlement.outcome,
    verdict: verdict.verdict,
    verdictCode: settlement.verdictCode,
    response,
    confidence: verdict.confidence,
    route: verdict.route,
    ...(settlement.bps !== undefined ? { bps: settlement.bps } : {}),
    rationale: verdict.rationale,
    citedEvidence: verdict.citedEvidence,
    verifyEvidenceHash: settlement.evidenceHash,
    validator,
    settlement: {
      chain: 'arc-testnet',
      chainId: ARC_CHAIN_ID,
      txHash: settlement.txHash,
      explorerUrl: `${ARC_EXPLORER}/tx/${settlement.txHash}`,
    },
  };

  const bundleJson = canonicalJson(bundle);
  const responseHash = keccak256(toBytes(bundleJson));
  const base = params.baseUrl.replace(/\/+$/, '');
  const responseURI = `${base}/evidence/${requestHash}.json`;

  return {
    requestHash,
    responseHash,
    responseURI,
    requestURI: responseURI,        // self-contained: the request references the same evidence doc
    tag: `verdikt:${settlement.outcome}`,
    response,
    bundle,
    bundleJson,
  };
}
