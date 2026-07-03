// WS7 Gate E1 security bullet — prove LIVE (against the deployed worker) that the gasless relayer
// cannot alter what the human signed: a tampered payout route and an expired authorization are both
// rejected. The signature is real; only the submitted params are tampered. No escrow is funded.
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/prove-relayer-guards.ts
import { createPublicClient, http, parseUnits, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from '../lib/chains.js';
import { USDC_DOMAIN, RECEIVE_TYPES } from '../settlement/fund-escrow.js';
import { deriveNonce } from '../routes/relayer.js';

const WORKER = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const humanKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
const SELLER = '0x665F4AF29aeeeA93cea97813f69a3ED3eAdEF8fF' as const;
const LOCAL = { workerDomain: 0, workerRecipient: `0x${'00'.repeat(32)}`, payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}` } as const;
void createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });

async function post(body: unknown) {
  const res = await fetch(`${WORKER}/relayer/fund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) as { error?: string } };
}

async function main() {
  const human = privateKeyToAccount(humanKey);
  const total = parseUnits('0.06', 6), fee = parseUnits('0.01', 6), ttl = 3600n;
  const now = BigInt(Math.floor(Date.now() / 1000));

  // (a) Tampered ROUTES: sign over LOCAL routes, submit with an attacker route that redirects the bounty.
  {
    const workId = keccak256(stringToHex(`guard-routes-${Date.now()}`));
    const validAfter = now - 600n, validBefore = now + 3600n;
    const nonce = deriveNonce({ workId, worker: SELLER, amount: total, fee, ttl, payer: human.address, routes: LOCAL });
    const signature = await human.signTypedData({ domain: USDC_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message: { from: human.address, to: ESCROW, value: total, validAfter, validBefore, nonce } });
    const evil = { workerDomain: 6, workerRecipient: `0x${'de'.repeat(32)}`, payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}` };
    const r = await post({ payer: human.address, workId, worker: SELLER, routes: evil, signature, amount: total.toString(), fee: fee.toString(), ttl: ttl.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString() });
    if (r.status !== 400) throw new Error(`tampered routes NOT rejected (status=${r.status})`);
    console.log(`  ✓ tampered routes rejected live · 400 "${r.body.error}"`);
  }

  // (b) Expired authorization: validBefore in the past.
  {
    const workId = keccak256(stringToHex(`guard-expired-${Date.now()}`));
    const validAfter = now - 7200n, validBefore = now - 60n;
    const nonce = deriveNonce({ workId, worker: SELLER, amount: total, fee, ttl, payer: human.address, routes: LOCAL });
    const signature = await human.signTypedData({ domain: USDC_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message: { from: human.address, to: ESCROW, value: total, validAfter, validBefore, nonce } });
    const r = await post({ payer: human.address, workId, worker: SELLER, routes: LOCAL, signature, amount: total.toString(), fee: fee.toString(), ttl: ttl.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString() });
    if (r.status !== 400) throw new Error(`expired auth NOT rejected (status=${r.status})`);
    console.log(`  ✓ expired authorization rejected live · 400 "${r.body.error}"`);
  }

  console.log('\n  ✓ RELAYER GUARDS PROVEN LIVE — the relayer can only submit exactly what the human signed.');
  process.exit(0);
}
main().catch((e) => { console.error('GUARDS PROOF FAILED:', e.message); process.exit(1); });
