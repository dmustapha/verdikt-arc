// WS1 Gate A1 — prove the five VerdiktEscrow v5 settlement paths LIVE on Arc.
//
// Faithful to production: funding via EIP-3009 (fund-escrow.ts), settlement via the real Circle DCW
// (executeContractCall) for release/refund/abstain/partial, and the permissionless refundExpired for
// no-show. Each escrow carries a real verdict fee so the fee-in-escrow split is exercised on-chain.
//
// Run:  set -a; . ./.env; set +a;  npx tsx src/scripts/prove-settlement-v5.ts
import { createPublicClient, http, keccak256, stringToHex, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient } from 'viem';
import { arcTestnet } from '../lib/chains.js';
import { fundEscrow } from '../settlement/fund-escrow.js';
import { executeContractCall, waitForTxHash } from '../lib/circle-wallets.js';
import {
  VERDIKT_ESCROW_ABI,
  SETTLE_FN_SIGNATURE,
  SETTLE_PARTIAL_FN_SIGNATURE,
} from '../settlement/escrow-abi.js';

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const RPC = process.env.ARC_RPC_URL!;
const EXPLORER = 'https://testnet.arcscan.app';
const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
const worker = process.env.DEMO_WORKER_ADDRESS as `0x${string}`;
const keeperKey = (process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`); // pays gas for permissionless expiry

const AMOUNT = 0.05; // total escrowed (bounty + fee)
const FEE = 0.01;    // verdict fee subset -> bounty = 0.04
const EVIDENCE = keccak256(stringToHex('verdikt-v5-proof-evidence'));
const RUN = Date.now().toString();

const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const OUTCOME = ['release', 'refund', 'abstain', 'partial', 'expired'] as const;

function workIdFor(label: string): `0x${string}` {
  return keccak256(stringToHex(`v5-${label}-${RUN}`));
}

async function readEscrow(workId: `0x${string}`) {
  return (await pub.readContract({
    address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'getEscrow', args: [workId],
  })) as { status: number; outcome: number; verdictCode: number; amount: bigint; fee: bigint; deadline: bigint };
}

// Decode the settlement event(s) in a tx receipt for honest reporting.
async function settlementSummary(txHash: `0x${string}`): Promise<string> {
  const receipt = await pub.getTransactionReceipt({ hash: txHash });
  const parts: string[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ESCROW.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: VERDIKT_ESCROW_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === 'Settled') { const a = ev.args as any; parts.push(`Settled outcome=${a.outcome} to=${a.to} amount=${a.amount}`); }
      else if (ev.eventName === 'SettledPartial') { const a = ev.args as any; parts.push(`SettledPartial worker=${a.workerAmount} payer=${a.payerAmount} bps=${a.bps}`); }
      else if (ev.eventName === 'Expired') { const a = ev.args as any; parts.push(`Expired to=${a.to} amount=${a.amount}`); }
      else if (ev.eventName === 'FeePaid') { const a = ev.args as any; parts.push(`FeePaid ${a.amount}`); }
    } catch { /* non-matching log */ }
  }
  return parts.join(' | ') || '(no escrow events decoded)';
}

async function fund(label: string, ttlSeconds: number): Promise<`0x${string}`> {
  const workId = workIdFor(label);
  const fundTx = await fundEscrow({ payerKey, workId, worker, amountUsdc: AMOUNT, feeUsdc: FEE, ttlSeconds });
  const e = await readEscrow(workId);
  if (e.status !== 1) throw new Error(`${label}: fund did not reach FUNDED (status=${e.status})`);
  console.log(`  [${label}] funded ${AMOUNT} USDC (fee ${FEE}) tx=${EXPLORER}/tx/${fundTx}`);
  return workId;
}

async function settleViaDcw(label: string, signature: string, params: (string | number)[]): Promise<`0x${string}`> {
  const circleId = await executeContractCall({ contractAddress: ESCROW, abiFunctionSignature: signature, abiParameters: params });
  const txHash = await waitForTxHash(circleId);
  if (!txHash) throw new Error(`${label}: Circle DCW settlement did not confirm (circleTxId=${circleId})`);
  return txHash;
}

async function proveSettle(label: string, verdictCode: number, expectedOutcome: number): Promise<[string, string]> {
  const workId = await fund(label, 604800);
  const txHash = await settleViaDcw(label, SETTLE_FN_SIGNATURE, [workId, verdictCode, EVIDENCE]);
  const e = await readEscrow(workId);
  if (e.status !== 2 || e.outcome !== expectedOutcome) {
    throw new Error(`${label}: expected SETTLED outcome=${expectedOutcome}, got status=${e.status} outcome=${e.outcome}`);
  }
  const summary = await settlementSummary(txHash);
  console.log(`  [${label}] SETTLED outcome=${e.outcome} :: ${summary}\n           tx=${EXPLORER}/tx/${txHash}`);
  return [txHash, summary];
}

async function provePartial(): Promise<[string, string]> {
  const label = 'partial';
  const workId = await fund(label, 604800);
  const txHash = await settleViaDcw(label, SETTLE_PARTIAL_FN_SIGNATURE, [workId, 5000, EVIDENCE]); // 50/50 split
  const e = await readEscrow(workId);
  if (e.status !== 2 || e.outcome !== 3) throw new Error(`partial: expected outcome=3, got status=${e.status} outcome=${e.outcome}`);
  const summary = await settlementSummary(txHash);
  console.log(`  [partial] SETTLED outcome=3 :: ${summary}\n           tx=${EXPLORER}/tx/${txHash}`);
  return [txHash, summary];
}

async function proveExpired(): Promise<[string, string]> {
  const label = 'expired';
  const workId = await fund(label, 1); // 1s deadline
  console.log('  [expired] waiting past the 1s deadline…');
  await new Promise((r) => setTimeout(r, 4000));
  // Permissionless: any funded key can trigger the no-show refund. Use the deployer as a keeper.
  const keeper = privateKeyToAccount(keeperKey);
  const wallet = createWalletClient({ account: keeper, chain: arcTestnet, transport: http(RPC) });
  const txHash = await wallet.writeContract({ address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'refundExpired', args: [workId] });
  await pub.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  const e = await readEscrow(workId);
  if (e.status !== 2 || e.outcome !== 4) throw new Error(`expired: expected outcome=4, got status=${e.status} outcome=${e.outcome}`);
  const summary = await settlementSummary(txHash);
  console.log(`  [expired] SETTLED outcome=4 (permissionless) :: ${summary}\n           tx=${EXPLORER}/tx/${txHash}`);
  return [txHash, summary];
}

async function main() {
  console.log(`\nVerdikt v5 settlement proof — escrow ${ESCROW} on Arc (${RUN})\n`);
  const results: Record<string, [string, string]> = {};
  results.release = await proveSettle('release', 0, 0); // pass  -> release
  results.refund = await proveSettle('refund', 1, 1);   // fail  -> refund
  results.abstain = await proveSettle('abstain', 3, 2); // abstain-> abstain
  results.partial = await provePartial();               // partial split
  results.expired = await proveExpired();               // no-show refund

  console.log('\n=== PROOF SUMMARY (all five paths live) ===');
  for (const k of OUTCOME) {
    console.log(`${k.padEnd(9)} ${EXPLORER}/tx/${results[k][0]}`);
  }
  console.log('\nMARKDOWN:');
  for (const k of OUTCOME) {
    console.log(`| ${k} | \`${results[k][0]}\` | ${results[k][1]} |`);
  }
}

main().catch((e) => { console.error('PROOF FAILED:', e); process.exit(1); });
