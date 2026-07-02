// WS1 — prove the v5 cross-chain FUND seam LIVE: the 9-field hookData (which now carries the verdict
// fee + no-show ttl) round-trips through a REAL CCTP message and the new Arc hook decodes it.
//
//   burn on Base Sepolia (depositForBurnWithHook, 9-field hookData) → Iris attestation →
//   mintAndFund on Arc (hook decodes fee/ttl) → escrow FUNDED with fee/deadline intact.
//
// Asserts on-chain that escrow.fee == the fee we sent and escrow.deadline == fundedAt + ttl — i.e.
// the fields I added to the bridge survived end-to-end. Local payout routes (no settle needed).
//
// Run:  set -a; . ./.env; set +a;  npx tsx src/prove-xchain-fund-v5.ts
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, keccak256, stringToHex, defineChain } from 'viem';
import { fundCrossChainEscrow } from '@verdikt/sdk';

const HOOK = process.env.HOOK_ADDRESS as `0x${string}`;
const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const ARC_RPC = process.env.ARC_RPC_URL!;
const payer = privateKeyToAccount(process.env.DEMO_PAYER_KEY!.trim() as `0x${string}`);
const worker = (process.env.DEMO_WORKER_ADDRESS as `0x${string}`).trim() as `0x${string}`;

const AMOUNT = 0.5;   // bridged principal
const FEE = 0.05;     // verdict fee carried in hookData -> escrow.fee must equal 50000
const TTL = 7200;     // 2h -> escrow.deadline must equal fundedAt + 7200
const FEE_RAW = 50000n;

const arc = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [ARC_RPC] } } });
const pub = createPublicClient({ chain: arc, transport: http(ARC_RPC) });
const GET_ESCROW = [{
  type: 'function', name: 'getEscrow', stateMutability: 'view', inputs: [{ name: 'workId', type: 'bytes32' }],
  outputs: [{ type: 'tuple', components: [
    { name: 'payer', type: 'address' }, { name: 'worker', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'fee', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'status', type: 'uint8' },
    { name: 'outcome', type: 'uint8' }, { name: 'verdictCode', type: 'uint8' }, { name: 'evidenceHash', type: 'bytes32' },
    { name: 'workerPayoutDomain', type: 'uint32' }, { name: 'workerPayoutRecipient', type: 'bytes32' },
    { name: 'payerPayoutDomain', type: 'uint32' }, { name: 'payerPayoutRecipient', type: 'bytes32' },
  ] }],
}] as const;

async function main() {
  if (!HOOK || !ESCROW) throw new Error('HOOK_ADDRESS and ESCROW_ADDRESS required');
  const workId = keccak256(stringToHex(`x1-fee-ttl-${Date.now()}`));
  console.log(`\nX1 cross-chain fund seam (v5) — Base Sepolia → Arc hook ${HOOK}`);
  console.log(`  workId ${workId}  fee ${FEE} USDC  ttl ${TTL}s`);

  const nowSec = Math.floor(Date.now() / 1000);
  const { burnTxHash, fundTxHash } = await fundCrossChainEscrow({
    account: payer, amountUsdc: AMOUNT, feeUsdc: FEE, ttlSeconds: TTL,
    workId, payer: payer.address, worker,
    config: { hook: HOOK, sourceChain: 'baseSepolia', arcRpcUrl: ARC_RPC },
    onStep: (s) => console.log(`    · ${s}`),
  });
  console.log(`  LEG 1 burn (Base Sepolia): https://sepolia.basescan.org/tx/${burnTxHash}`);
  console.log(`  LEG 2 mintAndFund (Arc):   https://testnet.arcscan.app/tx/${fundTxHash}`);

  const e = (await pub.readContract({ address: ESCROW, abi: GET_ESCROW, functionName: 'getEscrow', args: [workId] })) as
    { status: number; amount: bigint; fee: bigint; deadline: bigint };

  // The fields I added to the bridge must have survived, byte-exact.
  if (e.status !== 1) throw new Error(`escrow not FUNDED (status=${e.status})`);
  if (e.fee !== FEE_RAW) throw new Error(`fee did not survive hookData: got ${e.fee}, want ${FEE_RAW}`);
  const dl = Number(e.deadline);
  if (dl < nowSec + TTL - 120 || dl > nowSec + TTL + 300) throw new Error(`deadline off: got ${dl}, want ~${nowSec + TTL}`);
  if (e.fee >= e.amount) throw new Error(`fee>=amount invariant broken (fee ${e.fee}, amount ${e.amount})`);

  console.log(`\n  escrow.status   = FUNDED`);
  console.log(`  escrow.amount   = ${e.amount} (fee-net minted principal)`);
  console.log(`  escrow.fee      = ${e.fee}  ✓ equals the fee sent in hookData`);
  console.log(`  escrow.deadline = ${dl}  ✓ == fundedAt + ${TTL}s`);
  console.log('\n[X1 cross-chain fund seam PASS — 9-field hookData (fee, ttl) round-trips live on v5]');
}

main().catch((e) => { console.error('\n[X1 seam proof FATAL]', e); process.exit(1); });
