import { describe, it, expect, vi } from 'vitest';
import { handleCallback } from '../../src/routes/callback.js';
import type { CallbackDeps, CallbackInput } from '../../src/routes/callback.js';
import type { JobRow } from '../../src/lib/job-store.js';
import type { Artifact } from '../../src/types.js';

const artifact: Artifact = { type: 'code', language: 'python', payload: 'print(1)' };

function mkJob(over: Partial<JobRow> = {}): JobRow {
  return {
    jobId: 'job-1',
    workId: `0x${'ab'.repeat(32)}`,
    state: 'AWAITING_DELIVERY',
    sellerUrl: 'https://seller.example.com/dispatch',
    sellerProtocol: 'webhook',
    callbackToken: 'secret-token',
    resultRef: null,
    deadline: new Date(Date.now() + 3600_000),
    dispatchAttempts: 1,
    artifact: null,
    outcome: null,
    settleTxHash: null,
    lastError: null,
    ...over,
  };
}

function mkDeps(job: JobRow | null, over: Partial<CallbackDeps> = {}): { deps: CallbackDeps; onDelivery: ReturnType<typeof vi.fn> } {
  const onDelivery = vi.fn().mockResolvedValue(undefined);
  const deps: CallbackDeps = {
    getJob: vi.fn().mockResolvedValue(job),
    recordSeenJti: vi.fn().mockResolvedValue(true),
    onDelivery,
    ...over,
  };
  return { deps, onDelivery };
}

const base: CallbackInput = { protocol: 'webhook', jobId: 'job-1', token: 'secret-token', jti: 'jti-1', artifact };

describe('handleCallback — auth', () => {
  it('404 for an unknown job', async () => {
    const { deps } = mkDeps(null);
    const r = await handleCallback(deps, base);
    expect(r.status).toBe(404);
  });
  it('401 when the token is missing', async () => {
    const { deps, onDelivery } = mkDeps(mkJob());
    const r = await handleCallback(deps, { ...base, token: undefined });
    expect(r.status).toBe(401);
    expect(onDelivery).not.toHaveBeenCalled();
  });
  it('401 when the token is wrong (forged callback)', async () => {
    const { deps, onDelivery } = mkDeps(mkJob());
    const r = await handleCallback(deps, { ...base, token: 'wrong' });
    expect(r.status).toBe(401);
    expect(onDelivery).not.toHaveBeenCalled();
  });
});

describe('handleCallback — dedupe + terminal guard', () => {
  it('409 when the job is already terminal', async () => {
    const { deps, onDelivery } = mkDeps(mkJob({ state: 'SETTLED' }));
    const r = await handleCallback(deps, base);
    expect(r.status).toBe(409);
    expect(onDelivery).not.toHaveBeenCalled();
  });
  it('400 when jti is missing', async () => {
    const { deps } = mkDeps(mkJob());
    const r = await handleCallback(deps, { ...base, jti: undefined });
    expect(r.status).toBe(400);
  });
  it('409 when jti is a replay', async () => {
    const { deps, onDelivery } = mkDeps(mkJob(), { recordSeenJti: vi.fn().mockResolvedValue(false) });
    const r = await handleCallback(deps, base);
    expect(r.status).toBe(409);
    expect(onDelivery).not.toHaveBeenCalled();
  });
});

describe('handleCallback — webhook (inline artifact)', () => {
  it('202 and delivers the inline artifact', async () => {
    const { deps, onDelivery } = mkDeps(mkJob());
    const r = await handleCallback(deps, base);
    expect(r.status).toBe(202);
    expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }), { artifact });
  });
  it('400 when the inline artifact is malformed', async () => {
    const { deps, onDelivery } = mkDeps(mkJob());
    const r = await handleCallback(deps, { ...base, artifact: { type: 'nope', payload: '' } as unknown as Artifact });
    expect(r.status).toBe(400);
    expect(onDelivery).not.toHaveBeenCalled();
  });
});

describe('handleCallback — a2a (authoritative re-fetch, SSRF-guarded)', () => {
  const a2aJob = mkJob({ sellerProtocol: 'a2a' });
  it('202 and hands a same-origin resultRef to onDelivery (never trusts a pushed body)', async () => {
    const { deps, onDelivery } = mkDeps(a2aJob);
    const r = await handleCallback(deps, { protocol: 'a2a', jobId: 'job-1', token: 'secret-token', jti: 'jti-1', resultRef: 'https://seller.example.com/tasks/1' });
    expect(r.status).toBe(202);
    expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }), { resultRef: 'https://seller.example.com/tasks/1' });
  });
  it('falls back to the job\'s registered resultRef when the body omits it', async () => {
    const { deps, onDelivery } = mkDeps(mkJob({ sellerProtocol: 'a2a', resultRef: 'https://seller.example.com/tasks/registered' }));
    const r = await handleCallback(deps, { protocol: 'a2a', jobId: 'job-1', token: 'secret-token', jti: 'jti-1' });
    expect(r.status).toBe(202);
    expect(onDelivery).toHaveBeenCalledWith(expect.anything(), { resultRef: 'https://seller.example.com/tasks/registered' });
  });
  it('400 when the resultRef origin is not the registered seller (SSRF)', async () => {
    const { deps, onDelivery } = mkDeps(a2aJob);
    const r = await handleCallback(deps, { protocol: 'a2a', jobId: 'job-1', token: 'secret-token', jti: 'jti-1', resultRef: 'https://evil.example.com/x' });
    expect(r.status).toBe(400);
    expect(onDelivery).not.toHaveBeenCalled();
  });
  it('400 when the resultRef is a private/loopback host (SSRF)', async () => {
    const { deps, onDelivery } = mkDeps(a2aJob);
    const r = await handleCallback(deps, { protocol: 'a2a', jobId: 'job-1', token: 'secret-token', jti: 'jti-1', resultRef: 'https://169.254.169.254/latest' });
    expect(r.status).toBe(400);
    expect(onDelivery).not.toHaveBeenCalled();
  });
  it('400 when neither a body resultRef nor a registered resultRef exists', async () => {
    const { deps } = mkDeps(a2aJob);
    const r = await handleCallback(deps, { protocol: 'a2a', jobId: 'job-1', token: 'secret-token', jti: 'jti-1' });
    expect(r.status).toBe(400);
  });
});
