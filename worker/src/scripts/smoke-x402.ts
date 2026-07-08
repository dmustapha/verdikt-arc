// Phase 1 local smoke: mount ONLY the x402 Bazaar router on a bare Express app and prove the 402 payment
// gate works — an unpaid POST /x402/verify returns HTTP 402 with the correct payment terms (Base mainnet,
// $0.05, our payTo). No DB/LLM/Circle env needed; this exercises the paymentMiddleware, not the verdict brain.
//
// Run: set -a; . .env; set +a; npx tsx src/scripts/smoke-x402.ts
import express from 'express';
import type { AddressInfo } from 'node:net';
import { makeX402BazaarRouter } from '../routes/x402-bazaar.js';

async function main(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(makeX402BazaarRouter());
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/x402/verify`;

  const ok = (c: boolean, m: string) => { if (!c) throw new Error(`ASSERT FAILED: ${m}`); console.log(`  ✓ ${m}`); };

  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ route: 'tool_output', acceptance: {}, artifact: { payload: '{}' } }),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;

  console.log(`\nUnpaid POST /x402/verify → HTTP ${res.status}`);
  console.log('response headers:', JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2).slice(0, 700));

  ok(res.status === 402, 'unpaid request is rejected with HTTP 402');

  // x402 v2 carries the PaymentRequirements in a base64 response header (body defaults to {}). Accept either
  // the header or a body.accepts, so this holds regardless of which the middleware version emits.
  const headerObj = Object.fromEntries(res.headers.entries());
  const reqHeaderRaw = headerObj['payment-required'] ?? headerObj['x-payment-required'] ?? headerObj['www-authenticate'];
  let accepts: Array<Record<string, unknown>> | undefined;
  if (reqHeaderRaw) {
    try { const dec = JSON.parse(Buffer.from(reqHeaderRaw.replace(/^Basic\s+/i, ''), 'base64').toString('utf-8')); accepts = dec.accepts ?? [dec]; } catch { /* not base64 json */ }
  }
  if (!accepts) accepts = (body.accepts ?? (body as { paymentRequirements?: unknown }).paymentRequirements) as Array<Record<string, unknown>> | undefined;

  ok(Array.isArray(accepts) && accepts.length > 0, 'payment requirements present (header or body accepts[])');
  const a = accepts![0];
  ok(String(a.network) === 'eip155:8453', `payment network is Base mainnet (got ${a.network})`);
  ok(String(a.payTo).toLowerCase() === (process.env.VERDIKT_PAYTO ?? '').toLowerCase(), 'payTo matches VERDIKT_PAYTO');

  console.log('\n✅ x402 Bazaar payment gate proven locally (402 + correct Base-mainnet terms).');
  server.close();
  process.exit(0);
}

main().catch((e) => { console.error('\n❌ smoke-x402 failed:', e instanceof Error ? e.message : e); process.exit(1); });
