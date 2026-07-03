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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Simulate-then-send with retry. Base Sepolia's public RPC is load-balanced, so a tx that depends on
// freshly-written state (e.g. validationResponse needing the just-opened request) can hit a lagging
// node and revert "unknown". Simulating first surfaces the real revert reason AND gates the (gas-
// costing) send; a transient stale-state failure is retried with backoff (per the load-balanced-RPC
// lesson). A genuine revert (e.g. resp>100) fails every attempt and is thrown with its reason.
async function simulateSendConfirm(
  clients: ReturnType<typeof attestorClients>, call: any, label: string, attempts = 4,
): Promise<`0x${string}`> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await clients.pub.simulateContract({ ...call, account: clients.account as Account });
      const hash = await clients.wallet.writeContract({ ...call, account: clients.account as Account, chain: baseSepolia });
      const rcpt = await clients.pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (rcpt.status !== 'success') throw new Error(`${label} reverted (tx ${hash})`);
      return hash;
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e).toLowerCase();
      // "exists" (request already open) is terminal for the caller to interpret — don't retry it.
      if (msg.includes('exists')) throw e;
      if (i < attempts - 1) await sleep(3000 * (i + 1)); // 3s, 6s, 9s backoff for stale-state
    }
  }
  throw lastErr;
}

// Poll until an opened validationRequest is visible on the (load-balanced) RPC, so the paired
// response doesn't execute against stale state. Best-effort: returns after the deadline regardless.
export async function waitForRequestVisible(
  requestHash: `0x${string}`, clients: ReturnType<typeof attestorClients>, tries = 12, gapMs = 2500,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const s = await clients.pub.readContract({
        address: ERC8004_VALIDATION_REGISTRY, abi: VALIDATION_REGISTRY_ABI,
        functionName: 'getValidationStatus', args: [requestHash],
      });
      if (s) return true; // no revert ⇒ the request exists on this node
    } catch { /* still "unknown" on this node — keep polling */ }
    await sleep(gapMs);
  }
  return false;
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
    const txHash = await simulateSendConfirm(clients, call, 'validationRequest');
    // Ensure the just-opened request has propagated across the load-balanced RPC BEFORE the caller
    // posts the paired response (otherwise the response can execute on a lagging node → "unknown").
    await waitForRequestVisible(params.requestHash, clients);
    return { txHash, alreadyOpen: false };
  } catch (e) {
    if (String((e as Error)?.message ?? e).toLowerCase().includes('exists')) {
      // Already open (idempotent re-attest) — still confirm it's visible before the response.
      await waitForRequestVisible(params.requestHash, clients);
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
  return simulateSendConfirm(clients, call, 'validationResponse');
}
