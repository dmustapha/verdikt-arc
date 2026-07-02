import { describe, it, expect, vi } from 'vitest';
import { makeGuardedFetch } from '../../src/lib/adapter/guarded-fetch.js';

// The shared outbound-fetch guard for the A2A + x402 drivers: every request to a seller-controlled
// URL (card, JSON-RPC, 402 endpoint, job URL) is SSRF-checked and time-bounded before it leaves. Both
// drivers hand the SDK/wrapper THIS fetch, so a malicious card.url / job URL / redirect can't reach an
// internal host. It must accept the same shapes fetch does: string, URL, and Request (x402's wrapper
// passes Request objects).

const ok = () => ({ ok: true, status: 200, json: async () => ({}) } as Response);

describe('makeGuardedFetch', () => {
  it('passes a safe https URL through to the underlying fetch', async () => {
    const inner = vi.fn().mockResolvedValue(ok());
    const gf = makeGuardedFetch({ fetchFn: inner, timeoutMs: 1000, allowedOrigins: ['https://seller.example.com'] });
    await gf('https://seller.example.com/tasks/1');
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('blocks a private/loopback host before any fetch', async () => {
    const inner = vi.fn();
    const gf = makeGuardedFetch({ fetchFn: inner, timeoutMs: 1000 });
    await expect(gf('https://169.254.169.254/latest')).rejects.toThrow(/private|loopback/i);
    expect(inner).not.toHaveBeenCalled();
  });

  it('blocks an origin outside the allowlist (malicious card.url / redirect target)', async () => {
    const inner = vi.fn();
    const gf = makeGuardedFetch({ fetchFn: inner, timeoutMs: 1000, allowedOrigins: ['https://seller.example.com'] });
    await expect(gf('https://evil.example.com/x')).rejects.toThrow(/allow/i);
    expect(inner).not.toHaveBeenCalled();
  });

  it('extracts the URL from a Request object (x402 wrapper passes Requests)', async () => {
    const inner = vi.fn().mockResolvedValue(ok());
    const gf = makeGuardedFetch({ fetchFn: inner, timeoutMs: 1000, allowedOrigins: ['https://seller.example.com'] });
    await gf(new Request('https://seller.example.com/pay', { method: 'POST' }));
    expect(inner).toHaveBeenCalledTimes(1);
    // A Request pointed at a blocked host is rejected too.
    await expect(gf(new Request('https://10.0.0.1/x'))).rejects.toThrow(/private|allow/i);
  });

  it('aborts the request when it exceeds the timeout', async () => {
    const inner = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    const gf = makeGuardedFetch({ fetchFn: inner as unknown as typeof fetch, timeoutMs: 10, allowPrivate: true });
    await expect(gf('https://seller.example.com/slow')).rejects.toThrow(/abort/i);
  });

  it('allowPrivate lets a loopback mock through (local wire proof only)', async () => {
    const inner = vi.fn().mockResolvedValue(ok());
    const gf = makeGuardedFetch({ fetchFn: inner, timeoutMs: 1000, allowPrivate: true });
    await gf('http://127.0.0.1:5555/card');
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
