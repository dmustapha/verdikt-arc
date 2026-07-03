import { Router } from 'express';
import { createWalletClient, createPublicClient, http, parseUnits, isAddress, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, ARC_USDC_ADDRESS } from '../lib/chains.js';
import { createRateLimiter, clientIp } from '../lib/rate-limit.js';

// WS7 — a small ERC-20 USDC faucet so a fresh browser wallet can get test USDC to escrow. The human
// needs NO native gas (the relayer submits their fund), so this only drips the ERC-20 token. Bounded:
// a fixed small drip, rate-limited per address AND per IP, funded from the demo wallet. Testnet only.
export const faucetRouter = Router();

const ERC20_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const perIp = createRateLimiter({ perIp: Number(process.env.FAUCET_PER_IP ?? 6), ipWindowMs: 60 * 60 * 1000 });
// Per-address cooldown (in-memory): one drip per address per window. Survives only in-process, which
// is fine — it just throttles repeat clicks; the per-IP limit and the small drip bound total spend.
const lastDrip = new Map<string, number>();
const COOLDOWN_MS = Number(process.env.FAUCET_COOLDOWN_MS ?? 60_000);

faucetRouter.post('/faucet', async (req, res) => {
  const ipLimited = perIp(clientIp(req), Date.now());
  if (ipLimited) { res.status(429).json({ error: ipLimited }); return; }

  const faucetKey = process.env.DEMO_PAYER_KEY as `0x${string}` | undefined;
  if (!faucetKey) { res.status(503).json({ error: 'faucet disabled: not configured' }); return; }

  const address = (req.body?.address ?? '') as string;
  if (!isAddress(address)) { res.status(400).json({ error: 'valid address required' }); return; }

  const now = Date.now();
  const prev = lastDrip.get(address.toLowerCase());
  if (prev && now - prev < COOLDOWN_MS) {
    res.status(429).json({ error: `faucet cooldown — wait ${Math.ceil((COOLDOWN_MS - (now - prev)) / 1000)}s` }); return;
  }

  const dripUsdc = Number(process.env.FAUCET_DRIP_USDC ?? 1);
  const amount = parseUnits(dripUsdc.toFixed(6), 6);
  try {
    const account = privateKeyToAccount(faucetKey);
    const pub = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
    lastDrip.set(address.toLowerCase(), now); // reserve the slot BEFORE the tx so a retry can't double-drip
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [address as `0x${string}`, amount] });
    const hash = await wallet.sendTransaction({ to: ARC_USDC_ADDRESS, data });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') { lastDrip.delete(address.toLowerCase()); res.status(502).json({ error: 'faucet tx reverted' }); return; }
    res.status(200).json({ tx: hash, amountUsdc: dripUsdc });
  } catch (err) {
    lastDrip.delete(address.toLowerCase());
    res.status(502).json({ error: 'faucet failed', detail: err instanceof Error ? err.message : String(err) });
  }
});
