import { Router } from 'express';
import {
  createWalletClient, createPublicClient, http, encodeFunctionData, keccak256,
  encodeAbiParameters, parseUnits, recoverTypedDataAddress, isAddress, isHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from '../lib/chains.js';
import { VERDIKT_ESCROW_ABI } from '../settlement/escrow-abi.js';
import { USDC_DOMAIN, RECEIVE_TYPES } from '../settlement/fund-escrow.js';
import { getTask, recordFunded } from '../lib/db.js';
import { readEscrowOnChain } from '../settlement/escrow-read.js';
import { createRateLimiter, clientIp } from '../lib/rate-limit.js';

// WS7 — GASLESS relayer for the human web path. A browser wallet signs an EIP-3009
// ReceiveWithAuthorization (from = the human) and posts it here; this endpoint submits it via a
// dedicated gas-only RELAYER_KEY so the human spends ZERO gas. The relayer NEVER signs the
// authorization and can NEVER redirect funds: fundWithAuthorizationFor folds the payout `routes`
// into the EIP-3009 nonce, so any tampering makes the signature not recover to the payer and the
// token reverts. Our only exposure is Arc gas, which we bound to registered catalog tasks + a clamp.

export const relayerRouter = Router();

export interface RawRoutes {
  workerDomain: number; workerRecipient: `0x${string}`;
  payerDomain: number; payerRecipient: `0x${string}`;
}

export interface ParsedFund {
  payer: `0x${string}`; workId: `0x${string}`; worker: `0x${string}`;
  amount: bigint; fee: bigint; ttl: bigint; validAfter: bigint; validBefore: bigint;
  signature: `0x${string}`; routes: RawRoutes;
}

export type VerifyResult = { ok: true; value: ParsedFund } | { ok: false; status: number; error: string };

// The routes tuple, as VerdiktEscrow.PayoutRoutes — MUST be byte-identical to the on-chain
// abi.encode(...) tuple so the reconstructed nonce matches the contract and the browser signer.
const ROUTES_ABI = {
  type: 'tuple',
  components: [
    { name: 'workerDomain', type: 'uint32' },
    { name: 'workerRecipient', type: 'bytes32' },
    { name: 'payerDomain', type: 'uint32' },
    { name: 'payerRecipient', type: 'bytes32' },
  ],
} as const;

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

// Derive the EIP-3009 nonce EXACTLY as VerdiktEscrow.fundWithAuthorizationFor does:
//   keccak256(abi.encode(workId, worker, amount, fee, ttl, payer, routes))
// Keep this in lockstep with the contract AND web/src/lib/relayer-sign.ts (the browser signer).
export function deriveNonce(p: Pick<ParsedFund, 'workId' | 'worker' | 'amount' | 'fee' | 'ttl' | 'payer' | 'routes'>): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'address' }, ROUTES_ABI,
    ],
    [p.workId, p.worker, p.amount, p.fee, p.ttl, p.payer, p.routes],
  ));
}

// A bytes32 recipient check: routes recipients are bytes32 (left-padded address on Arc, or a
// home-chain address for CCTP). Accept any 32-byte hex; all-zero (local Arc payout) is valid.
function isBytes32(v: unknown): v is `0x${string}` { return typeof v === 'string' && HEX32.test(v); }

// Pure verification of a relayer fund request: shape + economics + clamp + expiry + the signature
// recovers to `payer` over EXACTLY these params (routes bound via the nonce). No DB / no chain — this
// is the security core, unit-tested independently. Returns the parsed bigints on success.
export async function verifyRelayerAuth(
  body: unknown,
  opts: { escrow: `0x${string}`; maxAmount: bigint; nowSec: bigint },
): Promise<VerifyResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const payer = b.payer as `0x${string}`;
  const workId = b.workId as `0x${string}`;
  const worker = b.worker as `0x${string}`;
  const signature = b.signature as `0x${string}`;
  const routes = b.routes as RawRoutes | undefined;

  if (!isAddress(payer)) return bad(400, 'valid payer address required');
  if (!workId || !HEX32.test(workId)) return bad(400, 'valid bytes32 workId required');
  if (!isAddress(worker)) return bad(400, 'valid worker address required');
  if (!signature || !isHex(signature)) return bad(400, 'valid signature required');
  if (!routes || !isBytes32(routes.workerRecipient) || !isBytes32(routes.payerRecipient)
    || !Number.isInteger(routes.workerDomain) || !Number.isInteger(routes.payerDomain)) {
    return bad(400, 'valid payout routes required');
  }

  let amount: bigint, fee: bigint, ttl: bigint, validAfter: bigint, validBefore: bigint;
  try {
    amount = BigInt(String(b.amount)); fee = BigInt(String(b.fee)); ttl = BigInt(String(b.ttl));
    validAfter = BigInt(String(b.validAfter)); validBefore = BigInt(String(b.validBefore));
  } catch { return bad(400, 'amount/fee/ttl/validAfter/validBefore must be integer strings'); }

  if (amount <= 0n || fee >= amount || ttl <= 0n) return bad(400, 'require amount>0, fee<amount, ttl>0');
  if (validBefore <= opts.nowSec) return bad(400, 'authorization already expired');
  if (amount > opts.maxAmount) return bad(400, 'amount exceeds relayer cap');

  // The signature must recover to the payer over EXACTLY these params (incl. routes via the nonce).
  // This is the guarantee that the relayer can neither alter recipient/amount nor forge a payer.
  const parsed: ParsedFund = { payer, workId, worker, amount, fee, ttl, validAfter, validBefore, signature, routes };
  const nonce = deriveNonce(parsed);
  let signer: `0x${string}`;
  try {
    signer = await recoverTypedDataAddress({
      domain: USDC_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization',
      message: { from: payer, to: opts.escrow, value: amount, validAfter, validBefore, nonce },
      signature,
    });
  } catch { return bad(400, 'signature does not recover'); }
  if (signer.toLowerCase() !== payer.toLowerCase()) return bad(400, 'signature does not match payer');

  return { ok: true, value: parsed };
}

function bad(status: number, error: string): VerifyResult { return { ok: false, status, error }; }

const RELAYER_PER_IP = Number(process.env.RELAYER_PER_IP ?? 20);
const RELAYER_WINDOW_MS = Number(process.env.RELAYER_WINDOW_MS ?? 10 * 60 * 1000);
const rateLimit = createRateLimiter({ perIp: RELAYER_PER_IP, ipWindowMs: RELAYER_WINDOW_MS });

// POST /relayer/fund — submit a human's pre-signed EIP-3009 authorization gaslessly.
// body: { payer, workId, worker, amount, fee, ttl, validAfter, validBefore, signature, routes }
// amount/fee/ttl/validAfter/validBefore are decimal STRINGS of 6-decimal USDC base units / seconds.
relayerRouter.post('/relayer/fund', async (req, res) => {
  const limited = rateLimit(clientIp(req), Date.now());
  if (limited) { res.status(429).json({ error: limited }); return; }

  const relayerKey = process.env.RELAYER_KEY as `0x${string}` | undefined;
  const escrow = process.env.ESCROW_ADDRESS as `0x${string}` | undefined;
  if (!relayerKey || !escrow) { res.status(503).json({ error: 'relayer disabled: RELAYER_KEY / ESCROW_ADDRESS not configured' }); return; }

  const MAX_USDC = Number(process.env.RELAYER_MAX_USDC ?? 5);
  const v = await verifyRelayerAuth(req.body, { escrow, maxAmount: parseUnits(MAX_USDC.toFixed(6), 6), nowSec: BigInt(Math.floor(Date.now() / 1000)) });
  if (!v.ok) { res.status(v.status).json({ error: v.error }); return; }
  const f = v.value;

  // Tie the gas sponsorship to a registered catalog task: worker + amount must match what the buyer
  // committed via POST /api/tasks. Prevents the relayer being a free gas pump for arbitrary escrows
  // and guarantees the human is funding a real, judged task.
  const task = await getTask(f.workId);
  if (!task) { res.status(404).json({ error: 'no registered task for this workId — POST /api/tasks first' }); return; }
  if (task.worker.toLowerCase() !== f.worker.toLowerCase()) { res.status(400).json({ error: 'worker does not match the registered task' }); return; }
  if (parseUnits(task.amountUsdc.toFixed(6), 6) !== f.amount) { res.status(400).json({ error: 'amount does not match the registered task' }); return; }

  // Avoid wasting gas on a guaranteed revert if this escrow is already funded/settled.
  const existing = await readEscrowOnChain(f.workId).catch(() => null);
  if (existing && existing.status !== 0) { res.status(409).json({ error: 'escrow already exists for this workId' }); return; }

  // Submit gaslessly on behalf of the human. RELAYER_KEY pays Arc gas; the human paid zero.
  try {
    const pub = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
    const relayer = privateKeyToAccount(relayerKey);
    const wallet = createWalletClient({ account: relayer, chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
    const data = encodeFunctionData({
      abi: VERDIKT_ESCROW_ABI,
      functionName: 'fundWithAuthorizationFor',
      args: [f.payer, f.workId, f.worker, f.amount, f.fee, f.ttl, f.validAfter, f.validBefore, f.signature, f.routes],
    });
    const hash = await wallet.sendTransaction({ to: escrow, data });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') { res.status(502).json({ error: 'fund tx reverted on-chain' }); return; }
    // Record the fund tx to vk_escrows (as the agent-buyer path does), so the human-path escrow shows
    // in the ledger and the WS8 dashboard has its fund proof link. Best-effort: the money already moved
    // on-chain, so a DB hiccup must not turn a successful fund into a 502.
    await recordFunded(f.workId, hash).catch((e) => console.error(`[relayer] recordFunded failed for ${f.workId}: ${e instanceof Error ? e.message : String(e)}`));
    res.status(200).json({ fundTx: hash, relayer: relayer.address });
  } catch (err) {
    res.status(502).json({ error: 'relayer submission failed', detail: err instanceof Error ? err.message : String(err) });
  }
});
