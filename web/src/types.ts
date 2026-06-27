export type VerdictLabel = 'pass' | 'fail' | 'partial' | 'abstain';
export type Outcome = 'release' | 'refund' | 'abstain';

export interface LedgerRow {
  workId: string;
  type: 'code' | 'tool_output' | 'answer';
  verdict: VerdictLabel;
  outcome: Outcome;
  amountUsdc: number;
  evidenceHash: string;
  txHash: string | null;
  citedEvidence: string[];
  createdAt: string;
}

export interface EvidenceItem {
  id: string;
  kind: 'test' | 'static' | 'schema_check' | 'span';
  label: string;
  status: 'pass' | 'fail' | 'error' | 'info';
  detail: string;
  ref?: string;
}

export interface ProofArtifact {
  escrowAddress: string;
  chainId: number;
  explorer: string;
  rows: LedgerRow[];
  externalCalls: number;
}
