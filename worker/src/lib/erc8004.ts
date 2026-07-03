// ERC-8004 (Trustless Agents) integration — Verdikt reads agent identity and writes its verdict as
// a validationResponse to the LIVE canonical registries on Base Sepolia. Signatures match the
// reference impl github.com/erc-8004/erc-8004-contracts @ 68fc676 (v2.0.0 UUPS, MIT).
//
// Model (self-contained, per MASTER-PLAN §WS6): Verdikt owns a registered agent NFT and acts as the
// named validator. Post-settle it opens a validationRequest for the delivered work and posts the
// verdict (a 0..100 score, NOT a bool) as the validationResponse — the responseURI resolves to an
// evidence bundle that carries the Arc settlement tx hash. Reads never trust these blind: D1.0's
// verify-erc8004-onchain.ts re-checks every address via getCode before anything is wired.
import {
  createPublicClient, http, getAddress, BaseError, ContractFunctionRevertedError,
  type PublicClient,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { ERC8004_IDENTITY_REGISTRY, ERC8004_VALIDATION_REGISTRY } from './erc8004-constants.js';

// ── ABIs (only the surface Verdikt touches) ──────────────────────────────────
export const VALIDATION_REGISTRY_ABI = [
  { type: 'function', name: 'validationRequest', stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'requestURI', type: 'string' },
      { name: 'requestHash', type: 'bytes32' },
    ], outputs: [] },
  { type: 'function', name: 'validationResponse', stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestHash', type: 'bytes32' },
      { name: 'response', type: 'uint8' },
      { name: 'responseURI', type: 'string' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'string' },
    ], outputs: [] },
  { type: 'function', name: 'getValidationStatus', stateMutability: 'view',
    inputs: [{ name: 'requestHash', type: 'bytes32' }],
    outputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'response', type: 'uint8' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'string' },
      { name: 'lastUpdate', type: 'uint256' },
    ] },
  { type: 'function', name: 'getVersion', stateMutability: 'pure', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'getIdentityRegistry', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

export const IDENTITY_REGISTRY_ABI = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ name: 'agentId', type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'getAgentWallet', stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'isAuthorizedOrOwner', stateMutability: 'view',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'agentId', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  // ERC-721 Transfer — the reliable way to recover the minted agentId from a register() receipt.
  { type: 'event', name: 'Transfer', inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
  ] },
] as const;

// A read client just needs readContract; keep it structural so unit tests can inject a fake.
export interface ReadClient { readContract(args: any): Promise<unknown>; }

export function baseSepoliaReader(): PublicClient {
  const rpc = (process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org').trim();
  return createPublicClient({ chain: baseSepolia, transport: http(rpc) }) as PublicClient;
}

// True when the error is a contract revert (expected "not found" cases), false for transport/RPC
// failures — which must propagate, never be silently swallowed as "absent".
function isRevert(e: unknown): boolean {
  if (e instanceof BaseError) {
    return e.walk((err) => err instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError;
  }
  return false;
}

export interface ValidationStatus {
  validatorAddress: `0x${string}`;
  agentId: bigint;
  response: number;              // 0..100 score
  responseHash: `0x${string}`;
  tag: string;
  lastUpdate: bigint;
}

// Read a posted verdict back. Returns null when the requestHash was never requested (the contract
// reverts "unknown") — an honest absence, distinct from an RPC failure which rethrows.
export async function readValidationStatus(
  requestHash: `0x${string}`, client?: ReadClient,
): Promise<ValidationStatus | null> {
  const c = client ?? baseSepoliaReader();
  try {
    const r = (await c.readContract({
      address: ERC8004_VALIDATION_REGISTRY, abi: VALIDATION_REGISTRY_ABI,
      functionName: 'getValidationStatus', args: [requestHash],
    })) as readonly [`0x${string}`, bigint, number, `0x${string}`, string, bigint];
    return { validatorAddress: r[0], agentId: r[1], response: Number(r[2]), responseHash: r[3], tag: r[4], lastUpdate: r[5] };
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
}

export interface AgentIdentity {
  agentId: bigint;
  owner: `0x${string}`;
  tokenURI: string;
  agentWallet: `0x${string}`;    // zero address when the agent hasn't set a bound wallet
}

// Read a registered seller's on-chain identity card. Returns null for a nonexistent agentId
// (ownerOf reverts). getAgentWallet is best-effort: some agents never bind a wallet, so a revert
// there degrades to the zero address rather than failing the whole read.
export async function readAgentIdentity(
  agentId: bigint, client?: ReadClient,
): Promise<AgentIdentity | null> {
  const c = client ?? baseSepoliaReader();
  try {
    const owner = (await c.readContract({
      address: ERC8004_IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'ownerOf', args: [agentId],
    })) as `0x${string}`;
    const tokenURI = (await c.readContract({
      address: ERC8004_IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'tokenURI', args: [agentId],
    })) as string;
    let agentWallet = '0x0000000000000000000000000000000000000000' as `0x${string}`;
    try {
      agentWallet = getAddress((await c.readContract({
        address: ERC8004_IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'getAgentWallet', args: [agentId],
      })) as string);
    } catch (e) { if (!isRevert(e)) throw e; }
    return { agentId, owner: getAddress(owner), tokenURI, agentWallet };
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
}
