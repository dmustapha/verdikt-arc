import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@vercel/postgres';
import { saveSeller, listHealthySellers, getSeller } from '../../src/lib/seller-store.js';
import type { SellerRow } from '../../src/lib/seller-store.js';

// Integration: the vk_sellers registry table on live Neon. Unique suffix per run; rows cleaned in
// afterAll. Proves round-trip persistence and that the catalog list returns HEALTHY sellers only.
const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const ids: string[] = [];

function row(tag: string, status: SellerRow['status']): SellerRow {
  const sellerId = `slr-${suffix}-${tag}`;
  ids.push(sellerId);
  return {
    sellerId, endpoint: `https://seller-${tag}.example.com`, protocol: 'a2a',
    capability: `cap-${tag}`, wallet: `0x${'ab'.repeat(20)}`, payoutDomain: 6,
    agentId: tag === 'agent' ? '99' : undefined, status, termsAccepted: true,
  };
}

beforeAll(() => { if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL required'); });
afterAll(async () => { for (const id of ids) await sql`DELETE FROM vk_sellers WHERE seller_id = ${id}`; });

describe('seller-store', () => {
  it('round-trips a saved seller, preserving the optional agentId', async () => {
    const r = row('agent', 'healthy');
    await saveSeller(r);
    const got = await getSeller(r.sellerId);
    expect(got).not.toBeNull();
    expect(got!.endpoint).toBe(r.endpoint);
    expect(got!.protocol).toBe('a2a');
    expect(got!.payoutDomain).toBe(6);
    expect(got!.agentId).toBe('99');
    expect(got!.status).toBe('healthy');
    expect(got!.termsAccepted).toBe(true);
  });

  it('listHealthySellers returns only healthy rows', async () => {
    const healthy = row('ok', 'healthy');
    const sick = row('sick', 'unhealthy');
    await saveSeller(healthy);
    await saveSeller(sick);
    const list = await listHealthySellers();
    const ids = list.map((s) => s.sellerId);
    expect(ids).toContain(healthy.sellerId);
    expect(ids).not.toContain(sick.sellerId);
  });
});
