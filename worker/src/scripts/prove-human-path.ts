// WS7 Gate E1 — prove the FULL human buyer path LIVE for EVERY catalog agent, exactly as the browser
// drives it: register task -> human signs an EIP-3009 authorization (no tx) -> gasless relayer funds
// the escrow -> dispatch to the catalog seller -> the agent delivers -> verdict -> settle RELEASE.
// Asserts the human paid zero gas and the seller was paid the bounty. Runs research + data-transform
// + code (each a real reference seller), so no human-catalog agent is left unproven.
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/prove-human-path.ts [research|data-transform|code]
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
const SELLER_WALLET = '0x665F4AF29aeeeA93cea97813f69a3ED3eAdEF8fF' as const; // all reference sellers share it
const SELLERS_BASE = 'https://verdikt-reference-sellers.fly.dev';
const LOCAL = { workerDomain: 0, workerRecipient: `0x${'00'.repeat(32)}`, payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}` } as const;
const EXPLORER = 'https://testnet.arcscan.app';

// One entry per human-catalog agent: the route type, its dispatch endpoint, and a PASS example.
const AGENTS: Record<string, { path: string; type: string; acceptance: Record<string, unknown> }> = {
  research: {
    path: 'research', type: 'answer',
    acceptance: {
      spec: 'What is Arc’s approximate block time, and how many decimals does USDC use on Arc?',
      sources: 'Arc is an EVM-compatible testnet. Its block time is approximately 0.48 seconds. USDC on Arc is exposed at a predeploy address with 6 decimals.',
    },
  },
  'data-transform': {
    path: 'data-transform', type: 'tool_output',
    acceptance: {
      spec: 'ETH is trading at $3,421.55 with 92% model confidence. Extract it as JSON.',
      schema: { symbol: { type: 'string', required: true }, price: { type: 'number', required: true, min: 0 }, confidence: { type: 'number', required: true, min: 0, max: 1 } },
    },
  },
  code: {
    path: 'code', type: 'code',
    acceptance: {
      spec: 'Implement add(a, b) returning the sum of two numbers.',
      tests: 'from solution import add\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_add_negative():\n    assert add(-1, 1) == 0\n',
    },
  },
};

const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const bal = (a: `0x${string}`) => pub.readContract({ address: ARC_USDC_ADDRESS, abi: ERC20, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runAgent(name: string): Promise<void> {
  const agent = AGENTS[name];
  const human = privateKeyToAccount(humanKey);
  const workId = keccak256(stringToHex(`ws7-human-${name}-${Date.now()}`));
  const total = parseUnits('0.06', 6), fee = parseUnits('0.01', 6), bounty = total - fee;
  const ttl = 3600n, now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - 600n, validBefore = now + 3600n;
  console.log(`\n── ${name} ──`);

  const t = await fetch(`${WORKER}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workId, type: agent.type, acceptance: agent.acceptance, payer: human.address, seller: SELLER_WALLET, amountUsdc: 0.06 }) });
  if (!t.ok) throw new Error(`[${name}] /api/tasks ${t.status}: ${await t.text()}`);

  const sellerBefore = await bal(SELLER_WALLET);
  const nonce = deriveNonce({ workId, worker: SELLER_WALLET, amount: total, fee, ttl, payer: human.address, routes: LOCAL });
  const signature = await human.signTypedData({ domain: USDC_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message: { from: human.address, to: ESCROW, value: total, validAfter, validBefore, nonce } });
  const r = await fetch(`${WORKER}/relayer/fund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payer: human.address, workId, worker: SELLER_WALLET, routes: LOCAL, signature, amount: total.toString(), fee: fee.toString(), ttl: ttl.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString() }) });
  const rb = await r.json() as { fundTx?: string; relayer?: string; error?: string };
  if (!r.ok) throw new Error(`[${name}] /relayer/fund ${r.status}: ${JSON.stringify(rb)}`);
  const sender = (await pub.getTransaction({ hash: rb.fundTx as `0x${string}` })).from;
  if (sender.toLowerCase() === human.address.toLowerCase()) throw new Error(`[${name}] fund tx from human — not gasless`);
  console.log(`  gasless fund ${rb.fundTx!.slice(0, 12)}… (sender=relayer)`);

  const j = await fetch(`${WORKER}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Secret': SECRET }, body: JSON.stringify({ workId, seller: { url: `${SELLERS_BASE}/${agent.path}/dispatch`, protocol: 'webhook' } }) });
  const jb = await j.json() as { jobId?: string; error?: string };
  if (!j.ok) throw new Error(`[${name}] /api/jobs ${j.status}: ${JSON.stringify(jb)}`);

  let state = 'FUNDED', settleTx: string | undefined;
  for (let i = 0; i < 45; i++) {
    await sleep(3000);
    const s = await fetch(`${WORKER}/api/jobs/${jb.jobId}`).then((x) => x.json()) as { state: string; outcome?: string; settleTxHash?: string };
    if (s.state !== state) { state = s.state; process.stdout.write(` ${state}`); }
    if (s.state === 'SETTLED' || s.state === 'ABSTAINED' || s.state === 'EXPIRED') { settleTx = s.settleTxHash; break; }
  }
  process.stdout.write('\n');
  if (state !== 'SETTLED') throw new Error(`[${name}] did not settle (state=${state})`);

  const e = await readEscrowOnChain(workId);
  if (e.status !== 2 || e.outcome !== 0) throw new Error(`[${name}] not RELEASE (status=${e.status} outcome=${e.outcome})`);
  const delta = (await bal(SELLER_WALLET)) - sellerBefore;
  if (delta !== bounty) throw new Error(`[${name}] seller delta ${delta} != bounty ${bounty}`);
  console.log(`  ✓ RELEASE · seller +${delta} (0.05) · settle ${EXPLORER}/tx/${settleTx}`);
}

async function main() {
  const only = process.argv[2];
  const names = only ? [only] : Object.keys(AGENTS);
  for (const n of names) {
    if (!AGENTS[n]) throw new Error(`unknown agent ${n}`);
    await runAgent(n);
  }
  console.log(`\n  ✓ FULL HUMAN PATH PROVEN for: ${names.join(', ')} — gasless, verified-good work paid.`);
  process.exit(0);
}
main().catch((e) => { console.error('HUMAN PATH PROOF FAILED:', e.message); process.exit(1); });
