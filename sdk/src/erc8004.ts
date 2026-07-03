// ERC-8004 (Trustless Agents) reads for SDK consumers: resolve a seller agent's on-chain identity
// (owner / card / bound wallet) from the canonical Identity Registry, and read Verdikt's verdict back
// from the canonical Validation Registry — both LIVE on Base Sepolia (chainId 84532). Verdikt WRITES
// the validationResponse from the worker (off the SDK); the SDK is read-only here.
// Signatures match github.com/erc-8004/erc-8004-contracts @ 68fc676 (v2.0.0, MIT).
import { createPublicClient, http, getAddress, defineChain, BaseError, ContractFunctionRevertedError } from 'viem';

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const ERC8004_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;
export const ERC8004_REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const;
export const ERC8004_VALIDATION_REGISTRY = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272' as const;
export const BASE_SEPOLIA_DEFAULT_RPC = 'https://sepolia.base.org';

const baseSepolia = defineChain({
  id: BASE_SEPOLIA_CHAIN_ID, name: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [BASE_SEPOLIA_DEFAULT_RPC] } }, testnet: true,
});

export const VALIDATION_STATUS_ABI = [{
  type: 'function', name: 'getValidationStatus', stateMutability: 'view',
  inputs: [{ name: 'requestHash', type: 'bytes32' }],
  outputs: [
    { name: 'validatorAddress', type: 'address' }, { name: 'agentId', type: 'uint256' },
    { name: 'response', type: 'uint8' }, { name: 'responseHash', type: 'bytes32' },
    { name: 'tag', type: 'string' }, { name: 'lastUpdate', type: 'uint256' },
  ],
}] as const;

export const IDENTITY_READ_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'getAgentWallet', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const;

export interface ReadClient { readContract(args: any): Promise<unknown> }
export interface ValidationStatus {
  validatorAddress: `0x${string}`; agentId: bigint; response: number;
  responseHash: `0x${string}`; tag: string; lastUpdate: bigint;
}
export interface AgentIdentity {
  agentId: bigint; owner: `0x${string}`; tokenURI: string; agentWallet: `0x${string}`;
}

const reader = (rpcUrl?: string): ReadClient =>
  createPublicClient({ chain: baseSepolia, transport: http(rpcUrl ?? BASE_SEPOLIA_DEFAULT_RPC) }) as unknown as ReadClient;

// A contract revert (expected "not found") → false so callers get null; transport errors propagate.
function isRevert(e: unknown): boolean {
  return e instanceof BaseError
    && e.walk((err) => err instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError;
}

// Read Verdikt's verdict for a settlement back off-chain. null when never attested (contract reverts).
export async function readValidationStatus(
  requestHash: `0x${string}`, opts: { rpcUrl?: string; client?: ReadClient } = {},
): Promise<ValidationStatus | null> {
  const c = opts.client ?? reader(opts.rpcUrl);
  try {
    const r = (await c.readContract({
      address: ERC8004_VALIDATION_REGISTRY, abi: VALIDATION_STATUS_ABI, functionName: 'getValidationStatus', args: [requestHash],
    })) as readonly [`0x${string}`, bigint, number, `0x${string}`, string, bigint];
    return { validatorAddress: r[0], agentId: r[1], response: Number(r[2]), responseHash: r[3], tag: r[4], lastUpdate: r[5] };
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
}

// Resolve a registered seller agent's identity card. null for a nonexistent agentId (ownerOf reverts).
export async function readAgentIdentity(
  agentId: bigint, opts: { rpcUrl?: string; client?: ReadClient } = {},
): Promise<AgentIdentity | null> {
  const c = opts.client ?? reader(opts.rpcUrl);
  try {
    const owner = (await c.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: IDENTITY_READ_ABI, functionName: 'ownerOf', args: [agentId] })) as `0x${string}`;
    const tokenURI = (await c.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: IDENTITY_READ_ABI, functionName: 'tokenURI', args: [agentId] })) as string;
    let agentWallet = '0x0000000000000000000000000000000000000000' as `0x${string}`;
    try {
      agentWallet = getAddress((await c.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: IDENTITY_READ_ABI, functionName: 'getAgentWallet', args: [agentId] })) as string);
    } catch (e) { if (!isRevert(e)) throw e; }
    return { agentId, owner: getAddress(owner), tokenURI, agentWallet };
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
}
