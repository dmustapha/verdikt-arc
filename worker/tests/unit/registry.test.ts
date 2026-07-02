import { describe, it, expect, vi } from 'vitest';
import { validateRegistration, probeSeller } from '../../src/lib/registry.js';
import type { SellerRegistration } from '../../src/lib/registry.js';

// The registry gate (WS4): a seller must present valid terms-accepted registration AND pass a live
// health probe before it can ever be listed in the catalog. Validation + probe are pure/injectable so
// the accept/withhold decision is provable without a DB or a live seller.

const valid: SellerRegistration = {
  endpoint: 'https://seller.example.com', protocol: 'a2a', capability: 'research-summary',
  wallet: `0x${'ab'.repeat(20)}`, payoutDomain: 6, agentId: '42', termsAccepted: true,
};

describe('validateRegistration', () => {
  it('accepts a well-formed, terms-accepted registration', () => {
    const r = validateRegistration(valid);
    expect(r.ok).toBe(true);
  });

  it('rejects a registration that has not accepted deliver-then-settle terms', () => {
    const r = validateRegistration({ ...valid, termsAccepted: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/terms/i);
  });

  it('rejects a private/loopback or non-https endpoint (SSRF)', () => {
    expect(validateRegistration({ ...valid, endpoint: 'https://127.0.0.1/x' }).ok).toBe(false);
    expect(validateRegistration({ ...valid, endpoint: 'http://seller.example.com' }).ok).toBe(false);
  });

  it('rejects an unknown protocol, a bad wallet, or a missing capability', () => {
    expect(validateRegistration({ ...valid, protocol: 'ftp' as SellerRegistration['protocol'] }).ok).toBe(false);
    expect(validateRegistration({ ...valid, wallet: 'not-an-address' }).ok).toBe(false);
    expect(validateRegistration({ ...valid, capability: '  ' }).ok).toBe(false);
  });

  it('accepts registration without the optional agentId', () => {
    const { agentId, ...noAgent } = valid;
    void agentId;
    expect(validateRegistration(noAgent).ok).toBe(true);
  });
});

const jsonResp = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 500, status, json: async () => body, text: async () => JSON.stringify(body) } as Response);

describe('probeSeller', () => {
  it('a2a: healthy only when the agent card is valid (name + url + skills)', async () => {
    const good = vi.fn().mockResolvedValue(jsonResp({ name: 'X', url: 'https://seller.example.com/rpc', skills: [], capabilities: {} }));
    expect(await probeSeller(valid, { fetchFn: good, timeoutMs: 500 })).toBe(true);
    expect(good.mock.calls[0][0]).toMatch(/\/\.well-known\/agent-card\.json$/);

    const bad = vi.fn().mockResolvedValue(jsonResp({ nope: true }));
    expect(await probeSeller(valid, { fetchFn: bad, timeoutMs: 500 })).toBe(false);
  });

  it('webhook: healthy when the endpoint answers (any non-5xx), unhealthy on a network error', async () => {
    const up = vi.fn().mockResolvedValue(jsonResp({}, 405)); // POST-only endpoint answers 405 to a probe GET
    expect(await probeSeller({ ...valid, protocol: 'webhook' }, { fetchFn: up, timeoutMs: 500 })).toBe(true);

    const down = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await probeSeller({ ...valid, protocol: 'webhook' }, { fetchFn: down, timeoutMs: 500 })).toBe(false);
  });

  it('x402: healthy when the endpoint challenges with 402', async () => {
    const paid = vi.fn().mockResolvedValue(jsonResp({}, 402));
    expect(await probeSeller({ ...valid, protocol: 'x402' }, { fetchFn: paid, timeoutMs: 500 })).toBe(true);

    const notPaid = vi.fn().mockResolvedValue(jsonResp({}, 500));
    expect(await probeSeller({ ...valid, protocol: 'x402' }, { fetchFn: notPaid, timeoutMs: 500 })).toBe(false);
  });

  it('refuses to probe a private host even if asked (SSRF)', async () => {
    const fetchFn = vi.fn();
    expect(await probeSeller({ ...valid, endpoint: 'https://169.254.169.254' }, { fetchFn, timeoutMs: 500 })).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
