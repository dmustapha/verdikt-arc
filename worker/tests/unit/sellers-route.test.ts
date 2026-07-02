import { describe, it, expect, vi } from 'vitest';
import { handleRegister, handleList } from '../../src/routes/sellers.js';
import type { RegisterDeps, ListDeps } from '../../src/routes/sellers.js';
import type { SellerRow } from '../../src/lib/seller-store.js';

// The register/list handlers are money-free and DB-free (injected deps), mirroring callback.ts. They
// enforce the WS4 registry gate: validate → probe → list only the healthy. HTTP wiring is a thin shell.

const validBody = {
  endpoint: 'https://seller.example.com', protocol: 'a2a', capability: 'research-summary',
  wallet: `0x${'ab'.repeat(20)}`, payoutDomain: 6, agentId: '42', termsAccepted: true,
};

function registerDeps(probeResult: boolean): RegisterDeps & { saved: SellerRow[] } {
  const saved: SellerRow[] = [];
  return {
    saved,
    probe: vi.fn().mockResolvedValue(probeResult),
    save: vi.fn(async (row: SellerRow) => { saved.push(row); }),
    newId: () => 'slr-fixed',
  };
}

describe('handleRegister', () => {
  it('a healthy seller is stored healthy and listed', async () => {
    const deps = registerDeps(true);
    const r = await handleRegister(deps, validBody);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('healthy');
    expect(r.body.listed).toBe(true);
    expect(deps.saved[0].status).toBe('healthy');
    expect(deps.saved[0].sellerId).toBe('slr-fixed');
  });

  it('a valid but unhealthy seller is stored unhealthy and WITHHELD from the catalog', async () => {
    const deps = registerDeps(false);
    const r = await handleRegister(deps, validBody);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('unhealthy');
    expect(r.body.listed).toBe(false);
    expect(deps.saved[0].status).toBe('unhealthy');
  });

  it('rejects invalid registration with 400 and never probes or saves', async () => {
    const deps = registerDeps(true);
    const r = await handleRegister(deps, { ...validBody, termsAccepted: false });
    expect(r.status).toBe(400);
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });
});

describe('handleList', () => {
  it('returns the healthy catalog with public fields only (no internal status leak)', async () => {
    const sellers: SellerRow[] = [{
      sellerId: 's1', endpoint: 'https://a.example.com', protocol: 'a2a', capability: 'summary',
      wallet: `0x${'cd'.repeat(20)}`, payoutDomain: 6, agentId: '7', status: 'healthy', termsAccepted: true,
    }];
    const deps: ListDeps = { list: vi.fn().mockResolvedValue(sellers) };
    const r = await handleList(deps);
    expect(r.status).toBe(200);
    expect(r.body.sellers).toHaveLength(1);
    expect(r.body.sellers[0]).toMatchObject({ sellerId: 's1', protocol: 'a2a', capability: 'summary', payoutDomain: 6 });
  });
});
