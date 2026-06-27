import { createPublicClient, http } from 'viem';
import { arcTestnet } from '../lib/chains.js';
import { VERDIKT_ESCROW_ABI } from './escrow-abi.js';

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });

export async function readEscrow(workId: `0x${string}`) {
  return publicClient.readContract({
    address: process.env.ESCROW_ADDRESS as `0x${string}`,
    abi: VERDIKT_ESCROW_ABI,
    functionName: 'getEscrow',
    args: [workId],
  });
}
