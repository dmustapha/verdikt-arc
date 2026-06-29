import { Verdikt, type Acceptance, type Artifact } from '@verdikt/sdk';

// Regenerate the two schema (tool_output) canonical settlements natively on the live escrow:
//   schema-valid   → release, schema-invalid → refund. Deterministic (no LLM).

const ENDPOINT = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const RPC = process.env.ARC_RPC_URL;
const TX = 'https://testnet.arcscan.app/tx/';
const PAYER_KEY = (process.env.DEMO_PAYER_KEY ?? '').trim() as `0x${string}`;
const SELLER_KEY = (process.env.WORKER_GATEWAY_KEY ?? '').trim() as `0x${string}`;
const line = (s = '') => console.log(s);

const acceptance: Acceptance = {
  spec: 'Return a price feed JSON with a string symbol and a non-negative number price.',
  schema: { symbol: { type: 'string', required: true }, price: { type: 'number', required: true, min: 0 } },
  minResponseBytes: 10,
};

async function run(label: string, payload: string) {
  const payer = new Verdikt({ endpoint: ENDPOINT, rpcUrl: RPC, signer: { privateKey: PAYER_KEY } });
  const seller = new Verdikt({ endpoint: ENDPOINT, rpcUrl: RPC, signer: { privateKey: SELLER_KEY } });
  const sellerAddr = (seller as unknown as { _account: { address: `0x${string}` } })._account.address;
  await seller.seller.ensureOnboarded();
  const t = await payer.payer.createTask({ type: 'tool_output', acceptance, amountUsdc: 0.05, seller: sellerAddr });
  const artifact: Artifact = { type: 'tool_output', payload };
  const r = await seller.seller.submit({ offer: t.offer, artifact });
  line(`  ${label}: ${r.verdict.toUpperCase()} / ${r.status.toUpperCase()}  settle ${TX}${r.settlementTx}`);
}

async function main() {
  line('Schema canonical proofs (native, live escrow):');
  await run('schema-valid  ', JSON.stringify({ symbol: 'ARC-USDC', price: 1.0 }));   // conforms -> release
  await run('schema-invalid', JSON.stringify({ symbol: 'ARC-USDC', price: -5 }));    // price<0 -> fail/refund
}

main().then(() => line('[schema proofs done]')).catch((e) => { console.error('[FATAL]', e); process.exit(1); });
