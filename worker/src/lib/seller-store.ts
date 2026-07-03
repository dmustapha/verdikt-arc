import { sql } from '@vercel/postgres';
import type { SellerRegistration } from './registry.js';
import type { SellerProtocol } from './job-store.js';

// DB layer for the WS4 seller registry (vk_sellers, schema in scripts/migrate.ts). Only `healthy`
// sellers are ever listed in the catalog; the register route probes and stamps status on insert.

export type SellerStatus = 'healthy' | 'unhealthy';
export interface SellerRow extends SellerRegistration { sellerId: string; status: SellerStatus }

interface SellerDbRow {
  seller_id: string; endpoint: string; protocol: string; capability: string; wallet: string;
  payout_domain: number; agent_id: string | null; status: string; terms_accepted: boolean;
  acceptance_template: { spec: string; inputLabel: string } | null;
}

function toRow(r: SellerDbRow): SellerRow {
  return {
    sellerId: r.seller_id, endpoint: r.endpoint, protocol: r.protocol as SellerProtocol,
    capability: r.capability, wallet: r.wallet, payoutDomain: Number(r.payout_domain),
    agentId: r.agent_id ?? undefined, status: r.status as SellerStatus, termsAccepted: r.terms_accepted,
    acceptanceTemplate: r.acceptance_template ?? undefined,
  };
}

export async function saveSeller(s: SellerRow): Promise<void> {
  // JSONB template stored as a JSON string (mirrors vk_tasks.acceptance) — null when unset.
  const template = s.acceptanceTemplate ? JSON.stringify(s.acceptanceTemplate) : null;
  await sql`
    INSERT INTO vk_sellers (seller_id, endpoint, protocol, capability, wallet, payout_domain, agent_id, status, terms_accepted, acceptance_template, last_probe_at)
    VALUES (${s.sellerId}, ${s.endpoint}, ${s.protocol}, ${s.capability}, ${s.wallet}, ${s.payoutDomain},
            ${s.agentId ?? null}, ${s.status}, ${s.termsAccepted}, ${template}, now())
    ON CONFLICT (seller_id) DO UPDATE SET
      endpoint = EXCLUDED.endpoint, protocol = EXCLUDED.protocol, capability = EXCLUDED.capability,
      wallet = EXCLUDED.wallet, payout_domain = EXCLUDED.payout_domain, agent_id = EXCLUDED.agent_id,
      status = EXCLUDED.status, terms_accepted = EXCLUDED.terms_accepted,
      acceptance_template = EXCLUDED.acceptance_template, last_probe_at = now()`;
}

export async function getSeller(sellerId: string): Promise<SellerRow | null> {
  const r = await sql`SELECT * FROM vk_sellers WHERE seller_id = ${sellerId} LIMIT 1`;
  return r.rows.length ? toRow(r.rows[0] as SellerDbRow) : null;
}

export async function listHealthySellers(): Promise<SellerRow[]> {
  const r = await sql`SELECT * FROM vk_sellers WHERE status = 'healthy' ORDER BY created_at ASC`;
  return r.rows.map((row) => toRow(row as SellerDbRow));
}
