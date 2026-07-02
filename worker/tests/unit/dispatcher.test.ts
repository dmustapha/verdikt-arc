import { describe, it, expect, vi } from 'vitest';
import { dispatchWithRetry } from '../../src/lib/dispatcher.js';
import type { SellerTransport } from '../../src/lib/transport.js';
import type { JobRow } from '../../src/lib/job-store.js';

const job = { jobId: 'j1', sellerUrl: 'https://seller.example.com/x', sellerProtocol: 'webhook' } as JobRow;

function deps(over: Partial<Parameters<typeof dispatchWithRetry>[2]> = {}) {
  return {
    recordDispatchAttempt: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    maxAttempts: 3,
    baseDelayMs: 100,
    ...over,
  };
}

function transport(dispatch: SellerTransport['dispatch']): SellerTransport {
  return { dispatch, fetchResult: vi.fn().mockResolvedValue(null) };
}

describe('dispatchWithRetry', () => {
  it('returns true and records one attempt on first-try success', async () => {
    const d = deps();
    const t = transport(vi.fn().mockResolvedValue(undefined));
    expect(await dispatchWithRetry(job, t, d)).toBe(true);
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(d.recordDispatchAttempt).toHaveBeenCalledTimes(1);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('retries with backoff then succeeds', async () => {
    const d = deps();
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce(undefined);
    const t = transport(dispatch);
    expect(await dispatchWithRetry(job, t, d)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(d.sleep).toHaveBeenCalledTimes(2); // between the 3 attempts
    // exponential backoff: 100, 200
    expect(d.sleep).toHaveBeenNthCalledWith(1, 100);
    expect(d.sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it('returns false after exhausting attempts and records the last error', async () => {
    const d = deps();
    const dispatch = vi.fn().mockRejectedValue(new Error('unreachable'));
    const t = transport(dispatch);
    expect(await dispatchWithRetry(job, t, d)).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(d.recordDispatchAttempt).toHaveBeenLastCalledWith('j1', 'unreachable');
    expect(d.sleep).toHaveBeenCalledTimes(2); // no sleep after the final failure
  });
});
