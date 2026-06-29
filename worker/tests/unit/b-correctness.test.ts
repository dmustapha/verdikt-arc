import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Response } from 'express';
import { criteriaHash } from '../../src/lib/task-offer.js';
import { captureVerdictFee } from '../../src/lib/x402-meter.js';
import type { Acceptance } from '../../src/types.js';

// B1: the criteriaHash the route binds the verdict to. The route rejects (409) when the registered
// criteria don't hash to the offer's committed criteriaHash — so the hash must change with the criteria.
describe('B1 criteriaHash binding', () => {
  const base: Acceptance = { spec: 'sum', tests: 'def test(): assert add(2,3)==5' };

  it('a registered acceptance hashes stably to its own criteriaHash (happy path matches the offer)', () => {
    expect(criteriaHash(base)).toBe(criteriaHash({ ...base }));
  });

  it('different registered criteria produce a different hash (the mismatch the route rejects)', () => {
    const swapped: Acceptance = { spec: 'sum', tests: 'def test(): assert add(2,3)==6' }; // payer bait-and-switch
    expect(criteriaHash(swapped)).not.toBe(criteriaHash(base));
  });
});

// B2: settle-fail-after-verify. If the verdict rendered (auth present) but the Gateway /settle capture
// fails, we serve free and bill nothing — never fabricate a charge. With no auth, fee is 0 too.
describe('B2 settle-fail-after-verify', () => {
  afterEach(() => vi.unstubAllGlobals());

  function resWith(payment: unknown): Response {
    return { locals: { payment } } as unknown as Response;
  }

  it('no authorization → no charge', async () => {
    const out = await captureVerdictFee(resWith(null));
    expect(out).toEqual({ feeUsdc: 0, txHash: null });
  });

  it('authorized but /settle returns success:false → serve free, not billed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: false, errorReason: 'insufficient gateway balance' }) })));
    const out = await captureVerdictFee(resWith({ payload: {}, requirements: {} }));
    expect(out).toEqual({ feeUsdc: 0, txHash: null });
  });

  it('authorized and /settle succeeds → fee captured with the tx hash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, transaction: '0xsettled' }) })));
    const out = await captureVerdictFee(resWith({ payload: {}, requirements: {} }));
    expect(out.feeUsdc).toBeGreaterThan(0);
    expect(out.txHash).toBe('0xsettled');
  });
});
