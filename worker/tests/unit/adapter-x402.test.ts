import { describe, it, expect, vi } from 'vitest';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Driver } from '../../src/lib/adapter/x402.js';
import type { JobRow } from '../../src/lib/job-store.js';

// x402 driver against a MOCK x402 seller (real @x402/fetch + @x402/evm doing the actual EIP-3009
// signing with a real viem key; the mock only stands in for the seller's HTTP + on-chain settle).
// Proves the reconciliation invariant HELD BY CONSTRUCTION: the driver pays ONLY a sub-cent access
// toll (capped in the requirements selector) and NEVER the bounty — a 402 asking above the cap makes
// the driver refuse before signing anything. Async shape: 402 → pay toll → 202 + job URL → poll.

const NETWORK = 'eip155:5042002' as const;         // Arc
const USDC = `0x${'11'.repeat(20)}` as `0x${string}`;
const PAY_TO = `0x${'22'.repeat(20)}` as `0x${string}`;
const TOLL_CAP = 10_000n;                            // $0.01 (6-dec USDC) hard ceiling
const SELLER = 'https://seller.example.com/x402';
const JOB_URL = 'https://seller.example.com/x402/jobs/abc';
// A funded (test) toll payer. Never touches a real chain here — signTypedData is offline.
const account = privateKeyToAccount(`0x${'a1'.repeat(32)}`);

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    jobId: 'j-x402', workId: `0x${'ab'.repeat(32)}`, state: 'DISPATCHED',
    sellerUrl: SELLER, sellerProtocol: 'x402', callbackToken: 'tok', resultRef: null,
    deadline: new Date(Date.now() + 3600_000), dispatchAttempts: 0, artifact: null,
    outcome: null, settleTxHash: null, lastError: null, ...over,
  };
}

const paymentRequired = (amount: string) => ({
  x402Version: 2,
  resource: { url: SELLER, description: 'verdikt seller toll', mimeType: 'application/json' },
  accepts: [{ scheme: 'exact', network: NETWORK, asset: USDC, amount, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' } }],
});

// A mock x402 seller: unpaid POST → 402 (PAYMENT-REQUIRED header); paid POST (PAYMENT-SIGNATURE
// header present) → 202 { jobUrl }; GET job URL → 200 { artifact }. Records the toll it actually
// collected (decoded from the payment header) so the test can assert amount ≤ cap.
function mockSeller(tollAmount: string) {
  const state = { paidValue: null as string | null, paidCount: 0 };
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(typeof input === 'string' ? input : input.href, init);
    const url = req.url;
    if (req.method === 'GET' && url === JOB_URL) {
      return new Response(JSON.stringify({ artifact: { type: 'answer', payload: 'x402 seller result' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const paySig = req.headers.get('PAYMENT-SIGNATURE');
    if (!paySig) {
      return new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired(tollAmount)) } });
    }
    state.paidCount++;
    const payload = JSON.parse(Buffer.from(paySig, 'base64').toString('utf8')) as { payload: { authorization: { value: string } } };
    state.paidValue = payload.payload.authorization.value;
    return new Response(JSON.stringify({ jobUrl: JOB_URL }), { status: 202, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchFn, state };
}

const driverOpts = (fetchFn: typeof fetch, onResultRef?: (j: string, r: string) => Promise<void>) =>
  ({ network: NETWORK, tollCapAtomic: TOLL_CAP, account, fetchFn, onResultRef, workerPublicUrl: 'https://worker.example' });

describe('x402Driver.dispatch — toll-only, reconciliation invariant', () => {
  it('pays a sub-cent toll, gets a 202 + job URL, persists it (amount ≤ cap)', async () => {
    const { fetchFn, state } = mockSeller('1000'); // $0.001 toll, within cap
    const onResultRef = vi.fn().mockResolvedValue(undefined);
    await x402Driver(driverOpts(fetchFn, onResultRef)).dispatch(job());
    expect(state.paidCount).toBe(1);
    expect(BigInt(state.paidValue!)).toBeLessThanOrEqual(TOLL_CAP); // NEVER above the toll cap
    expect(state.paidValue).toBe('1000');
    expect(onResultRef).toHaveBeenCalledWith('j-x402', JOB_URL);
  });

  it('REFUSES to pay when the 402 asks for more than the toll cap (the bounty) — nothing signed', async () => {
    const { fetchFn, state } = mockSeller('1000000'); // $1.00 — a bounty-sized ask
    await expect(x402Driver(driverOpts(fetchFn)).dispatch(job())).rejects.toThrow(/cap|toll/i);
    expect(state.paidCount).toBe(0); // no payment header ever sent
  });
});

describe('x402Driver.fetchResult', () => {
  it('GETs the job URL and normalizes the artifact', async () => {
    const { fetchFn } = mockSeller('1000');
    const art = await x402Driver(driverOpts(fetchFn)).fetchResult(job(), JOB_URL);
    expect(art).toEqual({ type: 'answer', payload: 'x402 seller result' });
  });

  it('returns null when there is no job URL to poll', async () => {
    const { fetchFn } = mockSeller('1000');
    expect(await x402Driver(driverOpts(fetchFn)).fetchResult(job())).toBeNull();
  });
});
