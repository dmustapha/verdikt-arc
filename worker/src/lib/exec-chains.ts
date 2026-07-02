import { createPublicClient, http, defineChain, type PublicClient } from 'viem';
import { ARC_CHAIN_ID } from './chains.js';

// The execution route can only verify chains the verifier is configured to READ. Arc is always
// available; any other chain must be enabled via `EXEC_RPC_<chainId>` (e.g. EXEC_RPC_11155111 for
// ETH Sepolia). This keeps the on-chain slice honest by construction: an unconfigured chain yields
// a routeError → abstain (refund), never a release on a claim we cannot check.
function rpcFor(chainId: number): string | null {
  if (chainId === ARC_CHAIN_ID) return process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';
  const env = process.env[`EXEC_RPC_${chainId}`];
  return env && env.trim() ? env.trim() : null;
}

export function isChainConfigured(chainId: number): boolean {
  return rpcFor(chainId) !== null;
}

const clients = new Map<number, PublicClient>();

// A read-only viem client for a configured chain (cached). Throws if the chain isn't configured —
// callers must gate on isChainConfigured() first to produce a routeError instead of throwing.
export function readerClient(chainId: number): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;
  const rpc = rpcFor(chainId);
  if (!rpc) throw new Error(`execution route: chain ${chainId} not configured (set EXEC_RPC_${chainId})`);
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const client = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  clients.set(chainId, client);
  return client;
}
