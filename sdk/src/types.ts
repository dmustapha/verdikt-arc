// Public SDK types. Kept deliberately small and mirrored from the worker contract so an integrating
// agent depends only on @verdikt/sdk, never on the worker internals.

export type ArtifactType = 'code' | 'tool_output' | 'answer';
export type VerdictLabel = 'pass' | 'fail' | 'partial' | 'abstain';
export type Outcome = 'release' | 'refund' | 'abstain';

// What the PAYER commits to up front. Exactly one of tests / schema / sources is meaningful per type.
export interface Acceptance {
  spec: string;
  tests?: string;                              // code route: payer pytest file contents
  schema?: Record<string, SchemaField>;        // tool_output route: payer JSON schema
  minResponseBytes?: number;                    // tool_output route
  sources?: string;                             // answer route: payer source text
}

export interface SchemaField {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  enum?: string[];
  min?: number;
  max?: number;
}

// What the SELLER delivers.
export interface Artifact {
  type: ArtifactType;
  payload: string;
  language?: 'python' | 'typescript';
}

// The signed job-ticket a payer hands an independent seller (see lib/task-offer.ts on the worker).
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
  expiresAt: number;
}

export interface SignedTaskOffer {
  offer: TaskOffer;
  signature: `0x${string}`;
}

// The terminal result of a verdict run, surfaced as a typed union the caller switches on.
export interface VerdictResult {
  status: 'released' | 'refunded' | 'abstained';
  verdict: VerdictLabel;
  outcome: Outcome;
  workId: `0x${string}`;
  settlementTx: string | null;
  feeUsdc: number;            // what the seller was actually charged (0 on abstain)
  evidenceHash?: `0x${string}`;
}

export interface VerdiktConfig {
  endpoint: string;                  // verdikt-worker base URL
  chain?: 'arc-testnet';             // chainId 5042002 (only supported chain today)
  rpcUrl?: string;                   // Arc RPC (defaults to public)
  facilitator?: string;             // Circle Gateway facilitator (defaults to testnet)
}
