// v1 keystone: the signed Task Offer is how an INDEPENDENT payer hands a job to an INDEPENDENT
// seller with trust-minimized coordination. These tests pin the criteriaHash determinism and the
// offer signature/expiry verification — the seller relies on both before doing any work.
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { criteriaHash, offerMessage, verifyOffer, type TaskOffer } from '../../src/lib/task-offer.js';
import type { Acceptance } from '../../src/types.js';

const payer = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const NOW = 1_900_000_000;

const acceptance: Acceptance = {
  spec: 'price feed',
  schema: { symbol: { type: 'string', required: true }, price: { type: 'number', required: true, min: 0 } },
  minResponseBytes: 10,
};

function offer(over: Partial<TaskOffer> = {}): TaskOffer {
  return {
    workId: `0x${'11'.repeat(32)}`,
    type: 'tool_output',
    criteriaHash: criteriaHash(acceptance),
    amountUsdc: 1,
    escrow: '0xf6490e2A74bE9c8F5ED50aD184Af0d360E659A23',
    payer: payer.address as `0x${string}`,
    seller: '0x665F4AF29aeeeA93cea97813f69a3ED3eAdEF8fF',
    chainId: 5042002,
    feeUsdc: 0.001,
    expiresAt: NOW + 3600,
    ...over,
  };
}

describe('criteriaHash', () => {
  it('is deterministic regardless of key order', () => {
    const a: Acceptance = { spec: 'x', minResponseBytes: 10, schema: { b: { type: 'number', required: true }, a: { type: 'string', required: true } } };
    const b: Acceptance = { schema: { a: { required: true, type: 'string' }, b: { required: true, type: 'number' } }, minResponseBytes: 10, spec: 'x' };
    expect(criteriaHash(a)).toBe(criteriaHash(b));
  });
  it('changes when criteria change (commitment is binding)', () => {
    expect(criteriaHash(acceptance)).not.toBe(criteriaHash({ ...acceptance, minResponseBytes: 11 }));
  });
});

describe('verifyOffer', () => {
  it('accepts a payer-signed, unexpired offer', async () => {
    const o = offer();
    const sig = await payer.signMessage({ message: offerMessage(o) });
    expect(await verifyOffer(o, sig, NOW)).toEqual({ ok: true });
  });

  it('rejects an expired offer', async () => {
    const o = offer({ expiresAt: NOW - 1 });
    const sig = await payer.signMessage({ message: offerMessage(o) });
    expect((await verifyOffer(o, sig, NOW)).reason).toMatch(/expired/);
  });

  it('rejects a signature from a non-payer', async () => {
    const o = offer();
    const sig = await stranger.signMessage({ message: offerMessage(o) });
    expect((await verifyOffer(o, sig, NOW)).reason).toMatch(/does not match payer/);
  });

  it('rejects a tampered offer (amount changed after signing)', async () => {
    const o = offer();
    const sig = await payer.signMessage({ message: offerMessage(o) });
    const tampered = { ...o, amountUsdc: 9999 };
    expect((await verifyOffer(tampered, sig, NOW)).reason).toMatch(/does not match payer/);
  });

  it('rejects a malformed signature', async () => {
    expect((await verifyOffer(offer(), '0xdead' as `0x${string}`, NOW)).reason).toMatch(/malformed/);
  });
});
