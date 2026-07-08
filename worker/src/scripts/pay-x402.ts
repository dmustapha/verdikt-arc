// Phase 1 LIVE PROOF: a paying x402 client calls Verdikt's Bazaar endpoint on Base mainnet.
//
// Wraps fetch with the @x402 payment interceptor (EIP-3009 transferWithAuthorization, offline-signed by the
// buyer key — gasless, the CDP facilitator fronts gas). Flow: POST /x402/verify → 402 → sign $0.05 USDC →
// retry with X-Payment → the worker verifies+settles via the CDP facilitator → 200 with the verdict and an
// X-Payment-Response header carrying the on-chain settlement tx. Artifact of the proof = that settlement tx
// (payer = the buyer wallet, a real external caller of the paid endpoint).
//
// Run: set -a; . ../agents/acp-evaluator/.env; set +a; npx tsx src/scripts/pay-x402.ts
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import type { PaymentRequirements, SelectPaymentRequirements } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const WORKER = process.env.TARGET_URL ?? 'https://verdikt-worker.fly.dev';
const NETWORK = 'eip155:8453';

async function main(): Promise<void> {
  const key = process.env.LIVE_BUYER_KEY as `0x${string}` | undefined;
  if (!key) throw new Error('set LIVE_BUYER_KEY (the Base payer) — source agents/acp-evaluator/.env');
  const signer = privateKeyToAccount(key);
  console.log(`payer (external client): ${signer.address}`);

  // Only ever sign the cheapest offer; a real client caps its spend. Here there is exactly one ($0.05).
  const select: SelectPaymentRequirements = (_v, reqs: PaymentRequirements[]) => {
    if (!reqs.length) throw new Error('no payable requirement offered');
    return reqs.reduce((lo, r) => (BigInt(r.amount) < BigInt(lo.amount) ? r : lo));
  };
  const client = new x402Client(select).register(NETWORK, new ExactEvmScheme(signer as unknown as ConstructorParameters<typeof ExactEvmScheme>[0]));
  const payFetch = wrapFetchWithPayment(fetch, client);

  // A schema-valid deliverable → Verdikt should return a `pass` verdict.
  const deliverable = {
    route: 'tool_output',
    acceptance: { jsonSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false } },
    artifact: { payload: '{"ok":true}' },
  };

  console.log(`POST ${WORKER}/x402/verify (paying $0.05 USDC on Base via EIP-3009)…`);
  const res = await payFetch(`${WORKER}/x402/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(deliverable),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`\n← HTTP ${res.status}`);
  console.log('verdict body:', JSON.stringify(body, null, 2).slice(0, 700));

  const payRespRaw = res.headers.get('x-payment-response') ?? res.headers.get('payment-response');
  if (payRespRaw) {
    try {
      const decoded = decodePaymentResponseHeader(payRespRaw) as { transaction?: string; network?: string; success?: boolean };
      console.log('\nSETTLEMENT (X-Payment-Response):', JSON.stringify(decoded, null, 2));
      if (decoded.transaction) console.log(`\n✅ on-chain settlement: https://basescan.org/tx/${decoded.transaction}`);
    } catch (e) { console.log('could not decode payment-response header:', e instanceof Error ? e.message : e); console.log('raw:', payRespRaw.slice(0, 120)); }
  } else {
    console.log('\n(no X-Payment-Response header on the response)');
  }

  process.exit(res.status === 200 ? 0 : 1);
}

main().catch((e) => { console.error('\n❌ pay-x402 failed:', e instanceof Error ? e.message : e); process.exit(1); });
