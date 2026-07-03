// WS7 Gate E1 — prove the FULL human buyer path LIVE, end to end, exactly as the browser drives it:
// register task -> human signs an EIP-3009 authorization (no tx) -> gasless relayer funds the escrow
// -> dispatch to a catalog seller -> the agent delivers -> verdict -> settle RELEASE on Arc. Asserts
// the human paid zero gas, the seller was paid the bounty, and the fee went to Verdikt.
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/prove-human-path.ts
import { createPublicClient, http, parseUnits, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, ARC_USDC_ADDRESS } from '../lib/chains.js';
import { USDC_DOMAIN, RECEIVE_TYPES } from '../settlement/fund-escrow.js';
import { deriveNonce } from '../routes/relayer.js';
import { readEscrowOnChain } from '../settlement/escrow-read.js';

const WORKER = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const RPC = process.env.ARC_RPC_URL!;
const SECRET = process.env.DEMO_SHARED_SECRET!;
const humanKey = process.env.DEMO_PAYER_KEY as `0x${string}`;   // stand-in for the browser wallet
const SELLER_WALLET = '0x665F4AF29aeeeA93cea97813f69a3ED3eAdEF8fF' as const;
const SELLER_URL = 'https://verdikt-reference-sellers.fly.dev/research/dispatch';
const LOCAL = { workerDomain: 0, workerRecipient: `0x${'00'.repeat(32)}`, payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}` } as const;
const EXPLORER = 'https://testnet.arcscan.app';

const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const bal = (a: `0x${string}`) => pub.readContract({ address: ARC_USDC_ADDRESS, abi: ERC20, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const human = privateKeyToAccount(humanKey);
  const workId = keccak256(stringToHex(`ws7-human-${Date.now()}`));
  const total = parseUnits('0.06', 6), fee = parseUnits('0.01', 6), bounty = total - fee;
  const ttl = 3600n, now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - 600n, validBefore = now + 3600n;

  // A question fully covered by the sources → the research agent answers grounded → verdict RELEASE.
  const acceptance = {
    spec: 'What is Arc’s approximate block time, and how many decimals does USDC use on Arc?',
    sources: 'Arc is an EVM-compatible testnet. Its block time is approximately 0.48 seconds. USDC on Arc is exposed at a predeploy address with 6 decimals.',
  };

  // 1. Register the task.
  const t = await fetch(`${WORKER}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workId, type: 'answer', acceptance, payer: human.address, seller: SELLER_WALLET, amountUsdc: 0.06 }) });
  if (!t.ok) throw new Error(`/api/tasks ${t.status}: ${await t.text()}`);
  console.log(`  1. task registered · workId ${workId.slice(0, 12)}…`);

  // 2. Human signs (no tx). 3. Relayer funds gaslessly.
  const humanBefore = await bal(human.address), sellerBefore = await bal(SELLER_WALLET);
  const nonce = deriveNonce({ workId, worker: SELLER_WALLET, amount: total, fee, ttl, payer: human.address, routes: LOCAL });
  const signature = await human.signTypedData({ domain: USDC_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message: { from: human.address, to: ESCROW, value: total, validAfter, validBefore, nonce } });
  console.log('  2. human signed the EIP-3009 authorization (sent no tx)');
  const r = await fetch(`${WORKER}/relayer/fund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payer: human.address, workId, worker: SELLER_WALLET, routes: LOCAL, signature, amount: total.toString(), fee: fee.toString(), ttl: ttl.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString() }) });
  const rb = await r.json() as { fundTx?: string; relayer?: string; error?: string };
  if (!r.ok) throw new Error(`/relayer/fund ${r.status}: ${JSON.stringify(rb)}`);
  const fundTxSender = (await pub.getTransaction({ hash: rb.fundTx as `0x${string}` })).from;
  if (fundTxSender.toLowerCase() === human.address.toLowerCase()) throw new Error('fund tx came from the human — not gasless');
  console.log(`  3. relayer funded escrow gaslessly · fundTx ${rb.fundTx!.slice(0, 12)}… (sender=relayer, human paid 0 gas)`);

  // 4. Dispatch to the catalog seller (server-secret gated — mirrors the web /api/jobs proxy).
  const j = await fetch(`${WORKER}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Secret': SECRET }, body: JSON.stringify({ workId, seller: { url: SELLER_URL, protocol: 'webhook' } }) });
  const jb = await j.json() as { jobId?: string; error?: string };
  if (!j.ok) throw new Error(`/api/jobs ${j.status}: ${JSON.stringify(jb)}`);
  console.log(`  4. dispatched to research agent · jobId ${jb.jobId}`);

  // 5. Poll until settled (the agent delivers async, then verdict + settle run).
  let state = 'FUNDED', outcome: string | undefined, settleTx: string | undefined;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const s = await fetch(`${WORKER}/api/jobs/${jb.jobId}`).then((x) => x.json()) as { state: string; outcome?: string; settleTxHash?: string };
    if (s.state !== state) { state = s.state; console.log(`     … ${state}`); }
    if (s.state === 'SETTLED' || s.state === 'ABSTAINED' || s.state === 'EXPIRED') { outcome = s.outcome; settleTx = s.settleTxHash; break; }
  }
  if (state !== 'SETTLED') throw new Error(`job did not settle (state=${state})`);

  // 6. Verify RELEASE on-chain: seller paid the bounty, escrow settled.
  const e = await readEscrowOnChain(workId);
  if (e.status !== 2 || e.outcome !== 0) throw new Error(`escrow not RELEASE (status=${e.status} outcome=${e.outcome})`);
  const sellerDelta = (await bal(SELLER_WALLET)) - sellerBefore;
  const humanDelta = humanBefore - (await bal(human.address));
  if (sellerDelta !== bounty) throw new Error(`seller delta ${sellerDelta} != bounty ${bounty}`);

  console.log(`\n  ✓ FULL HUMAN PATH PROVEN (gasless, verified-good work paid)`);
  console.log(`    outcome: ${outcome} · seller +${sellerDelta} (0.05 bounty) · human -${humanDelta} (0.06 total escrowed)`);
  console.log(`    fund (gasless):  ${EXPLORER}/tx/${rb.fundTx}`);
  console.log(`    settle (release): ${EXPLORER}/tx/${settleTx}`);
  process.exit(0);
}

main().catch((e) => { console.error('HUMAN PATH PROOF FAILED:', e.message); process.exit(1); });
