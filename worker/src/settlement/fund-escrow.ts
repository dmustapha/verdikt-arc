import { createWalletClient, createPublicClient, http, parseUnits, encodeFunctionData, keccak256, encodeAbiParameters, pad } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, ARC_USDC_ADDRESS } from '../lib/chains.js';
import { VERDIKT_ESCROW_ABI } from './escrow-abi.js';

// USDC EIP-712 domain. Arc USDC reports name()="USDC" (NOT "USD Coin") and version()="2"; the wrong
// name yields "FiatTokenV2: invalid signature" at funding. The fallback is the confirmed on-chain
// value so a missing env var can never silently break funding.
export const USDC_DOMAIN = {
  name: process.env.USDC_EIP712_NAME ?? 'USDC',
  version: process.env.USDC_EIP712_VERSION ?? '2',
  chainId: 5042002,
  verifyingContract: ARC_USDC_ADDRESS,
} as const;

// H-1: sign a ReceiveWithAuthorization (not TransferWithAuthorization). The 6 fields are identical;
// only the EIP-712 primaryType/typehash differs. receiveWithAuthorization forces msg.sender == to at
// the token, so the escrow is the only account that can redeem this signature — front-run closed.
export const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// Local (Arc) payout routes — recipient 0 pays the on-chain party on Arc.
const LOCAL_ROUTES = {
  workerDomain: 0,
  workerRecipient: `0x${'00'.repeat(32)}` as `0x${string}`,
  payerDomain: 0,
  payerRecipient: `0x${'00'.repeat(32)}` as `0x${string}`,
} as const;

// Default no-show deadline horizon: 7 days.
const DEFAULT_TTL_SECONDS = 604800;

// Fund a task's escrow via an EIP-3009 authorization the payer signs. The nonce is derived from
// (workId, worker, amount, fee, ttl, payer) — identical to the contract (v5) — so the signed
// authorization is bound to this exact task AND its economics, and cannot be rebound by a front-runner.
export async function fundEscrow(params: {
  payerKey: `0x${string}`;
  workId: `0x${string}`;
  worker: `0x${string}`;
  amountUsdc: number;       // TOTAL escrowed (bounty + fee)
  feeUsdc?: number;         // verdict fee subset (default 0)
  ttlSeconds?: number;      // no-show deadline horizon (default 7 days)
  // Cross-chain worker payout route (default = local Arc). When domain != 0, release BURNS the bounty
  // via CCTP to `recipient` on that CCTP domain (the seller's home chain); a relayer then mints it there.
  sellerPayout?: { domain: number; recipient: `0x${string}` };
}): Promise<`0x${string}`> {
  const account = privateKeyToAccount(params.payerKey);
  const escrow = process.env.ESCROW_ADDRESS as `0x${string}`;
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
  const pub = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });

  const value = parseUnits(params.amountUsdc.toFixed(6), 6);
  const fee = parseUnits((params.feeUsdc ?? 0).toFixed(6), 6);
  const ttl = BigInt(params.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - 600n;
  const validBefore = now + 3600n;

  // Derived nonce — must equal keccak256(abi.encode(workId, worker, amount, fee, ttl, payer)).
  const nonce = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
      [params.workId, params.worker, value, fee, ttl, account.address],
    ),
  );

  const signature = await wallet.signTypedData({
    account,
    domain: USDC_DOMAIN,
    types: RECEIVE_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: { from: account.address, to: escrow, value, validAfter, validBefore, nonce },
  });

  // Payout routes: local Arc by default, or a cross-chain worker route when sellerPayout.domain != 0
  // (release burns the bounty to that CCTP domain; the payer refund route always stays local on Arc).
  const routes = params.sellerPayout && params.sellerPayout.domain !== 0
    ? { workerDomain: params.sellerPayout.domain, workerRecipient: pad(params.sellerPayout.recipient), payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}` as `0x${string}` }
    : LOCAL_ROUTES;

  // The payer submits fundWithAuthorization; the contract pulls USDC via the signature.
  const data = encodeFunctionData({
    abi: VERDIKT_ESCROW_ABI,
    functionName: 'fundWithAuthorization',
    args: [params.workId, params.worker, value, fee, ttl, validAfter, validBefore, signature, routes],
  });
  const hash = await wallet.sendTransaction({ to: escrow, data });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
  if (receipt.status !== 'success') throw new Error('fundWithAuthorization reverted');
  return hash;
}
