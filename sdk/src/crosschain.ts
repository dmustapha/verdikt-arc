import {
  createWalletClient, createPublicClient, http, parseUnits, pad,
  encodeAbiParameters, encodeFunctionData, defineChain,
} from 'viem';
import type { Account, Chain } from 'viem';
import { arcTestnet, DEFAULT_RPC as ARC_RPC } from './escrow.js';

// ── CCTP V2 multi-chain registry (Circle-verified testnet values) ───────────────────────────────
// Verdikt is the neutral clearing house: a buyer agent on ANY of these chains funds an Arc escrow,
// and on settlement the seller (or refunded buyer) is paid OUT to ANY of these chains. Neither agent
// has to live on Arc — the money just meets and settles there. CCTP core does NOT execute hooks, so
// inbound funding goes through the Arc EscrowFundingHook (mintRecipient + destinationCaller); outbound
// payout is a plain depositForBurn from the escrow on Arc.

// TokenMessengerV2 + MessageTransmitterV2 are the SAME deterministic address on every CCTP V2 chain.
export const TOKEN_MESSENGER_V2 = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const;
export const MESSAGE_TRANSMITTER_V2 = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as const;
export const ARC_CCTP_DOMAIN = 26;
export const IRIS_SANDBOX = 'https://iris-api-sandbox.circle.com';
// Fast Transfer (~8-20s, small fee) for chains that support it as a source; Arc is standard-only but
// reaches finality in ~0.5s and charges no fee, so outbound payouts are still seconds + exact.
export const FAST_FINALITY_THRESHOLD = 1000;
export const STANDARD_FINALITY_THRESHOLD = 2000;

export interface ChainInfo {
  key: string;
  name: string;
  cctpDomain: number;
  chainId: number;
  usdc: `0x${string}`;
  rpcUrl: string;
  explorerTx: string; // base, append the tx hash
  nativeSymbol: string;
  fastSource: boolean; // CCTP Fast Transfer supported as a source
  agentNote?: string;  // why this chain matters for the agent economy
}

// The popular agent chains. Lead corridor = Ethereum Sepolia (ERC-8004 agents) ↔ Base Sepolia (x402).
export const CHAINS: Record<string, ChainInfo> = {
  ethereumSepolia: {
    key: 'ethereumSepolia', name: 'Ethereum Sepolia', cctpDomain: 0, chainId: 11155111,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorerTx: 'https://sepolia.etherscan.io/tx/', nativeSymbol: 'ETH', fastSource: true,
    agentNote: 'ERC-8004 trustless-agents identity/reputation registry',
  },
  baseSepolia: {
    key: 'baseSepolia', name: 'Base Sepolia', cctpDomain: 6, chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', rpcUrl: 'https://sepolia.base.org',
    explorerTx: 'https://sepolia.basescan.org/tx/', nativeSymbol: 'ETH', fastSource: true,
    agentNote: 'x402 / Coinbase AgentKit — the densest agents-that-pay community',
  },
  arbitrumSepolia: {
    key: 'arbitrumSepolia', name: 'Arbitrum Sepolia', cctpDomain: 3, chainId: 421614,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorerTx: 'https://sepolia.arbiscan.io/tx/', nativeSymbol: 'ETH', fastSource: true,
  },
  opSepolia: {
    key: 'opSepolia', name: 'OP Sepolia', cctpDomain: 2, chainId: 11155420,
    usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', rpcUrl: 'https://sepolia.optimism.io',
    explorerTx: 'https://sepolia-optimism.etherscan.io/tx/', nativeSymbol: 'ETH', fastSource: true,
  },
  avalancheFuji: {
    key: 'avalancheFuji', name: 'Avalanche Fuji', cctpDomain: 1, chainId: 43113,
    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65', rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
    explorerTx: 'https://testnet.snowtrace.io/tx/', nativeSymbol: 'AVAX', fastSource: false,
  },
  polygonAmoy: {
    key: 'polygonAmoy', name: 'Polygon Amoy', cctpDomain: 7, chainId: 80002,
    usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', rpcUrl: 'https://rpc-amoy.polygon.technology',
    explorerTx: 'https://amoy.polygonscan.com/tx/', nativeSymbol: 'POL', fastSource: false,
  },
  lineaSepolia: {
    key: 'lineaSepolia', name: 'Linea Sepolia', cctpDomain: 11, chainId: 59141,
    usdc: '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7', rpcUrl: 'https://rpc.sepolia.linea.build',
    explorerTx: 'https://sepolia.lineascan.build/tx/', nativeSymbol: 'ETH', fastSource: true,
  },
};

export type ChainKey = keyof typeof CHAINS;

export function chainInfo(key: ChainKey | string): ChainInfo {
  const c = CHAINS[key];
  if (!c) throw new Error(`unknown chain "${key}" — known: ${Object.keys(CHAINS).join(', ')}`);
  return c;
}

function viemChain(c: ChainInfo, rpcOverride?: string): Chain {
  return defineChain({
    id: c.chainId, name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [rpcOverride ?? c.rpcUrl] } }, testnet: true,
  });
}

const ERC20_APPROVE_ABI = [{
  type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }],
  outputs: [{ type: 'bool' }],
}] as const;

const TOKEN_MESSENGER_ABI = [{
  type: 'function', name: 'depositForBurnWithHook', stateMutability: 'nonpayable',
  inputs: [
    { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' },
    { name: 'mintRecipient', type: 'bytes32' }, { name: 'burnToken', type: 'address' },
    { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' }, { name: 'hookData', type: 'bytes' },
  ],
  outputs: [],
}] as const;

const HOOK_ABI = [{
  type: 'function', name: 'mintAndFund', stateMutability: 'nonpayable',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
  outputs: [],
}] as const;

const RECEIVE_MESSAGE_ABI = [{
  type: 'function', name: 'receiveMessage', stateMutability: 'nonpayable',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
  outputs: [{ type: 'bool' }],
}] as const;

/** Left-pad an EVM address to a CCTP bytes32 (mintRecipient / destinationCaller / payout recipient). */
export function addressToBytes32(addr: `0x${string}`): `0x${string}` {
  return pad(addr, { size: 32 });
}

/** A cross-chain payout route: where a party is paid OUT on settlement. */
export interface PayoutRoute {
  /** Destination CCTP domain (e.g. CHAINS.baseSepolia.cctpDomain). */
  domain: number;
  /** Recipient address on the destination chain. */
  recipient: `0x${string}`;
}

export interface PayoutRoutes {
  worker?: PayoutRoute; // where a RELEASE pays the seller; omit = local Arc
  payer?: PayoutRoute;  // where a REFUND/ABSTAIN returns the buyer; omit = local Arc
}

const ZERO32 = pad('0x', { size: 32 });

// Default no-show deadline horizon carried through the bridge: 7 days.
const DEFAULT_TTL_SECONDS = 604800;

/**
 * Encode the CCTP hookData the Arc hook decodes with
 *   abi.decode(_, (bytes32, address, address, uint256, uint256, uint32, bytes32, uint32, bytes32)).
 * MUST byte-match the Solidity decode (v3 layout: adds the verdict fee + no-show ttl). Omitted
 * routes encode as local (recipient 0).
 */
export function encodeHookData(
  workId: `0x${string}`, payer: `0x${string}`, worker: `0x${string}`,
  fee: bigint, ttl: bigint, routes?: PayoutRoutes,
): `0x${string}` {
  const w = routes?.worker;
  const p = routes?.payer;
  return encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'address' }, { type: 'address' },
      { type: 'uint256' }, { type: 'uint256' },
      { type: 'uint32' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' },
    ],
    [
      workId, payer, worker, fee, ttl,
      w ? w.domain : 0, w ? addressToBytes32(w.recipient) : ZERO32,
      p ? p.domain : 0, p ? addressToBytes32(p.recipient) : ZERO32,
    ],
  );
}

export interface CrossChainConfig {
  hook: `0x${string}`;          // Arc EscrowFundingHook
  sourceChain?: ChainKey | string; // which chain the buyer funds from (default baseSepolia)
  sourceRpcUrl?: string;        // override the source chain RPC
  arcRpcUrl?: string;           // Arc RPC
  irisBase?: string;            // Iris attestation API base
}

/**
 * Burn USDC on the SOURCE chain targeting the Arc hook, carrying {workId, payer, worker} + optional
 * cross-chain payout routes in hookData. Returns the source burn tx hash (explorer leg 1).
 */
export async function depositForBurnWithHook(params: {
  account: Account;
  amountUsdc: number;
  workId: `0x${string}`;
  payer: `0x${string}`;
  worker: `0x${string}`;
  feeUsdc?: number;         // verdict fee escrowed alongside the bounty (default 0)
  ttlSeconds?: number;      // no-show deadline horizon (default 7 days)
  routes?: PayoutRoutes;
  maxFeeUsdc?: number;
  minFinalityThreshold?: number;
  config: CrossChainConfig;
}): Promise<{ burnTxHash: `0x${string}`; sourceChain: ChainInfo }> {
  const { account, config } = params;
  const src = chainInfo(config.sourceChain ?? 'baseSepolia');
  const chain = viemChain(src, config.sourceRpcUrl);
  const transport = http(config.sourceRpcUrl ?? src.rpcUrl);
  const wallet = createWalletClient({ account, chain, transport });
  const pub = createPublicClient({ chain, transport });

  const amount = parseUnits(params.amountUsdc.toFixed(6), 6);
  const maxFee = parseUnits((params.maxFeeUsdc ?? 0.05).toFixed(6), 6);
  const verdictFee = parseUnits((params.feeUsdc ?? 0).toFixed(6), 6);
  const ttl = BigInt(params.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const hookBytes32 = addressToBytes32(config.hook);
  const hookData = encodeHookData(params.workId, params.payer, params.worker, verdictFee, ttl, params.routes);
  // Fast where the source supports it, else standard (Circle treats <1000 as fast, >=2000 as standard).
  const finality = params.minFinalityThreshold ?? (src.fastSource ? FAST_FINALITY_THRESHOLD : STANDARD_FINALITY_THRESHOLD);

  const approveTx = await wallet.sendTransaction({
    to: src.usdc,
    data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [TOKEN_MESSENGER_V2, amount] }),
  });
  await pub.waitForTransactionReceipt({ hash: approveTx, timeout: 90_000 });

  const burnTxHash = await wallet.sendTransaction({
    to: TOKEN_MESSENGER_V2,
    data: encodeFunctionData({
      abi: TOKEN_MESSENGER_ABI, functionName: 'depositForBurnWithHook',
      args: [amount, ARC_CCTP_DOMAIN, hookBytes32, src.usdc, hookBytes32, maxFee, finality, hookData],
    }),
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: burnTxHash, timeout: 90_000 });
  if (receipt.status !== 'success') throw new Error('depositForBurnWithHook reverted');
  return { burnTxHash, sourceChain: src };
}

/**
 * Poll Circle's Iris attestation service for a burn until attested. `sourceDomain` is the CCTP domain
 * the burn originated on (the buyer's chain for inbound, 26/Arc for an outbound payout).
 */
export async function pollAttestation(params: {
  burnTxHash: `0x${string}`;
  sourceDomain: number;
  config?: Pick<CrossChainConfig, 'irisBase'>;
  timeoutMs?: number;
  intervalMs?: number;
  onPoll?: (status: string) => void;
}): Promise<{ message: `0x${string}`; attestation: `0x${string}` }> {
  const base = params.config?.irisBase ?? IRIS_SANDBOX;
  const url = `${base}/v2/messages/${params.sourceDomain}?transactionHash=${params.burnTxHash}`;
  const timeout = params.timeoutMs ?? 180_000;
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
 * Relay an attested CCTP message into the Arc hook: mints the USDC to the hook + funds the escrow
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
 * Relay the OUTBOUND payout: after the Arc escrow settles (burning USDC to the recipient's home
 * chain), poll Iris for the Arc burn and call receiveMessage on the destination chain so the seller
 * (or refunded buyer) actually receives the USDC. Returns the destination mint tx (final explorer leg).
 * Permissionless — the relayer just needs gas on the destination chain.
 */
export async function relayOutbound(params: {
  account: Account;
  settleTxHash: `0x${string}`;     // the Arc settle() tx that burned the payout
  destChain: ChainKey | string;
  destRpcUrl?: string;
  config?: Pick<CrossChainConfig, 'irisBase'>;
  onPoll?: (status: string) => void;
}): Promise<{ message: `0x${string}`; attestation: `0x${string}`; mintTxHash: `0x${string}`; destChain: ChainInfo }> {
  const dest = chainInfo(params.destChain);
  const { message, attestation } = await pollAttestation({
    burnTxHash: params.settleTxHash, sourceDomain: ARC_CCTP_DOMAIN,
    config: params.config, onPoll: params.onPoll,
  });
  const chain = viemChain(dest, params.destRpcUrl);
  const transport = http(params.destRpcUrl ?? dest.rpcUrl);
  const wallet = createWalletClient({ account: params.account, chain, transport });
  const pub = createPublicClient({ chain, transport });

  const mintTxHash = await wallet.sendTransaction({
    to: MESSAGE_TRANSMITTER_V2,
    data: encodeFunctionData({ abi: RECEIVE_MESSAGE_ABI, functionName: 'receiveMessage', args: [message, attestation] }),
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: mintTxHash, timeout: 90_000 });
  if (receipt.status !== 'success') throw new Error('receiveMessage (outbound payout) reverted');
  return { message, attestation, mintTxHash, destChain: dest };
}

/**
 * Inbound end-to-end: burn on the source chain → poll Iris → mintAndFund on Arc. Returns both legs.
 * The escrow ends up holding the fee-net amount (read it from the escrow on-chain).
 */
export async function fundCrossChainEscrow(params: {
  account: Account;
  amountUsdc: number;
  workId: `0x${string}`;
  payer: `0x${string}`;
  worker: `0x${string}`;
  feeUsdc?: number;         // verdict fee escrowed alongside the bounty (default 0)
  ttlSeconds?: number;      // no-show deadline horizon (default 7 days)
  routes?: PayoutRoutes;
  config: CrossChainConfig;
  maxFeeUsdc?: number;
  minFinalityThreshold?: number;
  onStep?: (step: string) => void;
}): Promise<{ burnTxHash: `0x${string}`; fundTxHash: `0x${string}`; workId: `0x${string}`; sourceChain: ChainInfo }> {
  const src = chainInfo(params.config.sourceChain ?? 'baseSepolia');
  params.onStep?.(`burning on ${src.name}`);
  const { burnTxHash } = await depositForBurnWithHook(params);
  params.onStep?.(`burned ${burnTxHash}; polling Iris`);
  const { message, attestation } = await pollAttestation({
    burnTxHash, sourceDomain: src.cctpDomain, config: params.config,
    onPoll: (s) => params.onStep?.(`iris: ${s}`),
  });
  params.onStep?.('attested; relaying to Arc hook');
  const { fundTxHash } = await mintAndFund({ account: params.account, message, attestation, config: params.config });
  params.onStep?.(`funded ${fundTxHash}`);
  return { burnTxHash, fundTxHash, workId: params.workId, sourceChain: src };
}
