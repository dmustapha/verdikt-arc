// All shared worker types. Order: enums → contract/artifact → evidence → verdict → receipt → SSE.

export type ArtifactType = 'code' | 'tool_output' | 'answer';
export type VerdictLabel = 'pass' | 'fail' | 'partial' | 'abstain';
export type Outcome = 'release' | 'refund' | 'abstain' | 'partial';

// verdictCode (on-chain uint8): pass=0 fail=1 partial=2 abstain=3
export const VERDICT_CODE: Record<VerdictLabel, number> = { pass: 0, fail: 1, partial: 2, abstain: 3 };
// outcome (on-chain uint8): release=0 refund=1 abstain-default=2 partial=3
// (partial is a real bps split — worker gets bounty*bps/1e4, payer keeps the remainder; WS2.)
export const OUTCOME_CODE: Record<Outcome, number> = { release: 0, refund: 1, abstain: 2, partial: 3 };

// ── Payer criteria (travels with the escrowed task) ──────────────────────────
export interface SchemaField {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  enum?: string[];
  min?: number;
  max?: number;
  format?: string;                           // E1: ajv-formats (email, uri, date-time, uuid, ...)
  pattern?: string;                          // E1: regex the string value must match
}

export interface Acceptance {
  spec: string;                              // human description of "good"
  tests?: string;                            // code route: payer pytest file contents
  schema?: Record<string, SchemaField>;      // tool_output route: payer field map (simple form)
  jsonSchema?: Record<string, unknown>;      // tool_output route: full JSON Schema draft 2020-12 (E1)
  minResponseBytes?: number;                 // tool_output route
  sources?: string;                          // answer route: payer source text
}

export interface Task {
  workId: `0x${string}`;
  type: ArtifactType;
  acceptance: Acceptance;
  payer: `0x${string}`;
  worker: `0x${string}`;
  amountUsdc: number;
}

// ── Worker delivery ──────────────────────────────────────────────────────────
export interface Artifact {
  type: ArtifactType;
  payload: string;                           // code source / JSON string / answer text
  language?: 'python' | 'typescript';        // code route only
}

// ── Evidence (typed, hashable) ───────────────────────────────────────────────
export type EvidenceKind = 'test' | 'static' | 'schema_check' | 'span';
export type EvidenceStatus = 'pass' | 'fail' | 'error' | 'info';

export interface EvidenceItem {
  id: string;                                // stable id the reasoner must cite, e.g. "test:test_parameterized"
  kind: EvidenceKind;
  label: string;
  status: EvidenceStatus;
  detail: string;
  ref?: string;                              // file:line / nodeid / source span
}

export interface EvidenceBundle {
  route: ArtifactType;
  items: EvidenceItem[];
  routeError?: string;                       // set when a tool errored / inputs missing → reasoner must abstain
}

// ── Verdict ──────────────────────────────────────────────────────────────────
export interface VerdictResult {
  verdict: VerdictLabel;
  confidence: number;                        // 0..1
  score?: number;                            // 0..100 tier signal = round(confidence*100); sizes partial bps
  citedEvidence: string[];                   // ids from the bundle
  rationale: string;
  abstainReason?: string;
  route: ArtifactType;
  evidenceHash: `0x${string}`;               // keccak256 of canonical bundle (anchored on-chain)
  verdictCode: number;
}

export interface Settlement {
  workId: `0x${string}`;
  outcome: Outcome;
  verdictCode: number;
  evidenceHash: `0x${string}`;
  txHash: string;
  circleTxId: string;
  bps?: number;                              // set on a partial settlement (worker's share, 1..9999)
}

export interface SignedReceipt {
  workId: `0x${string}`;
  verdict: VerdictLabel;
  verdictCode: number;
  outcome: Outcome;
  evidenceHash: `0x${string}`;
  amountUsdc: number;
  txHash: string;
  signature: `0x${string}`;
}

// ── SSE courtroom events ─────────────────────────────────────────────────────
export type SSEType =
  | 'task_funded' | 'artifact_received' | 'route_selected'
  | 'evidence_item' | 'verdict' | 'settling' | 'settled'
  | 'receipt' | 'error';

export interface SSEEvent {
  type: SSEType;
  workId: `0x${string}`;
  data: unknown;
  ts: number;
}
