// Public SDK types. Kept deliberately small and mirrored from the worker contract so an integrating
// agent depends only on @verdikt/sdk, never on the worker internals.

export type ArtifactType = 'code' | 'tool_output' | 'answer' | 'execution' | 'tool_trace';
export type VerdictLabel = 'pass' | 'fail' | 'partial' | 'abstain';
export type Outcome = 'release' | 'refund' | 'abstain' | 'partial';

// execution route: an on-chain effect to verify. The artifact is a tx hash on `chainId`; the verifier
// reads the receipt and checks these deterministically. On-chain slice only.
export interface ExecutionCriteria {
  chainId: number;
  status?: 'success' | 'reverted';
  to?: string;
  from?: string;
  minValueWei?: string;
  log?: { topic0: string; address?: string; topics?: (string | null)[] };
}

// tool_trace route: a declared tool-call schema the self-reported trace must conform to. Verifies the
// claimed trace's shape, not that the tool executed.
export interface ToolTraceCriteria {
  jsonSchema: Record<string, unknown>;
  perCall?: boolean;
}

// What the PAYER commits to up front. Exactly one of tests / schema / sources / execution / toolTrace
// is meaningful per type.
export interface Acceptance {
  spec: string;
  tests?: string;                              // code route: payer pytest file contents
  schema?: Record<string, SchemaField>;        // tool_output route: payer JSON schema
  minResponseBytes?: number;                    // tool_output route
  sources?: string;                             // answer route: payer source text
  execution?: ExecutionCriteria;                // execution route: on-chain effect to verify
  toolTrace?: ToolTraceCriteria;                // tool_trace route: declared tool schema
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
  status: 'released' | 'refunded' | 'abstained' | 'partial';
  verdict: VerdictLabel;
  outcome: Outcome;
  workId: `0x${string}`;
  settlementTx: string | null;
  feeUsdc: number;            // what the seller was actually charged (0 on abstain)
  bps?: number;               // on a partial split: the worker's share in basis points (1..9999)
  evidenceHash?: `0x${string}`;
}

// A live step from the verdict engine (route_selected / evidence_item / verdict / settling / settled
// / error). Surfaced via seller.submit({ onStep }) so an agent can narrate the verdict as it happens.
export interface VerdictStep {
  type: string;
  workId?: `0x${string}`;
  data: Record<string, unknown>;
  ts?: number;
}

export interface VerdiktConfig {
  endpoint: string;                  // verdikt-worker base URL
  chain?: 'arc-testnet';             // chainId 5042002 (only supported chain today)
  rpcUrl?: string;                   // Arc RPC (defaults to public)
  facilitator?: string;             // Circle Gateway facilitator (defaults to testnet)
}
