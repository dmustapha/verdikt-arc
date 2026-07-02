import { executeContractCall, waitForTxHash } from '../lib/circle-wallets.js';
import { REFUND_EXPIRED_FN_SIGNATURE } from './escrow-abi.js';

// No-show refund. Past the escrow deadline, the verdict wallet (Circle DCW) calls refundExpired to
// return the buyer's funds via their payout route. v5 restricts this to payer-or-verdict (WS1
// hardening), and the escrow's FUNDED-once invariant means it reverts if a settle already fired — so
// this is safe to attempt even in a race with settlement (the chain is the definitive guard).
export async function refundExpiredOnChain(workId: `0x${string}`): Promise<string> {
  const escrow = process.env.ESCROW_ADDRESS;
  if (!escrow) throw new Error('ESCROW_ADDRESS not configured');
  const circleTxId = await executeContractCall({
    contractAddress: escrow,
    abiFunctionSignature: REFUND_EXPIRED_FN_SIGNATURE,
    abiParameters: [workId],
  });
  const txHash = await waitForTxHash(circleTxId);
  if (!txHash) throw new Error(`refundExpired did not confirm (circleTxId=${circleTxId})`);
  return txHash;
}
