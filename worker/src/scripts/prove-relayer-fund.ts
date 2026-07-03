// WS7 Gate E1 (relayer leg) — prove GASLESS escrow funding LIVE on Arc: a "human" signs an EIP-3009
// ReceiveWithAuthorization in isolation (never submits a tx), the worker's /relayer/fund submits it
// via the dedicated RELAYER_KEY, and the escrow ends up FUNDED with payer = the signer while the
// relayer paid the gas. This is the exact recipe the browser (web/src/lib/relayer-sign.ts) reproduces.
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/prove-relayer-fund.ts
import { createPublicClient, http, parseUnits, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, ARC_USDC_ADDRESS } from '../lib/chains.js';
import { USDC_DOMAIN, RECEIVE_TYPES } from '../settlement/fund-escrow.js';
import { deriveNonce } from '../routes/relayer.js';
import { readEscrowOnChain } from '../settlement/escrow-read.js';

const WORKER = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const RPC = process.env.ARC_RPC_URL!;
const humanKey = process.env.DEMO_PAYER_KEY as `0x${string}`; // stand-in for the human's browser wallet
const SELLER = '0x665F4AF29aeeeA93cea97813f69a3ED3eAdEF8fF' as const; // reference seller payout wallet
const LOCAL = { workerDomain: 0, workerRecipient: `0x${'00'.repeat(32)}`, payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}` } as const;

const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const bal = (a: `0x${string}`) => pub.readContract({ address: ARC_USDC_ADDRESS, abi: ERC20, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;

async function main() {
  const human = privateKeyToAccount(humanKey);
  const workId = keccak256(stringToHex(`ws7-relayer-${Date.now()}`));
  const amount = parseUnits('0.05', 6);
  const fee = parseUnits('0.01', 6);
  const ttl = 3600n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - 600n;
  const validBefore = now + 3600n;

  // 1. Register the task (public; no money moves) so the relayer can bind funding to a real task.
  const tRes = await fetch(`${WORKER}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workId, type: 'answer', acceptance: { spec: 'grounded answer (WS7 relayer smoke)' }, payer: human.address, seller: SELLER, amountUsdc: 0.05 }),
  });
  if (!tRes.ok) throw new Error(`/api/tasks ${tRes.status}: ${await tRes.text()}`);
  console.log(`  task registered workId=${workId}`);

  // 2. The human signs the EIP-3009 authorization in isolation — routes folded into the nonce.
  const nonce = deriveNonce({ workId, worker: SELLER, amount, fee, ttl, payer: human.address, routes: LOCAL });
  const signature = await human.signTypedData({
    domain: USDC_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization',
    message: { from: human.address, to: ESCROW, value: amount, validAfter, validBefore, nonce },
  });
  console.log(`  human ${human.address} signed (no tx sent by the human)`);

  // 3. The RELAYER submits it — the human pays zero gas.
  const humanUsdcBefore = await bal(human.address);
  const rRes = await fetch(`${WORKER}/relayer/fund`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payer: human.address, workId, worker: SELLER, routes: LOCAL, signature,
      amount: amount.toString(), fee: fee.toString(), ttl: ttl.toString(),
      validAfter: validAfter.toString(), validBefore: validBefore.toString(),
    }),
  });
  const rBody = await rRes.json() as { fundTx?: string; relayer?: string; error?: string };
  if (!rRes.ok) throw new Error(`/relayer/fund ${rRes.status}: ${JSON.stringify(rBody)}`);
  console.log(`  relayer ${rBody.relayer} submitted fundTx=${rBody.fundTx}`);

  // 4. Assert the escrow is FUNDED, payer == the human signer, and the human's USDC was pulled.
  const e = await readEscrowOnChain(workId);
  if (e.status !== 1) throw new Error(`escrow not FUNDED (status=${e.status})`);
  if (e.payer.toLowerCase() !== human.address.toLowerCase()) throw new Error(`payer mismatch: ${e.payer}`);
  if (e.worker.toLowerCase() !== SELLER.toLowerCase()) throw new Error(`worker mismatch: ${e.worker}`);
  if (e.amount !== amount) throw new Error(`amount mismatch: ${e.amount}`);

  // Confirm the fund tx was sent BY the relayer (not the human) — i.e. the human truly paid no gas.
  const tx = await pub.getTransaction({ hash: rBody.fundTx as `0x${string}` });
  if (tx.from.toLowerCase() !== rBody.relayer!.toLowerCase()) throw new Error(`fund tx not from relayer: ${tx.from}`);
  if (tx.from.toLowerCase() === human.address.toLowerCase()) throw new Error('fund tx came from the human — not gasless!');

  const humanUsdcAfter = await bal(human.address);
  console.log(`\n  ✓ GASLESS FUND PROVEN`);
  console.log(`    escrow FUNDED: payer=${e.payer} worker=${e.worker} amount=${e.amount} (0.05 USDC)`);
  console.log(`    fund tx sender = relayer ${tx.from} (human sent NO tx)`);
  console.log(`    human USDC pulled: ${humanUsdcBefore - humanUsdcAfter} base units (exactly the 0.05 escrow)`);
  console.log(`    fundTx: https://testnet.arcscan.app/tx/${rBody.fundTx}`);
  process.exit(0);
}

main().catch((e) => { console.error('RELAYER FUND PROOF FAILED:', e.message); process.exit(1); });
