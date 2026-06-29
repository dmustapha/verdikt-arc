import {
  createWalletClient, createPublicClient, http, parseUnits, encodeFunctionData,
  keccak256, encodeAbiParameters, defineChain,
} from 'viem';
import type { Account } from 'viem';

export const ARC_CHAIN_ID = 5042002;
export const ARC_USDC = '0x3600000000000000000000000000000000000000' as const;
export const DEFAULT_RPC = 'https://rpc.testnet.arc.network';

export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC] } },
  testnet: true,
});

// Payout-routes tuple mirrors VerdiktEscrow.PayoutRoutes (worker/payer cross-chain payout).
const PAYOUT_ROUTES_TUPLE = {
  name: 'routes', type: 'tuple', components: [
    { name: 'workerDomain', type: 'uint32' }, { name: 'workerRecipient', type: 'bytes32' },
    { name: 'payerDomain', type: 'uint32' }, { name: 'payerRecipient', type: 'bytes32' },
  ],
} as const;

// Minimal escrow ABI: fund (EIP-3009 receiveWithAuthorization path) + read.
const ESCROW_ABI = [
  {
    type: 'function', name: 'fundWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'workId', type: 'bytes32' }, { name: 'worker', type: 'address' },
      { name: 'amount', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'sig', type: 'bytes' },
      PAYOUT_ROUTES_TUPLE,
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'getEscrow', stateMutability: 'view',
    inputs: [{ name: 'workId', type: 'bytes32' }],
    outputs: [{
      type: 'tuple', components: [
        { name: 'payer', type: 'address' }, { name: 'worker', type: 'address' }, { name: 'amount', type: 'uint256' },
        { name: 'status', type: 'uint8' }, { name: 'outcome', type: 'uint8' }, { name: 'verdictCode', type: 'uint8' },
        { name: 'evidenceHash', type: 'bytes32' },
        { name: 'workerPayoutDomain', type: 'uint32' }, { name: 'workerPayoutRecipient', type: 'bytes32' },
        { name: 'payerPayoutDomain', type: 'uint32' }, { name: 'payerPayoutRecipient', type: 'bytes32' },
      ],
    }],
  },
] as const;

// EIP-3009 ReceiveWithAuthorization typed-data (6 fields; the escrow redeems it, msg.sender==to).
const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
} as const;

function rpc(rpcUrl?: string) { return http(rpcUrl ?? DEFAULT_RPC); }

export interface EscrowState {
  payer: `0x${string}`; worker: `0x${string}`; amount: bigint;
  status: number; outcome: number; verdictCode: number; evidenceHash: `0x${string}`;
  workerPayoutDomain: number; workerPayoutRecipient: `0x${string}`;
  payerPayoutDomain: number; payerPayoutRecipient: `0x${string}`;
}

// Raw payout-routes tuple passed to fundWithAuthorization (local = all zero).
export interface RawPayoutRoutes {
  workerDomain: number; workerRecipient: `0x${string}`;
  payerDomain: number; payerRecipient: `0x${string}`;
}
const LOCAL_ROUTES: RawPayoutRoutes = {
  workerDomain: 0, workerRecipient: `0x${'00'.repeat(32)}`,
  payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}`,
};

export async function readEscrow(escrow: `0x${string}`, workId: `0x${string}`, rpcUrl?: string): Promise<EscrowState> {
  const pub = createPublicClient({ chain: arcTestnet, transport: rpc(rpcUrl) });
  const e = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: 'getEscrow', args: [workId] });
  return e as EscrowState;
}

// PAYER funds the escrow: sign an EIP-3009 ReceiveWithAuthorization, then submit fundWithAuthorization.
// The nonce is derived identically to the contract so the authorization is bound to this exact task.
// Arc USDC's EIP-712 domain: the on-chain name() is "USDC" and version() is "2" (verified on-chain).
// Overridable in case Circle rotates them, but these are the correct defaults for Arc testnet.
const USDC_EIP712_NAME = 'USDC';
const USDC_EIP712_VERSION = '2';

export async function fundEscrow(params: {
  account: Account;
  escrow: `0x${string}`;
  workId: `0x${string}`;
  seller: `0x${string}`;
  amountUsdc: number;
  rpcUrl?: string;
  nowMs: number;            // injected for determinism/testability
  usdcName?: string;
  usdcVersion?: string;
  routes?: RawPayoutRoutes; // optional cross-chain payout routes (default: local Arc)
}): Promise<`0x${string}`> {
  const { account } = params;
  if (!account.signTypedData) throw new Error('signer cannot sign typed data');
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: rpc(params.rpcUrl) });
  const pub = createPublicClient({ chain: arcTestnet, transport: rpc(params.rpcUrl) });

  const value = parseUnits(params.amountUsdc.toFixed(6), 6);
  const now = BigInt(Math.floor(params.nowMs / 1000));
  const validAfter = now - 600n;
  const validBefore = now + 3600n;

  const nonce = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }],
    [params.workId, params.seller, value, account.address],
  ));

  const signature = await account.signTypedData({
    domain: {
      name: params.usdcName ?? USDC_EIP712_NAME,
      version: params.usdcVersion ?? USDC_EIP712_VERSION,
      chainId: ARC_CHAIN_ID, verifyingContract: ARC_USDC,
    },
    types: RECEIVE_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: { from: account.address, to: params.escrow, value, validAfter, validBefore, nonce },
  });

  const data = encodeFunctionData({
    abi: ESCROW_ABI, functionName: 'fundWithAuthorization',
    args: [params.workId, params.seller, value, validAfter, validBefore, signature, params.routes ?? LOCAL_ROUTES],
  });
  const hash = await wallet.sendTransaction({ to: params.escrow, data });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
  if (receipt.status !== 'success') throw new Error('fundWithAuthorization reverted');
  return hash;
}
