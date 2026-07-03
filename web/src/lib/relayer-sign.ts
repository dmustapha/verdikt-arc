import { keccak256, encodeAbiParameters, parseUnits } from 'viem';

// WS7 browser signing recipe — MUST stay in lockstep with:
//   contracts/src/VerdiktEscrow.sol  (fundWithAuthorizationFor nonce)
//   worker/src/routes/relayer.ts     (deriveNonce / verifyRelayerAuth)
//   worker/src/settlement/fund-escrow.ts (USDC_DOMAIN / RECEIVE_TYPES)
// The human signs an EIP-3009 ReceiveWithAuthorization in-browser (from = the human) and a gasless
// relayer submits it. The payout `routes` are folded into the nonce, so the relayer can never redirect
// the money — the signature only recovers to the payer for the exact routes the human signed.

export const ARC_CHAIN_ID = 5042002;
export const ARC_USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;

// Arc USDC's on-chain EIP-712 domain: name()="USDC", version()="2" (verified on-chain; NOT "USD Coin").
export const USDC_DOMAIN = {
  name: process.env.NEXT_PUBLIC_USDC_EIP712_NAME ?? 'USDC',
  version: process.env.NEXT_PUBLIC_USDC_EIP712_VERSION ?? '2',
  chainId: ARC_CHAIN_ID,
  verifyingContract: ARC_USDC_ADDRESS,
} as const;

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

export interface Routes {
  workerDomain: number; workerRecipient: `0x${string}`;
  payerDomain: number; payerRecipient: `0x${string}`;
}

// Local (Arc) payout: recipient 0 pays the on-chain worker/payer directly on Arc. The human path
// settles on Arc; cross-chain seller payout (routes.workerDomain != 0) is supported by the same
// signature path and covered by WS9's corridor matrix.
export const LOCAL_ROUTES: Routes = {
  workerDomain: 0, workerRecipient: `0x${'00'.repeat(32)}`,
  payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}`,
};

const ROUTES_ABI = {
  type: 'tuple',
  components: [
    { name: 'workerDomain', type: 'uint32' }, { name: 'workerRecipient', type: 'bytes32' },
    { name: 'payerDomain', type: 'uint32' }, { name: 'payerRecipient', type: 'bytes32' },
  ],
} as const;

// keccak256(abi.encode(workId, worker, amount, fee, ttl, payer, routes)) — identical to the contract.
export function deriveNonce(p: {
  workId: `0x${string}`; worker: `0x${string}`; amount: bigint; fee: bigint; ttl: bigint;
  payer: `0x${string}`; routes: Routes;
}): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'address' }, ROUTES_ABI,
    ],
    [p.workId, p.worker, p.amount, p.fee, p.ttl, p.payer, p.routes],
  ));
}

export interface RelayerFundBody {
  payer: `0x${string}`; workId: `0x${string}`; worker: `0x${string}`;
  amount: string; fee: string; ttl: string; validAfter: string; validBefore: string;
  signature: `0x${string}`; routes: Routes;
}

// Build the EIP-712 typed-data the wallet signs + the exact bigints, so the caller can assemble the
// /relayer/fund body after signing. escrow is the verifyingContract-adjacent `to` (the escrow address).
export function buildAuthorization(p: {
  escrow: `0x${string}`; payer: `0x${string}`; workId: `0x${string}`; worker: `0x${string}`;
  totalUsdc: number; feeUsdc: number; ttlSeconds?: number; routes?: Routes;
}): {
  typedData: { domain: typeof USDC_DOMAIN; types: typeof RECEIVE_TYPES; primaryType: 'ReceiveWithAuthorization'; message: Record<string, unknown> };
  amount: bigint; fee: bigint; ttl: bigint; validAfter: bigint; validBefore: bigint; routes: Routes;
} {
  const routes = p.routes ?? LOCAL_ROUTES;
  const amount = parseUnits(p.totalUsdc.toFixed(6), 6);
  const fee = parseUnits(p.feeUsdc.toFixed(6), 6);
  const ttl = BigInt(p.ttlSeconds ?? 3600);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - 600n;
  const validBefore = now + 3600n;
  const nonce = deriveNonce({ workId: p.workId, worker: p.worker, amount, fee, ttl, payer: p.payer, routes });
  return {
    typedData: {
      domain: USDC_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization',
      message: { from: p.payer, to: p.escrow, value: amount, validAfter, validBefore, nonce },
    },
    amount, fee, ttl, validAfter, validBefore, routes,
  };
}

// Assemble the POST body for /api/relayer/fund once the wallet returns a signature.
export function fundBody(p: {
  payer: `0x${string}`; workId: `0x${string}`; worker: `0x${string}`;
  amount: bigint; fee: bigint; ttl: bigint; validAfter: bigint; validBefore: bigint;
  signature: `0x${string}`; routes: Routes;
}): RelayerFundBody {
  return {
    payer: p.payer, workId: p.workId, worker: p.worker, signature: p.signature, routes: p.routes,
    amount: p.amount.toString(), fee: p.fee.toString(), ttl: p.ttl.toString(),
    validAfter: p.validAfter.toString(), validBefore: p.validBefore.toString(),
  };
}
