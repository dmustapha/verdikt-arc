// WS2 Gate B1 — prove the TOOL_TRACE route end-to-end against the Arc escrow. Composes the real
// production pieces (runToolTraceRoute → reasonOverEvidence → settleVerdict) WITHOUT the DB layer
// (recordEvidence/… are display/audit, not the money path). Two jobs, each a fresh escrow:
//   1. conforming trace  → conforms PASS → verdict → settle on Arc
//   2. malformed trace   → conforms/valid_json FAIL → deterministic 'fail' (no LLM) → REFUND on Arc
// The conformance/reject decision is DETERMINISTIC (asserted hard); the on-chain settlement is
// asserted to be CONSISTENT with whatever verdict the engine rendered.
//
// Run:  set -a; . ./.env; set +a;  npx tsx worker/src/scripts/prove-tool-trace.ts
import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from '../lib/chains.js';
import { fundEscrow } from '../settlement/fund-escrow.js';
import { settleVerdict } from '../settlement/settle.js';
import { runToolTraceRoute } from '../engine/tool-trace-route.js';
import { reasonOverEvidence } from '../engine/reasoner.js';
import { VERDIKT_ESCROW_ABI } from '../settlement/escrow-abi.js';
import type { Acceptance, Artifact } from '../types.js';

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const USDC = '0x3600000000000000000000000000000000000000' as const;
const RPC = process.env.ARC_RPC_URL!;
const EXPLORER = 'https://testnet.arcscan.app';
const payer = process.env.DEMO_PAYER_ADDRESS as `0x${string}`;
const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;

const TOTAL = 50000n, FEE = 10000n, BOUNTY = TOTAL - FEE;
const AMOUNT_USDC = 0.05, FEE_USDC = 0.01;
const RUN = Date.now().toString();

const CALL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { tool: { type: 'string' }, input: { type: 'object' }, output: {} },
  required: ['tool', 'input', 'output'], additionalProperties: false,
};
const CONFORMING = JSON.stringify([{ tool: 'search', input: { q: 'arc usdc' }, output: ['a', 'b'] }]);
const MALFORMED = '{ this is not: valid json ]';

const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
async function bal(a: `0x${string}`): Promise<bigint> {
  return (await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })) as bigint;
}
async function readEscrow(workId: `0x${string}`) {
  return (await pub.readContract({ address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'getEscrow', args: [workId] })) as { status: number; outcome: number };
}
let feeRecipient: `0x${string}`;

async function run(label: string, payload: string, perCall: boolean) {
  const acceptance: Acceptance = { spec: 'tool trace proof', toolTrace: { jsonSchema: CALL_SCHEMA, perCall } };
  const artifact: Artifact = { type: 'tool_trace', payload };

  // 1. Verify (deterministic).
  const bundle = runToolTraceRoute(acceptance, artifact);
  const conforms = bundle.items.find((i) => i.id === 'trace:conforms');
  const validJson = bundle.items.find((i) => i.id === 'trace:valid_json');
  const hasFail = bundle.items.some((i) => i.status === 'fail');
  console.log(`\n  [${label}] valid_json=${validJson?.status ?? '-'} conforms=${conforms?.status ?? '-'} hasFail=${hasFail}`);

  // 2. Verdict (LLM only certifies a clean bundle; a fail bundle is deterministic).
  const verdict = await reasonOverEvidence(bundle);
  console.log(`           verdict=${verdict.verdict} (score ${verdict.score})`);

  // 3. Fund a fresh escrow + settle live on Arc.
  const worker = privateKeyToAccount(keccak256(stringToHex(`tt-${label}-${RUN}`))).address;
  const workId = keccak256(stringToHex(`tooltrace-${label}-${RUN}`));
  const fundTx = await fundEscrow({ payerKey, workId, worker, amountUsdc: AMOUNT_USDC, feeUsdc: FEE_USDC, ttlSeconds: 604800 });
  if ((await readEscrow(workId)).status !== 1) throw new Error(`${label}: not FUNDED`);
  const w0 = await bal(worker), p0 = await bal(payer), f0 = await bal(feeRecipient);
  const settlement = await settleVerdict(workId, verdict);
  const e = await readEscrow(workId);
  const wD = (await bal(worker)) - w0, pD = (await bal(payer)) - p0, fD = (await bal(feeRecipient)) - f0;
  console.log(`           SETTLED outcome=${settlement.outcome} (enum ${e.outcome}) worker Δ${wD} payer Δ${pD} fee Δ${fD}`);
  console.log(`           fund=${EXPLORER}/tx/${fundTx}\n           settle=${EXPLORER}/tx/${settlement.txHash}`);

  // 4. Assert on-chain state is CONSISTENT with the rendered verdict.
  if (settlement.outcome === 'release') {
    if (wD !== BOUNTY || fD !== FEE) throw new Error(`${label}: release deltas wrong (worker ${wD}, fee ${fD})`);
  } else if (settlement.outcome === 'refund') {
    if (pD !== BOUNTY || fD !== FEE) throw new Error(`${label}: refund deltas wrong (payer ${pD}, fee ${fD})`);
  } else if (settlement.outcome === 'abstain') {
    if (pD !== TOTAL || fD !== 0n) throw new Error(`${label}: abstain deltas wrong (payer ${pD}, fee ${fD})`);
  }
  return { label, verdict: verdict.verdict, outcome: settlement.outcome, conforms: conforms?.status, validJson: validJson?.status, tx: settlement.txHash };
}

async function main() {
  feeRecipient = (await pub.readContract({ address: ESCROW, abi: VERDIKT_ESCROW_ABI, functionName: 'feeRecipient' })) as `0x${string}`;
  console.log(`\nWS2 tool_trace live e2e — escrow ${ESCROW} (${RUN})`);

  const good = await run('conforming', CONFORMING, true);
  const bad = await run('malformed', MALFORMED, false);

  // Hard deterministic assertions (the core of the gate).
  if (good.conforms !== 'pass') throw new Error(`conforming trace did not conform (${good.conforms})`);
  if (bad.validJson !== 'fail') throw new Error(`malformed trace was not rejected (${bad.validJson})`);
  if (bad.verdict !== 'fail') throw new Error(`malformed trace should render 'fail', got '${bad.verdict}'`);
  if (bad.outcome !== 'refund') throw new Error(`malformed trace should REFUND, got '${bad.outcome}'`);

  console.log(`\n  ✅ tool_trace: conformance proven (conforming→conforms:pass, verdict ${good.verdict}→${good.outcome}) and malformed REJECTED→refund on Arc`);
  console.log(`  | conforming | conforms:pass | ${good.verdict} → ${good.outcome} | \`${good.tx}\` |`);
  console.log(`  | malformed  | valid_json:fail | fail → refund | \`${bad.tx}\` |`);
}

main().catch((e) => { console.error('TOOL_TRACE PROOF FAILED:', e); process.exit(1); });
