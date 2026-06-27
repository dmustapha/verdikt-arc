import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import type { Settlement, VerdictResult, SignedReceipt } from '../types.js';

export async function buildReceipt(
  settlement: Settlement,
  verdict: VerdictResult,
  amountUsdc: number,
): Promise<SignedReceipt> {
  const account = privateKeyToAccount(process.env.RECEIPT_SIGNER_KEY as `0x${string}`);

  const unsigned = {
    workId: settlement.workId,
    verdict: verdict.verdict,
    verdictCode: verdict.verdictCode,
    outcome: settlement.outcome,
    evidenceHash: verdict.evidenceHash,
    amountUsdc,
    txHash: settlement.txHash,
  };

  // Sign the digest of the canonical receipt; anyone can verify the signer and then
  // confirm evidenceHash/outcome/amount against the on-chain Settled event.
  const digest = keccak256(toBytes(JSON.stringify(unsigned)));
  const signature = await account.signMessage({ message: { raw: digest } });

  return { ...unsigned, signature };
}
