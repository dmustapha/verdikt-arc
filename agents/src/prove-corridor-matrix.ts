// WS9 — Cross-chain corridor MATRIX (Gate F1).
//
// Proves >=6 CCTP V2 corridors, both directions, across Ethereum / Base / Arbitrum / OP / Polygon
// Sepolia, each as the FULL 4-leg round-trip on the v6 escrow:
//   leg 1  buyer BURNS on the SOURCE chain (depositForBurnWithHook → Arc hook)
//   leg 2  Arc mintAndFund  (hook mints fee-net + funds the escrow)
//   leg 3  Arc settle()     (verdict releases AND burns the bounty to the seller's home chain)
//   leg 4  DEST receiveMessage (seller is paid OUT on THEIR chain)
//
// Then, INDEPENDENTLY on each destination chain, asserts the seller's USDC balance rose by exactly
// the fee-net bounty read back from the Arc escrow (escrow.amount − escrow.fee) — no DB, no trust in
// the worker. Corridors, domains and RPCs come from the SDK CHAINS registry (nothing hardcoded).
//
// Resumable: each completed corridor is written to a checkpoint JSON; a re-run skips them. Sequential
// by design — one payer key acts as buyer (source), minter (Arc) and relayer (dest); parallelism would
// race nonces.
//
// Run:  set -a; . ./.env; set +a;  WORKER_URL=https://verdikt-worker.fly.dev npx tsx agents/src/prove-corridor-matrix.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, defineChain, formatUnits } from 'viem';
import type { Chain } from 'viem';
import {
  Verdikt, chainInfo, relayOutbound, readEscrow,
  type Acceptance, type Artifact, type ChainKey, type ChainInfo,
} from '@verdikt/sdk';

const ENDPOINT = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const ARC_RPC = process.env.ARC_RPC_URL;
const ARC_TX = 'https://testnet.arcscan.app/tx/';
const AMOUNT = Number(process.env.XCHAIN_AMOUNT_USDC ?? 0.5);
const ATTEST_TIMEOUT_MS = 1_200_000; // 20 min — covers a standard-finality source (Polygon Amoy)
const CHECKPOINT = new URL('../corridor-matrix.results.json', import.meta.url).pathname;

const PAYER_KEY = (process.env.DEMO_PAYER_KEY ?? '').trim() as `0x${string}`;
const SELLER_KEY = (process.env.WORKER_GATEWAY_KEY ?? '').trim() as `0x${string}`;
const HOOK = (process.env.HOOK_ADDRESS ?? '').trim() as `0x${string}`;
// The outbound relayer only needs gas on the DEST chain (permissionless). Default: the payer key.
const RELAYER_KEY = (process.env.RELAYER_KEY || process.env.DEMO_PAYER_KEY || '').trim() as `0x${string}`;

const STATUS_SETTLED = 2;

// The corridor set: 6 corridors, both directions, every chain appears as a source AND a destination.
// Chain KEYS only — every CCTP domain is read from CHAINS[key].cctpDomain at runtime.
const CORRIDORS: Array<{ source: ChainKey; dest: ChainKey }> = [
  { source: 'ethereumSepolia', dest: 'baseSepolia' },      // re-proves the 2026-06-30 round-trip on v6
  { source: 'baseSepolia', dest: 'ethereumSepolia' },      // reverse
  { source: 'arbitrumSepolia', dest: 'opSepolia' },
  { source: 'opSepolia', dest: 'arbitrumSepolia' },        // reverse
  { source: 'polygonAmoy', dest: 'baseSepolia' },          // Polygon as source (standard finality)
  { source: 'ethereumSepolia', dest: 'polygonAmoy' },      // Polygon as destination
];

interface Leg { chain: string; tx: `0x${string}`; explorer: string }
interface CorridorResult {
  id: string; source: ChainKey; dest: ChainKey; sourceDomain: number; destDomain: number;
  amountUsdc: number; sellerAddr: `0x${string}`; workId: `0x${string}`;
  legs: { burn: Leg; fund: Leg; settle: Leg; paid: Leg };
  escrowedRaw: string; feeRaw: string; bountyRaw: string; destDeltaRaw: string;
  feeNetPayoutUsdc: string; settled: boolean; verifiedAt: string;
}

const line = (s = '') => console.log(s);
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;

function viemChain(c: ChainInfo): Chain {
  return defineChain({
    id: c.chainId, name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } }, testnet: true,
  });
}

async function usdcBalance(c: ChainInfo, addr: `0x${string}`): Promise<bigint> {
  const pub = createPublicClient({ chain: viemChain(c), transport: http(c.rpcUrl) });
  return (await pub.readContract({ address: c.usdc, abi: ERC20, functionName: 'balanceOf', args: [addr] })) as bigint;
}

// Poll the seller's dest-chain USDC until it rises by `expected` (public RPCs lag/load-balance).
async function pollDelta(c: ChainInfo, addr: `0x${string}`, before: bigint, expected: bigint, timeoutMs = 300_000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = (await usdcBalance(c, addr)) - before;
    if (now >= expected) return now;
    if (Date.now() > deadline) return now; // return whatever we have; caller asserts
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

function loadCheckpoint(): Record<string, CorridorResult> {
  if (!existsSync(CHECKPOINT)) return {};
  try { return JSON.parse(readFileSync(CHECKPOINT, 'utf8')) as Record<string, CorridorResult>; }
  catch { return {}; }
}
function saveCheckpoint(all: Record<string, CorridorResult>) {
  writeFileSync(CHECKPOINT, JSON.stringify(all, null, 2));
}

async function runCorridor(
  payer: Verdikt, seller: Verdikt, sellerAddr: `0x${string}`,
  relayer: ReturnType<typeof privateKeyToAccount>, source: ChainKey, dest: ChainKey,
): Promise<CorridorResult> {
  const src = chainInfo(source), dst = chainInfo(dest);
  const id = `${source}->${dest}`;
  line(`\n━━━ corridor ${id}  (domain ${src.cctpDomain} → ${dst.cctpDomain}) ━━━`);
  line(`  buyer funds from ${src.name}; seller paid out on ${dst.name} (${sellerAddr})`);

  const b0 = await usdcBalance(dst, sellerAddr);

  // deterministic tool_output task → RELEASE never depends on an LLM
  const acceptance: Acceptance = {
    spec: 'Return a price feed JSON with a string symbol and a non-negative number price.',
    schema: { symbol: { type: 'string', required: true }, price: { type: 'number', required: true, min: 0 } },
    minResponseBytes: 10,
  };

  // legs 1 + 2 — burn on source, mintAndFund on Arc (fee-net)
  const t = await payer.payer.createTaskCrossChain({
    type: 'tool_output', acceptance, amountUsdc: AMOUNT, seller: sellerAddr,
    crossChain: { hook: HOOK, sourceChain: source, arcRpcUrl: ARC_RPC },
    sellerPayout: { domain: dst.cctpDomain, recipient: sellerAddr },
    attestTimeoutMs: ATTEST_TIMEOUT_MS,
    onStep: (s) => line(`    · ${s}`),
  });
  const escrow = t.offer.offer.escrow;
  line(`  workId ${t.workId}`);
  line(`  LEG 1 burn (${src.name}): ${src.explorerTx}${t.burnTxHash}`);
  line(`  LEG 2 fund (Arc):         ${ARC_TX}${t.fundTxHash}`);

  // independent read of what the escrow actually holds (fee-net minted)
  const eFunded = await readEscrow(escrow, t.workId, ARC_RPC);
  const bountyRaw = eFunded.amount - eFunded.fee;
  line(`  escrow holds ${formatUnits(eFunded.amount, 6)} (fee ${formatUnits(eFunded.fee, 6)}) → bounty ${formatUnits(bountyRaw, 6)}`);

  // leg 3 — seller accepts (asserts the escrow already commits to paying it on its chain) + submits
  await seller.seller.ensureOnboarded();
  await seller.seller.acceptOffer(t.offer, { expectedPayout: { domain: dst.cctpDomain, recipient: sellerAddr } });
  const artifact: Artifact = { type: 'tool_output', payload: JSON.stringify({ symbol: 'ARC-USDC', price: 1.0 }) };
  const seen = new Set<string>();
  const result = await seller.seller.submit({
    offer: t.offer, artifact,
    onStep: (st) => {
      if (st.type === 'verdict' && !seen.has('v')) { seen.add('v'); line(`    ⟶ verdict: ${String(st.data.verdict).toUpperCase()}`); }
      else if (st.type === 'settled' && !seen.has('s')) { seen.add('s'); line(`    ⟶ settled: ${st.data.outcome}`); }
    },
  });
  if (result.status !== 'released') throw new Error(`${id}: expected release, got ${result.status}`);
  if (!result.settlementTx) throw new Error(`${id}: no settlement tx`);
  const settleTx = result.settlementTx as `0x${string}`;
  line(`  LEG 3 settle+burn (Arc):  ${ARC_TX}${settleTx}`);

  // leg 4 — relay the outbound payout so the seller is paid on THEIR chain
  const out = await relayOutbound({
    account: relayer, settleTxHash: settleTx, destChain: dest,
    onPoll: (s) => line(`    · iris(arc→${dst.name}): ${s}`),
  });
  line(`  LEG 4 paid (${dst.name}):  ${dst.explorerTx}${out.mintTxHash}`);

  // INDEPENDENT fee-net verification on the destination chain
  const delta = await pollDelta(dst, sellerAddr, b0, bountyRaw);
  if (delta !== bountyRaw) {
    throw new Error(`${id}: dest payout mismatch on ${dst.name} — seller Δ=${delta} raw, expected bounty=${bountyRaw} raw`);
  }
  // INDEPENDENT settlement confirmation on Arc
  const eFinal = await readEscrow(escrow, t.workId, ARC_RPC);
  if (eFinal.status !== STATUS_SETTLED) throw new Error(`${id}: escrow not SETTLED (status=${eFinal.status})`);
  line(`  ✓ ${dst.name}: seller +${formatUnits(delta, 6)} USDC (== fee-net bounty, verified independently on-chain)`);

  return {
    id, source, dest, sourceDomain: src.cctpDomain, destDomain: dst.cctpDomain,
    amountUsdc: AMOUNT, sellerAddr, workId: t.workId,
    legs: {
      burn: { chain: src.name, tx: t.burnTxHash, explorer: `${src.explorerTx}${t.burnTxHash}` },
      fund: { chain: 'Arc', tx: t.fundTxHash, explorer: `${ARC_TX}${t.fundTxHash}` },
      settle: { chain: 'Arc', tx: settleTx, explorer: `${ARC_TX}${settleTx}` },
      paid: { chain: dst.name, tx: out.mintTxHash, explorer: `${dst.explorerTx}${out.mintTxHash}` },
    },
    escrowedRaw: eFunded.amount.toString(), feeRaw: eFunded.fee.toString(), bountyRaw: bountyRaw.toString(),
    destDeltaRaw: delta.toString(), feeNetPayoutUsdc: formatUnits(delta, 6),
    settled: true, verifiedAt: new Date().toISOString(),
  };
}

function printMatrix(results: CorridorResult[]) {
  line('\n\n━━━━━━ WS9 CORRIDOR MATRIX — Gate F1 ━━━━━━');
  line(`| # | Corridor | Domains | Burn (src) | Fund (Arc) | Settle+burn (Arc) | Paid (dest) | Fee-net payout |`);
  line(`|---|----------|---------|-----------|-----------|-------------------|-------------|----------------|`);
  results.forEach((r, i) => {
    const s = (u: string) => `${u.slice(0, 10)}…`;
    line(`| ${i + 1} | ${r.source} → ${r.dest} | ${r.sourceDomain}→${r.destDomain} | ${s(r.legs.burn.tx)} | ${s(r.legs.fund.tx)} | ${s(r.legs.settle.tx)} | ${s(r.legs.paid.tx)} | +${r.feeNetPayoutUsdc} |`);
  });
  line(`\n  ${results.length} corridors, both directions, all 5 chains — each a full 4-leg round-trip with an independent fee-net check on the destination chain.`);
}

async function main() {
  if (!PAYER_KEY || !SELLER_KEY) throw new Error('DEMO_PAYER_KEY and WORKER_GATEWAY_KEY required');
  if (!HOOK) throw new Error('HOOK_ADDRESS required');

  const payer = new Verdikt({ endpoint: ENDPOINT, rpcUrl: ARC_RPC, signer: { privateKey: PAYER_KEY } });
  const seller = new Verdikt({ endpoint: ENDPOINT, rpcUrl: ARC_RPC, signer: { privateKey: SELLER_KEY } });
  const sellerAddr = (seller as unknown as { _account: { address: `0x${string}` } })._account.address;
  const relayer = privateKeyToAccount(RELAYER_KEY);

  line(`Verdikt WS9 corridor matrix → ${ENDPOINT}`);
  line(`  escrow hook ${HOOK} · seller paid at ${sellerAddr} · ${CORRIDORS.length} corridors`);

  const all = loadCheckpoint();
  const done = Object.keys(all);
  if (done.length) line(`  resuming — ${done.length} corridor(s) already proven: ${done.join(', ')}`);

  for (const c of CORRIDORS) {
    const id = `${c.source}->${c.dest}`;
    if (all[id]?.settled) { line(`\n· ${id}: already proven — skip`); continue; }
    const r = await runCorridor(payer, seller, sellerAddr, relayer, c.source, c.dest);
    all[id] = r;
    saveCheckpoint(all);
    line(`  checkpoint saved (${Object.keys(all).length}/${CORRIDORS.length})`);
  }

  const ordered = CORRIDORS.map((c) => all[`${c.source}->${c.dest}`]).filter(Boolean);
  printMatrix(ordered);
  line(`\n[WS9 corridor matrix PASS — ${ordered.length} corridors, results at ${CHECKPOINT}]`);
}

main().catch((e) => { console.error('\n[WS9 matrix FATAL]', e); process.exit(1); });
