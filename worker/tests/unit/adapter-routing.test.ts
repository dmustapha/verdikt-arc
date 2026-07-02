import { describe, it, expect, vi } from 'vitest';
import { sellerAdapter } from '../../src/lib/adapter/index.js';
import type { SellerTransport } from '../../src/lib/transport.js';
import type { JobRow, SellerProtocol } from '../../src/lib/job-store.js';

// The generic seller adapter is a routing SellerTransport: it delegates dispatch/fetchResult to the
// driver named by job.sellerProtocol, so the engine/keeper/callback keep talking to ONE transport
// while three protocols live underneath. The three real drivers (webhook=httpTransport, a2a, x402)
// are injected — routing is proven here independently of any live SDK.

function job(protocol: SellerProtocol): JobRow {
  return {
    jobId: `j-${protocol}`, workId: `0x${'ab'.repeat(32)}`, state: 'DISPATCHED',
    sellerUrl: 'https://seller.example.com', sellerProtocol: protocol, callbackToken: 'tok',
    resultRef: null, deadline: new Date(Date.now() + 3600_000),
    dispatchAttempts: 0, artifact: null, outcome: null, settleTxHash: null, lastError: null,
  };
}

function spyDriver(): SellerTransport & { dispatch: ReturnType<typeof vi.fn>; fetchResult: ReturnType<typeof vi.fn> } {
  return { dispatch: vi.fn().mockResolvedValue(undefined), fetchResult: vi.fn().mockResolvedValue(null) };
}

describe('sellerAdapter routing', () => {
  it('routes dispatch to the driver named by job.sellerProtocol', async () => {
    const webhook = spyDriver(), a2a = spyDriver(), x402 = spyDriver();
    const adapter = sellerAdapter({ webhook, a2a, x402 });
    // Stable instances — job() mints a fresh Date each call, so reuse the SAME object we assert on.
    const wJob = job('webhook'), aJob = job('a2a'), xJob = job('x402');

    await adapter.dispatch(wJob);
    await adapter.dispatch(aJob);
    await adapter.dispatch(xJob);

    expect(webhook.dispatch).toHaveBeenCalledTimes(1);
    expect(a2a.dispatch).toHaveBeenCalledTimes(1);
    expect(x402.dispatch).toHaveBeenCalledTimes(1);
    expect(webhook.dispatch).toHaveBeenCalledWith(wJob);
  });

  it('routes fetchResult (with resultRef) to the same driver', async () => {
    const webhook = spyDriver(), a2a = spyDriver(), x402 = spyDriver();
    const adapter = sellerAdapter({ webhook, a2a, x402 });
    const aJob = job('a2a');

    await adapter.fetchResult(aJob, 'task-123');

    expect(a2a.fetchResult).toHaveBeenCalledWith(aJob, 'task-123');
    expect(webhook.fetchResult).not.toHaveBeenCalled();
    expect(x402.fetchResult).not.toHaveBeenCalled();
  });

  it('throws on an unknown protocol rather than silently dropping a job', async () => {
    const adapter = sellerAdapter({ webhook: spyDriver(), a2a: spyDriver(), x402: spyDriver() });
    await expect(adapter.dispatch(job('carrier-pigeon' as SellerProtocol))).rejects.toThrow(/protocol/i);
  });
});
