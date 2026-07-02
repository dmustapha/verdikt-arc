// WS1 Gate A1 — prove the five VerdiktEscrow v5 settlement paths LIVE on Arc, with INDEPENDENT
// on-chain balance-delta assertions (not just events).
//
// Faithful to production: funding via EIP-3009 (fund-escrow.ts), settlement via the real Circle DCW
// (executeContractCall) for release/refund/abstain/partial, and the payer-authorized refundExpired
// for no-show. Each escrow carries a real verdict fee so the fee-in-escrow split is exercised.
// Every path uses a FRESH worker address so its balance delta is unambiguous, and asserts the exact
// USDC balanceOf change of worker / payer / feeRecipient against the contract's specified economics.
//
// Run:  set -a; . ./.env; set +a;  npx tsx src/scripts/prove-settlement-v5.ts
import { createPublicClient, createWalletClient, http, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from '../lib/chains.js';
import { fundEscrow } from '../settlement/fund-escrow.js';
import { executeContractCall, waitForTxHash } from '../lib/circle-wallets.js';
import { VERDIKT_ESCROW_ABI, SETTLE_FN_SIGNATURE, SETTLE_PARTIAL_FN_SIGNATURE } from '../settlement/escrow-abi.js';

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const USDC = '0x3600000000000000000000000000000000000000' as const;
const RPC = process.env.ARC_RPC_URL!;
const EXPLORER = 'https://testnet.arcscan.app';
const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
const payer = process.env.DEMO_PAYER_ADDRESS as `0x${string}`;

// 6-decimal USDC amounts.
const TOTAL = 50000n;  // 0.05
const FEE = 10000n;    // 0.01
const BOUNTY = TOTAL - FEE; // 0.04
const AMOUNT_USDC = 0.05;
const FEE_USDC = 0.01;
const EVIDENCE = keccak256(stringToHex('verdikt-v5-proof-evidence'));
const RUN = Date.now().toString();

const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const OUTCOME = ['release', 'refund', 'abstain', 'partial', 'expired'] as const;

function freshWorker(label: string): `0x${string}` {
  return privateKeyToAccount(keccak256(stringToHex(`worker-${label}-${RUN}`))).address;
}
function workIdFor(label: string): `0x${string}` { return keccak256(stringToHex(`v5h-${label}-${RUN}`)); }
async function bal(a: `0x${string}`): Promise<bigint> {
  return (await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })) as bigint;
}
async function readEscrow(workId: `0x${string}`) {
  return (await pub.readContract({ address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'getEscrow', args: [workId] })) as { status: number; outcome: number };
}
let feeRecipient: `0x${string}`;

function assertDelta(name: string, before: bigint, after: bigint, expected: bigint) {
  const got = after - before;
  if (got !== expected) throw new Error(`${name}: expected delta ${expected}, got ${got}`);
}

async function fund(label: string, worker: `0x${string}`, ttlSeconds: number): Promise<`0x${string}`> {
  const workId = workIdFor(label);
  const tx = await fundEscrow({ payerKey, workId, worker, amountUsdc: AMOUNT_USDC, feeUsdc: FEE_USDC, ttlSeconds });
  if ((await readEscrow(workId)).status !== 1) throw new Error(`${label}: not FUNDED`);
  console.log(`  [${label}] funded 0.05 (fee 0.01) -> worker ${worker}\n           fund=${EXPLORER}/tx/${tx}`);
  return workId;
}

async function settleViaDcw(sig: string, params: (string | number)[]): Promise<`0x${string}`> {
  const id = await executeContractCall({ contractAddress: ESCROW, abiFunctionSignature: sig, abiParameters: params });
  const tx = await waitForTxHash(id);
  if (!tx) throw new Error(`Circle DCW settlement did not confirm (circleTxId=${id})`);
  return tx;
}

// verified balance deltas for worker / payer / feeRecipient
async function proveSettle(label: string, verdictCode: number, expectedOutcome: number, d: { w: bigint; p: bigint; f: bigint }): Promise<`0x${string}`> {
  const worker = freshWorker(label);
  const workId = await fund(label, worker, 604800);
  const w0 = await bal(worker), p0 = await bal(payer), f0 = await bal(feeRecipient);
  const tx = await settleViaDcw(SETTLE_FN_SIGNATURE, [workId, verdictCode, EVIDENCE]);
  const e = await readEscrow(workId);
  if (e.status !== 2 || e.outcome !== expectedOutcome) throw new Error(`${label}: status=${e.status} outcome=${e.outcome} (want SETTLED/${expectedOutcome})`);
  assertDelta(`${label}/worker`, w0, await bal(worker), d.w);
  assertDelta(`${label}/payer`, p0, await bal(payer), d.p);
  assertDelta(`${label}/fee`, f0, await bal(feeRecipient), d.f);
  console.log(`  [${label}] SETTLED outcome=${e.outcome} — deltas verified (worker ${d.w} / payer ${d.p} / fee ${d.f})\n           settle=${EXPLORER}/tx/${tx}`);
  return tx;
}

async function provePartial(): Promise<`0x${string}`> {
  const worker = freshWorker('partial');
  const workId = await fund('partial', worker, 604800);
  const w0 = await bal(worker), p0 = await bal(payer), f0 = await bal(feeRecipient);
  const tx = await settleViaDcw(SETTLE_PARTIAL_FN_SIGNATURE, [workId, 5000, EVIDENCE]); // 50/50
  const e = await readEscrow(workId);
  if (e.status !== 2 || e.outcome !== 3) throw new Error(`partial: status=${e.status} outcome=${e.outcome}`);
  const cut = (BOUNTY * 5000n) / 10000n; // 0.02
  assertDelta('partial/worker', w0, await bal(worker), cut);
  assertDelta('partial/payer', p0, await bal(payer), BOUNTY - cut);
  assertDelta('partial/fee', f0, await bal(feeRecipient), FEE);
  console.log(`  [partial] SETTLED outcome=3 — deltas verified (worker ${cut} / payer ${BOUNTY - cut} / fee ${FEE})\n           settle=${EXPLORER}/tx/${tx}`);
  return tx;
}

async function proveExpired(): Promise<`0x${string}`> {
  const worker = freshWorker('expired');
  const workId = await fund('expired', worker, 1); // 1s deadline
  console.log('  [expired] waiting past the 1s deadline…');
  await new Promise((r) => setTimeout(r, 4000));
  const p0 = await bal(payer), f0 = await bal(feeRecipient);
  // Authorized: the payer (buyer) triggers the no-show refund. A stranger is rejected on-chain.
  const acct = privateKeyToAccount(payerKey);
  const wallet = createWalletClient({ account: acct, chain: arcTestnet, transport: http(RPC) });
  const tx = await wallet.writeContract({ address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'refundExpired', args: [workId] });
  await pub.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
  const e = await readEscrow(workId);
  if (e.status !== 2 || e.outcome !== 4) throw new Error(`expired: status=${e.status} outcome=${e.outcome}`);
  // payer delta = TOTAL refund minus the gas it paid to send this tx (gas is USDC on Arc), so assert >= 0 net-of-gas
  const pAfter = await bal(payer);
  if (pAfter <= p0) throw new Error(`expired: payer balance did not increase (before ${p0} after ${pAfter})`);
  assertDelta('expired/fee', f0, await bal(feeRecipient), 0n); // no fee on no-show
  console.log(`  [expired] SETTLED outcome=4 (payer-authorized) — payer refunded (net +${pAfter - p0} after gas), no fee\n           refund=${EXPLORER}/tx/${tx}`);
  return tx;
}

async function main() {
  feeRecipient = (await pub.readContract({ address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'feeRecipient' })) as `0x${string}`;
  console.log(`\nVerdikt v5 settlement proof (balance-delta) — escrow ${ESCROW}, feeRecipient ${feeRecipient} (${RUN})\n`);
  const r: Record<string, `0x${string}`> = {};
  r.release = await proveSettle('release', 0, 0, { w: BOUNTY, p: 0n, f: FEE });
  r.refund = await proveSettle('refund', 1, 1, { w: 0n, p: BOUNTY, f: FEE });
  r.abstain = await proveSettle('abstain', 3, 2, { w: 0n, p: TOTAL, f: 0n });
  r.partial = await provePartial();
  r.expired = await proveExpired();
  console.log('\n=== ALL FIVE PATHS: balance deltas independently verified on-chain ===');
  for (const k of OUTCOME) console.log(`| ${k.padEnd(8)} | \`${r[k]}\` |`);
}

main().catch((e) => { console.error('PROOF FAILED:', e); process.exit(1); });
