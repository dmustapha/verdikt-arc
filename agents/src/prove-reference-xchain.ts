// A3 — the ASYNC reference-seller path paid CROSS-CHAIN, end-to-end (closes the review over-claim that
// fundEscrow.sellerPayout was code-capable but never run through the async seller flow):
//   register task on the DEPLOYED worker → fund a REAL Arc escrow with a CROSS-CHAIN worker payout route
//   (sellerPayout → Base Sepolia) → POST /api/jobs (worker dispatches to the DEPLOYED reference seller,
//   real Claude work) → verdict → settle() BURNS the bounty via CCTP → relayOutbound mints it on Base
//   Sepolia → assert the seller was paid ON BASE. The bounty never sat on Arc as the seller's; Arc is the
//   clearing house.
//
// Run: set -a; . ./.env; set +a; npx tsx agents/src/prove-reference-xchain.ts   (from repo root)
import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, relayOutbound } from '@verdikt/sdk';
// Reuse the worker's exact cross-chain-capable fund (sellerPayout route) — no duplicated signing.
import { fundEscrow } from '../../worker/src/settlement/fund-escrow.js';

const WORKER = process.env.DEPLOYED_WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const SELLERS = process.env.DEPLOYED_SELLERS_URL ?? 'https://verdikt-reference-sellers.fly.dev';
const SECRET = process.env.DEMO_SHARED_SECRET as string;
const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
const AMOUNT_USDC = 0.05, FEE_USDC = 0.01, BOUNTY = 40000n;
const DEST = 'baseSepolia';
const RUN = Date.now().toString();

const dest = CHAINS[DEST];
const basePub = createPublicClient({ transport: http(process.env.DEST_RPC_URL ?? dest.rpcUrl) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const baseBal = async (a: `0x${string}`) => (await basePub.readContract({ address: dest.usdc as `0x${string}`, abi: ERC20, functionName: 'balanceOf', args: [a] })) as bigint;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  if (!SECRET) throw new Error('DEMO_SHARED_SECRET required');
  const payer = privateKeyToAccount(payerKey);
  // The seller's HOME-chain payout wallet (fresh, on Base). CCTP mints here; it needs no gas.
  const sellerHome = privateKeyToAccount(keccak256(stringToHex(`xchain-seller-${RUN}`))).address;
  const workId = keccak256(stringToHex(`ref-xchain-${RUN}`));

  console.log(`A3 async reference seller → cross-chain payout on ${dest.name} (${RUN})`);
  console.log(`  seller paid on Base at: ${sellerHome}`);

  // 1. Register the task on the deployed worker.
  const reg = await fetch(`${WORKER}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workId, type: 'answer', payer: payer.address, seller: sellerHome, amountUsdc: AMOUNT_USDC,
      acceptance: { spec: 'What is the capital of France, and what river runs through it?', sources: 'France is in Western Europe. Its capital is Paris. The river Seine runs through Paris.' } }),
  });
  if (!reg.ok) throw new Error(`/api/tasks ${reg.status}: ${await reg.text()}`);

  // 2. Fund a REAL Arc escrow with a CROSS-CHAIN worker payout route (release burns to Base Sepolia).
  const fundTx = await fundEscrow({ payerKey, workId, worker: sellerHome, amountUsdc: AMOUNT_USDC, feeUsdc: FEE_USDC, ttlSeconds: 604800, sellerPayout: { domain: dest.cctpDomain, recipient: sellerHome } });
  console.log(`  funded (Arc, cross-chain route): https://testnet.arcscan.app/tx/${fundTx}`);
  await sleep(4000);

  // 3. Start the job — the deployed worker dispatches to the deployed reference seller (real Claude work).
  const b0 = await baseBal(sellerHome);
  const start = await fetch(`${WORKER}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Secret': SECRET },
    body: JSON.stringify({ workId, seller: { url: `${SELLERS}/research/dispatch`, protocol: 'webhook' } }),
  });
  if (start.status !== 202) throw new Error(`/api/jobs ${start.status}: ${await start.text()}`);
  const { jobId } = await start.json() as { jobId: string };

  // 4. Poll for the terminal settle (which BURNS the payout cross-chain).
  type JobView = { state: string; outcome: string | null; settleTxHash: string | null };
  let job: JobView | null = null;
  for (let i = 0; i < 90; i++) {
    const r = await fetch(`${WORKER}/api/jobs/${jobId}`);
    if (r.ok) { job = await r.json() as JobView; if (['SETTLED', 'ABSTAINED', 'EXPIRED'].includes(job.state)) break; }
    await sleep(2000);
  }
  if (job?.outcome !== 'release' || !job.settleTxHash) throw new Error(`expected release+settleTx, got ${job?.state}/${job?.outcome}`);
  console.log(`  settle+burn (Arc): https://testnet.arcscan.app/tx/${job.settleTxHash}`);

  // 5. Relay the outbound CCTP payout → mint on Base Sepolia.
  console.log(`  relaying outbound payout to ${dest.name}…`);
  const out = await relayOutbound({ account: payer, settleTxHash: job.settleTxHash as `0x${string}`, destChain: DEST, destRpcUrl: process.env.DEST_RPC_URL, onPoll: (s) => console.log(`    · iris(arc): ${s}`) });
  console.log(`  paid (${dest.name}): ${dest.explorerTx}${out.mintTxHash}`);

  // 6. Assert the seller was paid the exact bounty ON BASE. The public Base RPC load-balances, so a read
  // immediately after the mint can hit a node that hasn't synced the block — poll until it reflects.
  let bD = 0n;
  for (let i = 0; i < 20; i++) { bD = (await baseBal(sellerHome)) - b0; if (bD >= BOUNTY) break; await sleep(3000); }
  console.log(`  seller Base Δ${bD}`);
  if (bD !== BOUNTY) throw new Error(`seller should receive bounty ${BOUNTY} on ${dest.name}, got ${bD} (mint tx ${out.mintTxHash} — check the Transfer event if this persists)`);
  console.log(`\n✅ A3: async reference seller delivered on Arc, paid ${Number(bD) / 1e6} USDC on ${dest.name} via CCTP. fundEscrow.sellerPayout proven end-to-end (no longer code-only).`);
  process.exit(0);
}

main().catch((e) => { console.error('A3 CROSS-CHAIN REFERENCE PROOF FAILED:', e); process.exit(1); });
