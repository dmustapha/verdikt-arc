import { GatewayClient } from '@circle-fin/x402-batching/client';

let _client: GatewayClient | null = null;
function client(): GatewayClient {
  if (!_client) {
    const pk = (process.env.WORKER_GATEWAY_KEY ?? '').trim();
    if (!pk) throw new Error('WORKER_GATEWAY_KEY not set');
    _client = new GatewayClient({ chain: 'arcTestnet', privateKey: pk as `0x${string}` });
  }
  return _client;
}

export async function depositFee(amountUsdc: string): Promise<void> {
  await client().deposit(amountUsdc);
}

// Pay the x402-metered /api/verdict endpoint with the artifact body.
export async function payVerdict(url: string, body: unknown): Promise<unknown> {
  const res = await client().pay<unknown>(url, { method: 'POST', body });
  return res.data;
}

// CLI: deposit the worker's Gateway balance for the verdict fee.
// Usage: WORKER_GATEWAY_KEY=… tsx scripts/gateway-buyer.ts deposit 0.05
if (process.argv[2] === 'deposit') {
  depositFee(process.argv[3] ?? '0.05')
    .then(() => console.log('[gateway-buyer] deposited', process.argv[3] ?? '0.05', 'USDC'))
    .catch((e) => { console.error('[gateway-buyer] deposit failed:', e); process.exit(1); });
}
