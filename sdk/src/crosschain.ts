import {
  createWalletClient, createPublicClient, http, parseUnits, pad,
  encodeAbiParameters, encodeFunctionData, defineChain,
} from 'viem';
import type { Account } from 'viem';
import { arcTestnet, DEFAULT_RPC as ARC_RPC } from './escrow.js';

// ── CCTP V2 constants (Base Sepolia → Arc) ──────────────────────────────────────────────────────
// CCTP core does NOT execute hooks: depositForBurnWithHook carries hookData as opaque metadata and
// mints USDC to mintRecipient with no callback. We set mintRecipient = destinationCaller = the Arc
// EscrowFundingHook, then relay (message, attestation) into hook.mintAndFund, which mints to itself
// and funds the escrow atomically. See contracts/src/EscrowFundingHook.sol.

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const ARC_CCTP_DOMAIN = 26;
export const BASE_SEPOLIA_CCTP_DOMAIN = 6;

// CCTP V2 testnet TokenMessengerV2 (same deterministic address across testnet chains).
export const BASE_SEPOLIA_TOKEN_MESSENGER =
  '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const;
// Circle USDC on Base Sepolia (6 decimals).
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
// Arc MessageTransmitterV2 (receiveMessage lives here; the hook calls it).
export const ARC_MESSAGE_TRANSMITTER =
  '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as const;

export const IRIS_SANDBOX = 'https://iris-api-sandbox.circle.com';
// Fast Transfer: minFinalityThreshold <= 1000 → ~8-20s, small fee. Standard (>=2000) is fee-free
// but gates on source hard finality (~15min) — too slow for a live demo.
export const FAST_FINALITY_THRESHOLD = 1000;

export const baseSepolia = defineChain({
  id: BASE_SEPOLIA_CHAIN_ID,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia.base.org'] } },
  testnet: true,
});

const ERC20_APPROVE_ABI = [{
  type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }],
  outputs: [{ type: 'bool' }],
}] as const;

const TOKEN_MESSENGER_ABI = [{
  type: 'function', name: 'depositForBurnWithHook', stateMutability: 'nonpayable',
  inputs: [
    { name: 'amount', type: 'uint256' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'mintRecipient', type: 'bytes32' },
    { name: 'burnToken', type: 'address' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' },
    { name: 'hookData', type: 'bytes' },
  ],
  outputs: [],
}] as const;

const HOOK_ABI = [{
  type: 'function', name: 'mintAndFund', stateMutability: 'nonpayable',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
  outputs: [],
}] as const;

/** Left-pad an EVM address to a CCTP bytes32 (mintRecipient / destinationCaller). */
export function addressToBytes32(addr: `0x${string}`): `0x${string}` {
  return pad(addr, { size: 32 });
}

/**
 * Encode the CCTP hookData the Arc hook decodes with abi.decode(_, (bytes32,address,address)).
 * MUST byte-match the Solidity decode — this is abi.encode(workId, payer, worker).
 */
export function encodeHookData(
  workId: `0x${string}`, payer: `0x${string}`, worker: `0x${string}`,
): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }],
    [workId, payer, worker],
  );
}

export interface CrossChainConfig {
  hook: `0x${string}`;          // Arc EscrowFundingHook
  tokenMessenger?: `0x${string}`; // Base Sepolia TokenMessengerV2
  sourceUsdc?: `0x${string}`;     // Base Sepolia USDC
  sourceRpcUrl?: string;          // Base Sepolia RPC
  arcRpcUrl?: string;             // Arc RPC
  irisBase?: string;              // Iris attestation API base
}

/**
 * Burn USDC on Base Sepolia targeting the Arc hook. approve → depositForBurnWithHook. The hookData
 * binds {workId, payer, worker}; mintRecipient and destinationCaller are both the hook (so only the
 * hook can finalize on Arc). Returns the source burn tx hash (explorer leg 1).
 */
export async function depositForBurnWithHook(params: {
  account: Account;
  amountUsdc: number;
  workId: `0x${string}`;
  payer: `0x${string}`;   // Arc-side refund recipient (must be an address the funder controls on Arc)
  worker: `0x${string}`;
  maxFeeUsdc?: number;
  minFinalityThreshold?: number;
  config: CrossChainConfig;
}): Promise<{ burnTxHash: `0x${string}` }> {
  const { account, config } = params;
  const tokenMessenger = config.tokenMessenger ?? BASE_SEPOLIA_TOKEN_MESSENGER;
  const usdc = config.sourceUsdc ?? BASE_SEPOLIA_USDC;
  const transport = http(config.sourceRpcUrl ?? 'https://sepolia.base.org');
  const wallet = createWalletClient({ account, chain: baseSepolia, transport });
  const pub = createPublicClient({ chain: baseSepolia, transport });

  const amount = parseUnits(params.amountUsdc.toFixed(6), 6);
  const maxFee = parseUnits((params.maxFeeUsdc ?? 0.05).toFixed(6), 6);
  const hookBytes32 = addressToBytes32(config.hook);
  const hookData = encodeHookData(params.workId, params.payer, params.worker);

  // 1. approve USDC to the TokenMessenger.
  const approveTx = await wallet.sendTransaction({
    to: usdc,
    data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [tokenMessenger, amount] }),
  });
  await pub.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });

  // 2. burn with hook.
  const burnTxHash = await wallet.sendTransaction({
    to: tokenMessenger,
    data: encodeFunctionData({
      abi: TOKEN_MESSENGER_ABI, functionName: 'depositForBurnWithHook',
      args: [
        amount, ARC_CCTP_DOMAIN, addressToBytes32(config.hook), usdc, hookBytes32,
        maxFee, params.minFinalityThreshold ?? FAST_FINALITY_THRESHOLD, hookData,
      ],
    }),
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: burnTxHash, timeout: 60_000 });
  if (receipt.status !== 'success') throw new Error('depositForBurnWithHook reverted');
  return { burnTxHash };
}

/**
 * Poll Circle's Iris attestation service for a Base Sepolia burn until the message is attested.
 * Returns the raw message + attestation to relay on Arc.
 */
export async function pollAttestation(params: {
  burnTxHash: `0x${string}`;
  config?: Pick<CrossChainConfig, 'irisBase'>;
  timeoutMs?: number;
  intervalMs?: number;
  onPoll?: (status: string) => void;
}): Promise<{ message: `0x${string}`; attestation: `0x${string}` }> {
  const base = params.config?.irisBase ?? IRIS_SANDBOX;
  const url = `${base}/v2/messages/${BASE_SEPOLIA_CCTP_DOMAIN}?transactionHash=${params.burnTxHash}`;
  const timeout = params.timeoutMs ?? 120_000;
  const interval = params.intervalMs ?? 4_000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as { messages?: Array<{ message: string; attestation: string; status: string }> };
      const m = body.messages?.[0];
      params.onPoll?.(m?.status ?? 'no-message');
      if (m && m.status === 'complete' && m.attestation && m.attestation !== 'PENDING') {
        return { message: m.message as `0x${string}`, attestation: m.attestation as `0x${string}` };
      }
    } else {
      params.onPoll?.(`http-${res.status}`); // 404 until Iris first sees the tx — keep polling
    }
    if (Date.now() > deadline) throw new Error(`Iris attestation timed out after ${timeout}ms for ${params.burnTxHash}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Relay an attested CCTP message into the Arc hook: mints the USDC to the hook and funds the escrow
 * atomically. Returns the Arc fund tx hash (explorer leg 2).
 */
export async function mintAndFund(params: {
  account: Account;
  message: `0x${string}`;
  attestation: `0x${string}`;
  config: CrossChainConfig;
}): Promise<{ fundTxHash: `0x${string}` }> {
  const { account, config } = params;
  const transport = http(config.arcRpcUrl ?? ARC_RPC);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport });
  const pub = createPublicClient({ chain: arcTestnet, transport });

  const fundTxHash = await wallet.sendTransaction({
    to: config.hook,
    data: encodeFunctionData({ abi: HOOK_ABI, functionName: 'mintAndFund', args: [params.message, params.attestation] }),
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: fundTxHash, timeout: 60_000 });
  if (receipt.status !== 'success') throw new Error('mintAndFund reverted');
  return { fundTxHash };
}

/**
 * End-to-end cross-chain escrow funding: burn on Base Sepolia → poll Iris → mintAndFund on Arc.
 * Returns both explorer legs and the workId. The amount the escrow ends up holding is fee-net (read
 * it from the escrow on-chain — see readEscrow).
 */
export async function fundCrossChainEscrow(params: {
  account: Account;
  amountUsdc: number;
  workId: `0x${string}`;
  payer: `0x${string}`;
  worker: `0x${string}`;
  config: CrossChainConfig;
  maxFeeUsdc?: number;
  minFinalityThreshold?: number;
  onStep?: (step: string) => void;
}): Promise<{ burnTxHash: `0x${string}`; fundTxHash: `0x${string}`; workId: `0x${string}` }> {
  params.onStep?.('burning on Base Sepolia');
  const { burnTxHash } = await depositForBurnWithHook(params);
  params.onStep?.(`burned ${burnTxHash}; polling Iris`);
  const { message, attestation } = await pollAttestation({
    burnTxHash, config: params.config,
    onPoll: (s) => params.onStep?.(`iris: ${s}`),
  });
  params.onStep?.('attested; relaying to Arc hook');
  const { fundTxHash } = await mintAndFund({ account: params.account, message, attestation, config: params.config });
  params.onStep?.(`funded ${fundTxHash}`);
  return { burnTxHash, fundTxHash, workId: params.workId };
}
