import type { VerdictResult, Settlement, Outcome } from '../types.js';
import { executeContractCall, waitForTxHash } from '../lib/circle-wallets.js';
import { SETTLE_FN_SIGNATURE } from './escrow-abi.js';

// pass → release(worker); fail|partial → refund(payer); abstain → abstain-default(payer).
export function outcomeFor(v: VerdictResult): Outcome {
  if (v.verdict === 'pass') return 'release';
  if (v.verdict === 'abstain') return 'abstain';
  return 'refund'; // fail | partial
}

// v5 settle() REJECTS verdictCode==2 (partial) — that path must go through settlePartial() with a
// real bps split. Until the confidence->bps tier is wired (WS2), a 'partial' verdict is settled via
// settle() as a refund (code 1) so the buyer is made whole and the tx never reverts. This matches v4
// behavior and outcomeFor()'s partial->refund. WS2 replaces this with a settlePartial() call.
export function onChainSettleCode(verdictCode: number): number {
  return verdictCode === 2 ? 1 : verdictCode;
}

export async function settleVerdict(workId: `0x${string}`, v: VerdictResult): Promise<Settlement> {
  const outcome = outcomeFor(v);
  const escrow = process.env.ESCROW_ADDRESS!;

  // M-3: outcome is derived on-chain from verdictCode — we no longer pass it. outcomeFor() is kept
  // only for the off-chain Settlement record / DB / SSE display, and MUST agree with the contract's
  // derivation (pass->release, abstain->abstain, fail->refund). onChainSettleCode() guards the v5
  // partial-code rejection (see its doc comment).
  const circleTxId = await executeContractCall({
    contractAddress: escrow,
    abiFunctionSignature: SETTLE_FN_SIGNATURE, // settle(bytes32,uint8,bytes32)
    abiParameters: [workId, onChainSettleCode(v.verdictCode), v.evidenceHash],
  });

  const txHash = await waitForTxHash(circleTxId);
  if (!txHash) {
    // No fabricated hash. Surface the failure to the caller; the run is marked errored.
    throw new Error(`settlement did not confirm (circleTxId=${circleTxId})`);
  }

  return { workId, outcome, verdictCode: v.verdictCode, evidenceHash: v.evidenceHash, txHash, circleTxId };
}
