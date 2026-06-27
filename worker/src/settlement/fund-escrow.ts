import { createWalletClient, createPublicClient, http, parseUnits, encodeFunctionData, keccak256, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, ARC_USDC_ADDRESS } from '../lib/chains.js';
import { VERDIKT_ESCROW_ABI } from './escrow-abi.js';

// USDC EIP-712 domain. CONFIRM name/version on-chain via name()/version() before relying.
const USDC_DOMAIN = {
  name: process.env.USDC_EIP712_NAME ?? 'USD Coin',
  version: process.env.USDC_EIP712_VERSION ?? '2',
  chainId: 5042002,
  verifyingContract: ARC_USDC_ADDRESS,
} as const;

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// Fund a task's escrow via an EIP-3009 authorization the payer signs. The nonce is
// derived from (workId, worker, amount, payer) — identical to the contract — so the
// signed authorization is bound to this exact task and cannot be rebound by a front-runner.
export async function fundEscrow(params: {
  payerKey: `0x${string}`;
  workId: `0x${string}`;
  worker: `0x${string}`;
  amountUsdc: number;
}): Promise<`0x${string}`> {
  const account = privateKeyToAccount(params.payerKey);
  const escrow = process.env.ESCROW_ADDRESS as `0x${string}`;
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
  const pub = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });

  const value = parseUnits(params.amountUsdc.toFixed(6), 6);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - 600n;
  const validBefore = now + 3600n;

  // Derived nonce — must equal keccak256(abi.encode(workId, worker, amount, payer)) in the contract.
  const nonce = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }],
      [params.workId, params.worker, value, account.address],
    ),
  );

  const signature = await wallet.signTypedData({
    account,
    domain: USDC_DOMAIN,
    types: TRANSFER_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: { from: account.address, to: escrow, value, validAfter, validBefore, nonce },
  });

  // The payer submits fundWithAuthorization; the contract pulls USDC via the signature.
  const data = encodeFunctionData({
    abi: VERDIKT_ESCROW_ABI,
    functionName: 'fundWithAuthorization',
    args: [params.workId, params.worker, value, validAfter, validBefore, signature],
  });
  const hash = await wallet.sendTransaction({ to: escrow, data });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
  if (receipt.status !== 'success') throw new Error('fundWithAuthorization reverted');
  return hash;
}
