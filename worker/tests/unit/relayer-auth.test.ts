import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { parseUnits } from 'viem';
import { verifyRelayerAuth, deriveNonce, type RawRoutes } from '../../src/routes/relayer.js';
import { USDC_DOMAIN, RECEIVE_TYPES } from '../../src/settlement/fund-escrow.js';

// WS7 relayer security core. The relayer submits a human's EIP-3009 authorization gaslessly and must
// NEVER be able to alter what the human signed. verifyRelayerAuth reconstructs the nonce (which folds
// in the payout routes) and requires the signature to recover to `payer` — so tampering with routes,
// amount, worker, or the payer itself breaks recovery. These tests use a REAL local-key signature, so
// the crypto is genuine (the same guarantee is re-proven live on-chain in Gate E1).

const ESCROW = `0x${'e5'.repeat(20)}` as `0x${string}`;
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const worker = `0x${'b0b'.padStart(40, '0')}` as `0x${string}`;
const workId = `0x${'ab'.repeat(32)}` as `0x${string}`;

const LOCAL_ROUTES: RawRoutes = {
  workerDomain: 0, workerRecipient: `0x${'00'.repeat(32)}`,
  payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}`,
};

const amount = parseUnits('1.5', 6);
const fee = parseUnits('0.1', 6);
const ttl = 604800n;
const validAfter = 0n;
const validBefore = 9_999_999_999n; // far future
const MAX = parseUnits('5', 6);
const NOW = 1_000_000n;

// Sign exactly as the browser will: message.nonce = deriveNonce(routes-in-nonce).
async function sign(routes: RawRoutes, over = { amount, fee, ttl, worker, payer: account.address as `0x${string}` }) {
  const nonce = deriveNonce({ workId, worker: over.worker, amount: over.amount, fee: over.fee, ttl: over.ttl, payer: over.payer, routes });
  return account.signTypedData({
    domain: USDC_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization',
    message: { from: over.payer, to: ESCROW, value: over.amount, validAfter, validBefore, nonce },
  });
}

function body(sig: `0x${string}`, routes: RawRoutes, over: Partial<Record<string, unknown>> = {}) {
  return {
    payer: account.address, workId, worker, routes, signature: sig,
    amount: amount.toString(), fee: fee.toString(), ttl: ttl.toString(),
    validAfter: validAfter.toString(), validBefore: validBefore.toString(), ...over,
  };
}
const opts = { escrow: ESCROW, maxAmount: MAX, nowSec: NOW };

describe('verifyRelayerAuth', () => {
  it('accepts a correctly-signed authorization (recovers to payer)', async () => {
    const sig = await sign(LOCAL_ROUTES);
    const r = await verifyRelayerAuth(body(sig, LOCAL_ROUTES), opts);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.amount).toBe(amount); expect(r.value.payer).toBe(account.address); }
  });

  it('rejects tampered ROUTES — a relayer cannot redirect the payout', async () => {
    const sig = await sign(LOCAL_ROUTES); // signed over local routes
    const evil: RawRoutes = { workerDomain: 6, workerRecipient: `0x${'de'.repeat(32)}`, payerDomain: 0, payerRecipient: `0x${'00'.repeat(32)}` };
    const r = await verifyRelayerAuth(body(sig, evil), opts); // submitted with attacker routes
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not match payer|does not recover/);
  });

  it('rejects a tampered AMOUNT', async () => {
    const sig = await sign(LOCAL_ROUTES);
    const r = await verifyRelayerAuth(body(sig, LOCAL_ROUTES, { amount: parseUnits('4', 6).toString() }), opts);
    expect(r.ok).toBe(false);
  });

  it('rejects a forged PAYER (someone else’s address with a real signer)', async () => {
    const sig = await sign(LOCAL_ROUTES);
    const other = `0x${'99'.repeat(20)}`;
    const r = await verifyRelayerAuth(body(sig, LOCAL_ROUTES, { payer: other }), opts);
    expect(r.ok).toBe(false);
  });

  it('rejects an expired authorization', async () => {
    const sig = await sign(LOCAL_ROUTES);
    const r = await verifyRelayerAuth(body(sig, LOCAL_ROUTES), { ...opts, nowSec: validBefore + 1n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expired/);
  });

  it('rejects an amount over the relayer cap', async () => {
    const big = parseUnits('9', 6);
    const sig = await sign(LOCAL_ROUTES, { amount: big, fee, ttl, worker, payer: account.address });
    const r = await verifyRelayerAuth(body(sig, LOCAL_ROUTES, { amount: big.toString() }), opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cap/);
  });

  it('rejects fee >= amount and malformed shapes', async () => {
    const sig = await sign(LOCAL_ROUTES);
    expect((await verifyRelayerAuth(body(sig, LOCAL_ROUTES, { fee: amount.toString() }), opts)).ok).toBe(false);
    expect((await verifyRelayerAuth(body(sig, LOCAL_ROUTES, { workId: '0xdead' }), opts)).ok).toBe(false);
    expect((await verifyRelayerAuth(body(sig, LOCAL_ROUTES, { payer: 'not-an-address' }), opts)).ok).toBe(false);
  });
});
