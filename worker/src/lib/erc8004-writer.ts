// ERC-8004 write path on Base Sepolia. Verdikt (the attestor) owns a registered agent NFT and is the
// named validator; it opens a validationRequest for the delivered work, then posts the verdict as a
// validationResponse to the LIVE canonical Validation Registry. The call builders are pure and
// unit-tested (arg order/types are the bug-prone part); the send wrappers are thin and proven live
// in D1.7. Access control the contract enforces: request caller must own the agentId; response caller
// must equal the validator named in the request — here both are the attestor (self-contained).
import { createWalletClient, createPublicClient, http, type Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { VALIDATION_REGISTRY_ABI } from './erc8004.js';
import { ERC8004_VALIDATION_REGISTRY } from './erc8004-constants.js';

function baseSepoliaRpc(): string {
  return (process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org').trim();
}

export function attestorClients(attestorKey: `0x${string}`) {
  const account = privateKeyToAccount(attestorKey);
  const transport = http(baseSepoliaRpc());
  return {
    account,
    wallet: createWalletClient({ account, chain: baseSepolia, transport }),
    pub: createPublicClient({ chain: baseSepolia, transport }),
  };
}

// ── Pure call builders (unit-tested via encode/decode round-trip) ────────────
export function validationRequestCall(p: {
  validator: `0x${string}`; agentId: bigint; requestURI: string; requestHash: `0x${string}`;
}) {
  return {
    address: ERC8004_VALIDATION_REGISTRY, abi: VALIDATION_REGISTRY_ABI,
    functionName: 'validationRequest' as const,
    args: [p.validator, p.agentId, p.requestURI, p.requestHash] as const,
  };
}

export function validationResponseCall(p: {
  requestHash: `0x${string}`; response: number; responseURI: string; responseHash: `0x${string}`; tag: string;
}) {
  if (!Number.isInteger(p.response) || p.response < 0 || p.response > 100) {
    throw new Error(`validationResponse: response must be an integer 0..100 (got ${p.response})`);
  }
  return {
    address: ERC8004_VALIDATION_REGISTRY, abi: VALIDATION_REGISTRY_ABI,
    functionName: 'validationResponse' as const,
    args: [p.requestHash, p.response, p.responseURI, p.responseHash, p.tag] as const,
  };
}

// ── Live send wrappers ───────────────────────────────────────────────────────
async function sendAndConfirm(
  clients: ReturnType<typeof attestorClients>, call: any, label: string,
): Promise<`0x${string}`> {
  const hash = await clients.wallet.writeContract({ ...call, account: clients.account as Account, chain: baseSepolia });
  const rcpt = await clients.pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (rcpt.status !== 'success') throw new Error(`${label} reverted (tx ${hash})`);
  return hash;
}

// Opens the paired request. Idempotent: a re-attest of the same settlement reverts "exists" at the
// registry — caught and reported as alreadyOpen (not an error), so the response step still proceeds.
export async function openValidationRequest(params: {
  attestorKey: `0x${string}`; agentId: bigint; validator: `0x${string}`;
  requestHash: `0x${string}`; requestURI: string;
}): Promise<{ txHash: `0x${string}` | null; alreadyOpen: boolean }> {
  const clients = attestorClients(params.attestorKey);
  const call = validationRequestCall({
    validator: params.validator, agentId: params.agentId,
    requestURI: params.requestURI, requestHash: params.requestHash,
  });
  try {
    const txHash = await sendAndConfirm(clients, call, 'validationRequest');
    return { txHash, alreadyOpen: false };
  } catch (e) {
    if (String((e as Error)?.message ?? e).toLowerCase().includes('exists')) {
      return { txHash: null, alreadyOpen: true };
    }
    throw e;
  }
}

export async function postValidationResponse(params: {
  attestorKey: `0x${string}`; requestHash: `0x${string}`; response: number;
  responseURI: string; responseHash: `0x${string}`; tag: string;
}): Promise<`0x${string}`> {
  const clients = attestorClients(params.attestorKey);
  const call = validationResponseCall(params);
  return sendAndConfirm(clients, call, 'validationResponse');
}
