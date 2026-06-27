import { createPublicClient, http } from 'viem';
import { arcTestnet } from './chains';

const VERDIKT_ESCROW_ABI = [{
  type: 'function', name: 'getEscrow', stateMutability: 'view',
  inputs: [{ name: 'workId', type: 'bytes32' }],
  outputs: [{ type: 'tuple', components: [
    { name: 'payer', type: 'address' }, { name: 'worker', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'status', type: 'uint8' }, { name: 'outcome', type: 'uint8' }, { name: 'verdictCode', type: 'uint8' },
    { name: 'evidenceHash', type: 'bytes32' }] }],
}] as const;

const client = createPublicClient({ chain: arcTestnet, transport: http() });

export async function readOnchainEscrow(workId: `0x${string}`) {
  return client.readContract({
    address: process.env.NEXT_PUBLIC_ESCROW_ADDRESS as `0x${string}`,
    abi: VERDIKT_ESCROW_ABI, functionName: 'getEscrow', args: [workId],
  });
}
