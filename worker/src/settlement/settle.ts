import type { VerdictResult, Settlement, Outcome } from '../types.js';
import { executeContractCall, waitForTxHash } from '../lib/circle-wallets.js';
import { SETTLE_FN_SIGNATURE, SETTLE_PARTIAL_FN_SIGNATURE } from './escrow-abi.js';
import { planSettlement, outcomeForAction } from './tiers.js';

// The off-chain Outcome for a verdict (release / refund / abstain / partial). Derived from the SAME
// planSettlement() the on-chain call uses, so the DB/SSE label can never disagree with what settled.
export function outcomeFor(v: VerdictResult): Outcome {
  return outcomeForAction(planSettlement(v));
}

// The bps a partial verdict settles at (0 for a non-partial). Surfaced to the SSE/SDK/UI.
export function bpsFor(v: VerdictResult): number {
  const a = planSettlement(v);
  return a.kind === 'settlePartial' ? a.bps : 0;
}

export async function settleVerdict(workId: `0x${string}`, v: VerdictResult): Promise<Settlement> {
  const escrow = process.env.ESCROW_ADDRESS!;
  const action = planSettlement(v);
  const outcome = outcomeForAction(action);

  // Confidence tiers → the on-chain call. pass/fail/abstain → settle(bytes32,uint8,bytes32); a
  // `partial` verdict → settlePartial(bytes32,uint16,bytes32) with a real, clamped bps split. v5
  // settle() REJECTS verdictCode==2 by design, so a partial is NEVER sent to settle() — the routing
  // in planSettlement() guarantees it. (WS2 retired the interim onChainSettleCode() downgrade.)
  const circleTxId = action.kind === 'settlePartial'
    ? await executeContractCall({
        contractAddress: escrow,
        abiFunctionSignature: SETTLE_PARTIAL_FN_SIGNATURE,
        abiParameters: [workId, action.bps, v.evidenceHash],
      })
    : await executeContractCall({
        contractAddress: escrow,
        abiFunctionSignature: SETTLE_FN_SIGNATURE,
        abiParameters: [workId, action.code, v.evidenceHash],
      });

  const txHash = await waitForTxHash(circleTxId);
  if (!txHash) {
    // No fabricated hash. Surface the failure to the caller; the run is marked errored.
    throw new Error(`settlement did not confirm (circleTxId=${circleTxId})`);
  }

  const bps = action.kind === 'settlePartial' ? action.bps : undefined;
  return { workId, outcome, verdictCode: v.verdictCode, evidenceHash: v.evidenceHash, txHash, circleTxId, bps };
}
