import { createPublicClient, http } from 'viem';
import { arcTestnet } from './chains';

// The FULL v6 Escrow struct — 13 fields, in on-chain order. Must mirror VerdiktEscrow.sol `Escrow`
// (and @verdikt/sdk `ESCROW_ABI` / `EscrowState`, the source of truth). Tuple decoding is POSITIONAL,
// so a short ABI silently mis-reads later fields: the old 7-field version decoded `fee` as `status`,
// `deadline` as `outcome`, and read `evidenceHash` from the wrong slot — which broke the /proof hash
// round-trip. Keep every field even if the page reads only some, so positions stay correct.
const VERDIKT_ESCROW_ABI = [{
  type: 'function', name: 'getEscrow', stateMutability: 'view',
  inputs: [{ name: 'workId', type: 'bytes32' }],
  outputs: [{ type: 'tuple', components: [
    { name: 'payer', type: 'address' }, { name: 'worker', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'fee', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    { name: 'status', type: 'uint8' }, { name: 'outcome', type: 'uint8' }, { name: 'verdictCode', type: 'uint8' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'workerPayoutDomain', type: 'uint32' }, { name: 'workerPayoutRecipient', type: 'bytes32' },
    { name: 'payerPayoutDomain', type: 'uint32' }, { name: 'payerPayoutRecipient', type: 'bytes32' }] }],
}] as const;

const client = createPublicClient({ chain: arcTestnet, transport: http() });

export interface OnchainEscrow {
  payer: `0x${string}`; worker: `0x${string}`; amount: bigint; fee: bigint; deadline: bigint;
  status: number; outcome: number; verdictCode: number; evidenceHash: `0x${string}`;
  workerPayoutDomain: number; workerPayoutRecipient: `0x${string}`;
  payerPayoutDomain: number; payerPayoutRecipient: `0x${string}`;
}

export async function readOnchainEscrow(workId: `0x${string}`): Promise<OnchainEscrow> {
  const e = await client.readContract({
    address: process.env.NEXT_PUBLIC_ESCROW_ADDRESS as `0x${string}`,
    abi: VERDIKT_ESCROW_ABI, functionName: 'getEscrow', args: [workId],
  });
  return e as OnchainEscrow;
}

// The "why Arc" proof: gas for a settle tx is paid in USDC (Arc's native asset, 18 decimals), so an
// agent holds ONE asset for earn/fund/fee/settle/gas. We read the real receipt and compute the gas
// cost in USDC (gasUsed × effectiveGasPrice). Returns null on any RPC hiccup so /proof never breaks.
export async function getTxGasUsdc(txHash: `0x${string}`): Promise<{ gasUsed: string; gasUsdc: string } | null> {
  try {
    const r = await client.getTransactionReceipt({ hash: txHash });
    const wei = r.gasUsed * r.effectiveGasPrice; // both bigint
    return { gasUsed: r.gasUsed.toString(), gasUsdc: (Number(wei) / 1e18).toFixed(6) };
  } catch {
    return null;
  }
}
