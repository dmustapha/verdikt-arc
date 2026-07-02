import { describe, it, expect, vi } from 'vitest';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { privateKeyToAccount } from 'viem/accounts';
import { httpTransport } from '../../src/lib/transport.js';
import { a2aDriver } from '../../src/lib/adapter/a2a.js';
import { x402Driver } from '../../src/lib/adapter/x402.js';
import { handleRegister, handleList } from '../../src/routes/sellers.js';
import type { RegisterDeps } from '../../src/routes/sellers.js';
import type { SellerRow } from '../../src/lib/seller-store.js';
import type { JobRow, SellerProtocol } from '../../src/lib/job-store.js';
import type { Artifact } from '../../src/types.js';

// ── Gate C2 — generic seller adapter (3 drivers) + registry ───────────────────────────────────────
// The consolidated gate. Each criterion below maps to a MASTER-PLAN Gate C2 checkbox. The per-driver
// wire mechanics are proven exhaustively in adapter-{a2a,x402}.test.ts + transport.test.ts + registry
// .test.ts; here we prove the GATE PROPERTIES that only mean something across the whole adapter:
// one normalized shape, the reconciliation invariant, malicious-seller safety, bounded timeouts, and
// the register→probe→list gate.

const SELLER = 'https://seller.example.com';
const NETWORK = 'eip155:5042002' as const;
const TOLL_CAP = 10_000n;
const account = privateKeyToAccount(`0x${'a1'.repeat(32)}`);

// The one canonical deliverable every driver must reduce to — byte-identical Artifact out of every wire.
const UNIFIED: Artifact = { type: 'answer', payload: 'the one canonical deliverable' };

function job(protocol: SellerProtocol, over: Partial<JobRow> = {}): JobRow {
  return {
    jobId: `j-${protocol}`, workId: `0x${'ab'.repeat(32)}`, state: 'AWAITING_DELIVERY',
    sellerUrl: SELLER, sellerProtocol: protocol, callbackToken: 'tok', resultRef: null,
    deadline: new Date(Date.now() + 3600_000), dispatchAttempts: 0, artifact: null,
    outcome: null, settleTxHash: null, lastError: null, ...over,
  };
}

const resp = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('Gate C2 — every driver normalizes to the SAME {status,artifact}', () => {
  it('webhook, a2a, and x402 all reduce their native wire delivery to one identical Artifact', async () => {
    // webhook: GET re-fetch returns a wrapped artifact
    const webhookFetch = vi.fn(async () => resp({ artifact: UNIFIED })) as unknown as typeof fetch;
    const webhookArt = await httpTransport({ workerPublicUrl: '', fetchFn: webhookFetch })
      .fetchResult(job('webhook', { resultRef: `${SELLER}/tasks/x` }));

    // a2a: tasks/get returns a completed task carrying the artifact as a DataPart
    const a2aFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/.well-known/agent-card.json')) return resp({ name: 'S', description: 'd', version: '1', protocolVersion: '0.3.0', url: `${SELLER}/rpc`, capabilities: {}, defaultInputModes: [], defaultOutputModes: [], skills: [] });
      const req = JSON.parse(String(init?.body ?? '{}'));
      return resp({ jsonrpc: '2.0', id: req.id, result: { kind: 'task', id: 't1', contextId: 'c', status: { state: 'completed' }, artifacts: [{ artifactId: 'a', parts: [{ kind: 'data', data: UNIFIED }] }] } });
    }) as unknown as typeof fetch;
    const a2aArt = await a2aDriver({ fetchFn: a2aFetch }).fetchResult(job('a2a'), 't1');

    // x402: GET the job URL returns a wrapped artifact (polling is free — no payment)
    const x402Fetch = vi.fn(async () => resp({ artifact: UNIFIED })) as unknown as typeof fetch;
    const x402Art = await x402Driver({ network: NETWORK, tollCapAtomic: TOLL_CAP, account, fetchFn: x402Fetch })
      .fetchResult(job('x402'), `${SELLER}/jobs/1`);

    expect(webhookArt).toEqual(UNIFIED);
    expect(a2aArt).toEqual(UNIFIED);
    expect(x402Art).toEqual(UNIFIED);
    // The gate invariant: not merely each-correct, but MUTUALLY identical.
    expect(a2aArt).toEqual(webhookArt);
    expect(x402Art).toEqual(webhookArt);
  });
});

describe('Gate C2 — reconciliation invariant (x402 pays only the toll, never the bounty)', () => {
  const mockSeller = (tollAmount: string) => {
    const state = { paidValue: null as string | null };
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(typeof input === 'string' ? input : input.href, init);
      const paySig = req.headers.get('PAYMENT-SIGNATURE');
      if (!paySig) return resp(null, 402, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader({ x402Version: 2, resource: { url: SELLER }, accepts: [{ scheme: 'exact', network: NETWORK, asset: `0x${'11'.repeat(20)}`, amount: tollAmount, payTo: `0x${'22'.repeat(20)}`, maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' } }] }) });
      state.paidValue = (JSON.parse(Buffer.from(paySig, 'base64').toString('utf8')) as { payload: { authorization: { value: string } } }).payload.authorization.value;
      return resp({ jobUrl: `${SELLER}/jobs/1` }, 202);
    }) as unknown as typeof fetch;
    return { fetchFn, state };
  };

  it('pays a sub-cent toll (≤ cap) and captures the job URL', async () => {
    const { fetchFn, state } = mockSeller('900');
    await x402Driver({ network: NETWORK, tollCapAtomic: TOLL_CAP, account, fetchFn, onResultRef: async () => {} }).dispatch(job('x402'));
    expect(BigInt(state.paidValue!)).toBeLessThanOrEqual(TOLL_CAP);
  });

  it('REFUSES a bounty-sized ask — nothing is signed', async () => {
    const { fetchFn, state } = mockSeller('5000000'); // $5.00 bounty
    await expect(x402Driver({ network: NETWORK, tollCapAtomic: TOLL_CAP, account, fetchFn }).dispatch(job('x402'))).rejects.toThrow(/cap|toll/i);
    expect(state.paidValue).toBeNull();
  });
});

describe('Gate C2 — a malicious seller cannot force a release, and timeouts are bounded', () => {
  it('SSRF: an a2a card whose service url points off-origin is blocked (never fetched)', async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/.well-known/agent-card.json')) return resp({ name: 'S', description: 'd', version: '1', protocolVersion: '0.3.0', url: 'https://evil.example.com/rpc', capabilities: {}, defaultInputModes: [], defaultOutputModes: [], skills: [] });
      return resp({ jsonrpc: '2.0', id: 1, result: { kind: 'task', id: 't', status: { state: 'submitted' } } });
    }) as unknown as typeof fetch;
    await expect(a2aDriver({ fetchFn }).dispatch(job('a2a'))).rejects.toThrow(/allow/i);
  });

  it('a garbage delivery normalizes to null — never a forged artifact the engine could mistake for good', async () => {
    // The adapter has NO settle power; the worst a hostile seller can do is deliver junk, which the
    // normalizer rejects to null. Release remains the verdict engine's decision (WS2), not the wire's.
    const junkFetch = vi.fn(async () => resp({ artifact: { type: 'totally-made-up', payload: '' } })) as unknown as typeof fetch;
    const art = await httpTransport({ workerPublicUrl: '', fetchFn: junkFetch }).fetchResult(job('webhook', { resultRef: `${SELLER}/tasks/x` }));
    expect(art).toBeNull();
  });

  it('a hung seller is aborted within the bound (returns null, does not hang the poll)', async () => {
    const hangFetch = vi.fn((_i: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    })) as unknown as typeof fetch;
    const start = Date.now();
    const art = await a2aDriver({ fetchFn: hangFetch, timeoutMs: 40 }).fetchResult(job('a2a'), 't1');
    expect(art).toBeNull();                          // caught the abort → not ready, not a hang
    expect(Date.now() - start).toBeLessThan(1500);   // bounded, nowhere near an unbounded wait
  });
});

describe('Gate C2 — registry gate: register → probe → list only the healthy', () => {
  function inMemoryRegistry() {
    const saved: SellerRow[] = [];
    let n = 0;
    const deps = (probeResult: boolean): RegisterDeps => ({
      probe: async () => probeResult,
      save: async (row) => { saved.push(row); },
      newId: () => `slr-${n++}`,
    });
    return { saved, deps };
  }

  it('a healthy seller is listed, a valid-but-unhealthy one is withheld, an invalid one is rejected', async () => {
    const reg = inMemoryRegistry();
    const good = { endpoint: `${SELLER}`, protocol: 'a2a', capability: 'summary', wallet: `0x${'ab'.repeat(20)}`, payoutDomain: 6, termsAccepted: true };

    const healthy = await handleRegister(reg.deps(true), good);
    expect(healthy.status).toBe(201);
    expect(healthy.body.listed).toBe(true);

    const withheld = await handleRegister(reg.deps(false), { ...good, endpoint: 'https://down.example.com' });
    expect(withheld.status).toBe(201);
    expect(withheld.body.listed).toBe(false);

    const invalid = await handleRegister(reg.deps(true), { ...good, termsAccepted: false });
    expect(invalid.status).toBe(400);

    // The catalog surfaces only the healthy row.
    const list = await handleList({ list: async () => reg.saved.filter((s) => s.status === 'healthy') });
    expect(list.body.sellers).toHaveLength(1);
    expect((list.body.sellers as Array<{ capability: string }>)[0].capability).toBe('summary');
  });
});
