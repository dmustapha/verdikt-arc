import { describe, it, expect, vi } from 'vitest';
import { httpTransport } from '../../src/lib/transport.js';
import type { JobRow } from '../../src/lib/job-store.js';

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    jobId: 'j1', workId: `0x${'ab'.repeat(32)}`, state: 'DISPATCHED',
    sellerUrl: 'https://seller.example.com/dispatch', sellerProtocol: 'webhook', callbackToken: 'tok',
    resultRef: 'https://seller.example.com/tasks/j1', deadline: new Date(Date.now() + 3600_000),
    dispatchAttempts: 0, artifact: null, outcome: null, settleTxHash: null, lastError: null, ...over,
  };
}

const okResp = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

describe('httpTransport.dispatch', () => {
  it('POSTs a signed envelope with the correct webhook callback URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResp({ accepted: true }));
    const t = httpTransport({ workerPublicUrl: 'https://worker.example', fetchFn });
    await t.dispatch(job());
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://seller.example.com/dispatch');
    expect(init.method).toBe('POST');
    const env = JSON.parse(init.body);
    expect(env.callbackUrl).toBe('https://worker.example/webhook/callback/j1');
    expect(env.callbackToken).toBe('tok');
    expect(env.workId).toBe(job().workId);
  });

  it('uses the a2a callback path for an a2a seller', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResp({}));
    const t = httpTransport({ workerPublicUrl: 'https://worker.example', fetchFn });
    await t.dispatch(job({ sellerProtocol: 'a2a' }));
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).callbackUrl).toBe('https://worker.example/a2a/callback/j1');
  });

  it('throws when the seller rejects the dispatch (non-2xx)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResp({}, 503));
    const t = httpTransport({ workerPublicUrl: '', fetchFn });
    await expect(t.dispatch(job())).rejects.toThrow(/503/);
  });

  it('refuses to dispatch to a private/loopback seller (SSRF)', async () => {
    const fetchFn = vi.fn();
    const t = httpTransport({ workerPublicUrl: '', fetchFn });
    await expect(t.dispatch(job({ sellerUrl: 'https://169.254.169.254/x' }))).rejects.toThrow(/private|loopback/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('httpTransport.fetchResult', () => {
  it('GETs and parses a wrapped artifact', async () => {
    const artifact = { type: 'answer', payload: 'the answer' };
    const fetchFn = vi.fn().mockResolvedValue(okResp({ artifact }));
    const t = httpTransport({ workerPublicUrl: '', fetchFn });
    expect(await t.fetchResult(job())).toEqual(artifact);
    expect(fetchFn.mock.calls[0][0]).toBe('https://seller.example.com/tasks/j1');
    expect(fetchFn.mock.calls[0][1].method).toBe('GET');
  });

  it('parses a bare artifact (not wrapped)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResp({ type: 'code', payload: 'print(1)', language: 'python' }));
    const t = httpTransport({ workerPublicUrl: '', fetchFn });
    expect(await t.fetchResult(job())).toEqual({ type: 'code', payload: 'print(1)', language: 'python' });
  });

  it('returns null when the result is not ready yet (404/204)', async () => {
    const t404 = httpTransport({ workerPublicUrl: '', fetchFn: vi.fn().mockResolvedValue(okResp(null, 404)) });
    expect(await t404.fetchResult(job())).toBeNull();
  });

  it('returns null for a malformed artifact body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResp({ type: 'nonsense', payload: '' }));
    const t = httpTransport({ workerPublicUrl: '', fetchFn });
    expect(await t.fetchResult(job())).toBeNull();
  });

  it('SSRF-guards the result URL to the registered seller origin', async () => {
    const fetchFn = vi.fn();
    const t = httpTransport({ workerPublicUrl: '', fetchFn });
    await expect(t.fetchResult(job(), 'https://evil.example.com/x')).rejects.toThrow(/allow/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
