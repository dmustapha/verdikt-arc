import { createPublicClient, http } from 'viem';
import { arcTestnet } from '../lib/chains.js';
import { VERDIKT_ESCROW_ABI } from './escrow-abi.js';

// Mirrors the v5 getEscrow() tuple (13 fields). viem decodes the ABI tuple into this named shape.
export interface OnChainEscrow {
  payer: `0x${string}`; worker: `0x${string}`; amount: bigint; fee: bigint; deadline: bigint;
  status: number; outcome: number; verdictCode: number; evidenceHash: `0x${string}`;
  workerPayoutDomain: number; workerPayoutRecipient: `0x${string}`;
  payerPayoutDomain: number; payerPayoutRecipient: `0x${string}`;
}

// Read the escrow straight from the chain — the source of truth. Used to reconcile escrows that an
// independent payer funded directly (e.g. via the SDK) without the worker recording the funding.
export async function readEscrowOnChain(workId: `0x${string}`): Promise<OnChainEscrow> {
  const pub = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
  const e = await pub.readContract({
    address: process.env.ESCROW_ADDRESS as `0x${string}`,
    abi: VERDIKT_ESCROW_ABI, functionName: 'getEscrow', args: [workId],
  });
  return e as OnChainEscrow;
}
