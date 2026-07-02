// WS2 Gate B1 — prove the CONFIDENCE-TIER path LIVE on Arc: a `partial` verdict flows through the
// real settleVerdict() wiring (planSettlement → settlePartial via Circle DCW) and produces the exact
// on-chain bps split. Unlike prove-settlement-v5 (which calls settlePartial with a hardcoded 5000),
// this drives the split FROM a VerdictResult's confidence/score, exercising the code WS2 shipped.
//
// Run:  set -a; . ./.env; set +a;  npx tsx worker/src/scripts/prove-tier-partial.ts
import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from '../lib/chains.js';
import { fundEscrow } from '../settlement/fund-escrow.js';
import { settleVerdict } from '../settlement/settle.js';
import { planSettlement, confidenceToScore } from '../settlement/tiers.js';
import { VERDIKT_ESCROW_ABI } from '../settlement/escrow-abi.js';
import type { VerdictResult } from '../types.js';

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const USDC = '0x3600000000000000000000000000000000000000' as const;
const RPC = process.env.ARC_RPC_URL!;
const EXPLORER = 'https://testnet.arcscan.app';
const payer = process.env.DEMO_PAYER_ADDRESS as `0x${string}`;
const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;

const TOTAL = 50000n, FEE = 10000n, BOUNTY = TOTAL - FEE; // 0.05 = 0.04 bounty + 0.01 fee
const AMOUNT_USDC = 0.05, FEE_USDC = 0.01;
const CONFIDENCE = 0.7; // → score 70 → bps 7000 (a 70/30 split)
const RUN = Date.now().toString();
const EVIDENCE = keccak256(stringToHex(`verdikt-tier-partial-${RUN}`));

const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;

async function bal(a: `0x${string}`): Promise<bigint> {
  return (await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })) as bigint;
}
async function readEscrow(workId: `0x${string}`) {
  return (await pub.readContract({ address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'getEscrow', args: [workId] })) as { status: number; outcome: number };
}
function assertDelta(name: string, before: bigint, after: bigint, expected: bigint) {
  const got = after - before;
  if (got !== expected) throw new Error(`${name}: expected delta ${expected}, got ${got}`);
}

async function main() {
  const score = confidenceToScore(CONFIDENCE);
  const action = planSettlement({ verdict: 'partial', confidence: CONFIDENCE, score });
  if (action.kind !== 'settlePartial') throw new Error(`expected settlePartial, got ${action.kind}`);
  const expectedBps = action.bps; // 7000
  const workerCut = (BOUNTY * BigInt(expectedBps)) / 10000n;
  const payerCut = BOUNTY - workerCut;

  const feeRecipient = (await pub.readContract({ address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'feeRecipient' })) as `0x${string}`;
  const worker = privateKeyToAccount(keccak256(stringToHex(`tier-worker-${RUN}`))).address;
  const workId = keccak256(stringToHex(`tier-partial-${RUN}`));

  console.log(`\nWS2 confidence-tier partial proof — escrow ${ESCROW} (${RUN})`);
  console.log(`  confidence ${CONFIDENCE} → score ${score} → bps ${expectedBps} (worker ${workerCut} / payer ${payerCut} / fee ${FEE})\n`);

  // 1. Fund a fresh escrow (0.04 bounty + 0.01 fee) via the real EIP-3009 funding path.
  const fundTx = await fundEscrow({ payerKey, workId, worker, amountUsdc: AMOUNT_USDC, feeUsdc: FEE_USDC, ttlSeconds: 604800 });
  if ((await readEscrow(workId)).status !== 1) throw new Error('not FUNDED');
  console.log(`  funded -> worker ${worker}\n    fund=${EXPLORER}/tx/${fundTx}`);

  // 2. Settle THROUGH the WS2 tier wiring: a partial VerdictResult → settleVerdict → settlePartial.
  const verdict: VerdictResult = {
    verdict: 'partial', confidence: CONFIDENCE, score, citedEvidence: [], rationale: 'tier-path live proof',
    route: 'code', evidenceHash: EVIDENCE, verdictCode: 2,
  };
  const w0 = await bal(worker), p0 = await bal(payer), f0 = await bal(feeRecipient);
  const settlement = await settleVerdict(workId, verdict);

  // 3. Assert the SDK-facing settlement record.
  if (settlement.outcome !== 'partial') throw new Error(`outcome=${settlement.outcome} (want partial)`);
  if (settlement.bps !== expectedBps) throw new Error(`settlement.bps=${settlement.bps} (want ${expectedBps})`);

  // 4. Assert the on-chain state + exact balance deltas (independent of events).
  const e = await readEscrow(workId);
  if (e.status !== 2 || e.outcome !== 3) throw new Error(`status=${e.status} outcome=${e.outcome} (want SETTLED/partial=3)`);
  assertDelta('worker', w0, await bal(worker), workerCut);
  assertDelta('payer', p0, await bal(payer), payerCut);
  assertDelta('fee', f0, await bal(feeRecipient), FEE);

  console.log(`\n  ✅ SETTLED partial via tier path — deltas verified on-chain (worker +${workerCut} / payer +${payerCut} / fee +${FEE})`);
  console.log(`    settle=${EXPLORER}/tx/${settlement.txHash}`);
  console.log(`\n| tier partial | confidence ${CONFIDENCE} → bps ${expectedBps} | worker +${Number(workerCut) / 1e6} / payer +${Number(payerCut) / 1e6} / fee +${Number(FEE) / 1e6} | \`${settlement.txHash}\` |`);
}

main().catch((e) => { console.error('TIER PROOF FAILED:', e); process.exit(1); });
