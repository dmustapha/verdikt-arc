import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateRegistration, probeSeller } from '../lib/registry.js';
import type { SellerRegistration } from '../lib/registry.js';
import { saveSeller, listHealthySellers } from '../lib/seller-store.js';
import type { SellerRow, SellerStatus } from '../lib/seller-store.js';
import { createRateLimiter, clientIp } from '../lib/rate-limit.js';

// Seller registry routes (WS4). POST /sellers/register validates a terms-accepted registration, runs a
// live HEALTH PROBE, and stores the seller stamped healthy/unhealthy — only healthy sellers are ever
// listed. GET /sellers is the catalog source (the human buyer's curated list, WS7). Handlers are
// DB-free/injected (like callback.ts) so the register gate is unit-testable; the wrapper wires the
// real probe + store. Registration is the ONLY way onto the catalog — Verdikt never crawls the
// ecosystem (MASTER-PLAN: "NOT a marketplace / aggregator").

export interface RegisterDeps {
  probe(seller: Pick<SellerRegistration, 'endpoint' | 'protocol'>): Promise<boolean>;
  save(row: SellerRow): Promise<void>;
  newId(): string;
}
export interface ListDeps { list(): Promise<SellerRow[]>; }
export interface HandlerResult { status: number; body: Record<string, unknown>; }

export async function handleRegister(deps: RegisterDeps, body: unknown): Promise<HandlerResult> {
  const v = validateRegistration(body);
  if (!v.ok) return { status: 400, body: { error: v.error } };

  const healthy = await deps.probe({ endpoint: v.value.endpoint, protocol: v.value.protocol });
  const status: SellerStatus = healthy ? 'healthy' : 'unhealthy';
  const sellerId = deps.newId();
  await deps.save({ ...v.value, sellerId, status });

  // A withheld (unhealthy) seller is stored but never listed — it can re-register once reachable.
  return { status: 201, body: { sellerId, status, listed: healthy } };
}

// Public catalog projection — the fields a buyer needs to pick an agent (no internal-only leakage).
function publicView(s: SellerRow) {
  return {
    sellerId: s.sellerId, endpoint: s.endpoint, protocol: s.protocol, capability: s.capability,
    wallet: s.wallet, payoutDomain: s.payoutDomain, agentId: s.agentId,
    // WS7: the human catalog renders this — governing criterion + what the buyer supplies.
    acceptanceTemplate: s.acceptanceTemplate,
  };
}

export async function handleList(deps: ListDeps): Promise<HandlerResult> {
  const sellers = await deps.list();
  return { status: 200, body: { sellers: sellers.map(publicView) } };
}

// ── Express wrapper ──────────────────────────────────────────────────────────
export function makeSellersRouter(): Router {
  const router = Router();
  const probeTimeoutMs = Number(process.env.SELLER_PROBE_TIMEOUT_MS ?? 5000);
  // Registration triggers an outbound probe + a DB write — rate-limit per IP so it can't be abused.
  const registerLimit = createRateLimiter({ perIp: Number(process.env.SELLERS_PER_IP ?? 20), ipWindowMs: 10 * 60 * 1000 });

  const deps: RegisterDeps = {
    probe: (seller) => probeSeller(seller, { fetchFn: fetch, timeoutMs: probeTimeoutMs }),
    save: saveSeller,
    newId: () => `vk_${randomUUID()}`,
  };

  router.post('/sellers/register', async (req, res) => {
    const limited = registerLimit(clientIp(req), Date.now());
    if (limited) { res.status(429).json({ error: limited }); return; }
    const r = await handleRegister(deps, req.body);
    res.status(r.status).json(r.body);
  });

  router.get('/sellers', async (_req, res) => {
    const r = await handleList({ list: listHealthySellers });
    res.status(r.status).json(r.body);
  });

  return router;
}
