import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { criteriaHash, artifactMessage, offerMessage, verifyOffer } from '../src/crypto.js';
import type { Acceptance, TaskOffer } from '../src/types.js';

// These mirror worker/src/lib/task-offer.ts and routes/verdict.ts EXACTLY. If they drift, the
// worker's H-2 artifact-signature check and the criteriaHash commitment break across SDK<->worker.
// The expected values below are computed from the worker's own canonical() (cross-checked at build).

const acceptance: Acceptance = {
  spec: 'price feed',
  schema: { symbol: { type: 'string', required: true }, price: { type: 'number', required: true, min: 0 } },
  minResponseBytes: 10,
};

describe('criteriaHash', () => {
  it('is key-order independent', () => {
    const a: Acceptance = { spec: 'x', minResponseBytes: 10, schema: { b: { type: 'number', required: true }, a: { type: 'string', required: true } } };
    const b: Acceptance = { schema: { a: { required: true, type: 'string' }, b: { required: true, type: 'number' } }, minResponseBytes: 10, spec: 'x' };
    expect(criteriaHash(a)).toBe(criteriaHash(b));
  });
  it('is binding (changes with criteria)', () => {
    expect(criteriaHash(acceptance)).not.toBe(criteriaHash({ ...acceptance, minResponseBytes: 11 }));
  });
});

describe('artifactMessage', () => {
  it('matches the worker format Verdikt:<workId>:<keccak(payload)>', () => {
    const m = artifactMessage('0xabc', '{"x":1}');
    expect(m).toMatch(/^Verdikt:0xabc:0x[0-9a-f]{64}$/);
  });
});

describe('verifyOffer', () => {
  const payer = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
  const stranger = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
  const NOW = 1_900_000_000;
  const offer = (over: Partial<TaskOffer> = {}): TaskOffer => ({
    workId: `0x${'11'.repeat(32)}`, type: 'tool_output', criteriaHash: criteriaHash(acceptance),
    amountUsdc: 1, escrow: '0x06928fF83Dd7C1A2779bf8FB35ADfaaaDaf0F278',
    payer: payer.address as `0x${string}`, seller: '0x665F4AF29aeeeA93cea97813f69a3ED3eAdEF8fF',
    chainId: 5042002, feeUsdc: 0.001, expiresAt: NOW + 3600, ...over,
  });

  it('accepts a payer-signed, unexpired offer', async () => {
    const o = offer();
    const sig = await payer.signMessage({ message: offerMessage(o) });
    expect(await verifyOffer(o, sig, NOW)).toEqual({ ok: true });
  });
  it('rejects expired', async () => {
    const o = offer({ expiresAt: NOW - 1 });
    const sig = await payer.signMessage({ message: offerMessage(o) });
    expect((await verifyOffer(o, sig, NOW)).reason).toMatch(/expired/);
  });
  it('rejects non-payer signer', async () => {
    const o = offer();
    const sig = await stranger.signMessage({ message: offerMessage(o) });
    expect((await verifyOffer(o, sig, NOW)).reason).toMatch(/does not match payer/);
  });
  it('rejects tampered amount', async () => {
    const o = offer();
    const sig = await payer.signMessage({ message: offerMessage(o) });
    expect((await verifyOffer({ ...o, amountUsdc: 9999 }, sig, NOW)).reason).toMatch(/does not match payer/);
  });
});
