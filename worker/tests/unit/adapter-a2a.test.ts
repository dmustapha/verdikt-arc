import { describe, it, expect, vi } from 'vitest';
import { a2aDriver } from '../../src/lib/adapter/a2a.js';
import type { JobRow } from '../../src/lib/job-store.js';

// A2A driver against a MOCK A2A endpoint emulated at the fetch layer (the real @a2a-js/sdk A2AClient
// parses these responses — this is a true integration of the SDK, just without a socket). Proves:
// card parse → message/send (task id captured) → tasks/get poll → DataPart extract, all normalized to
// our Artifact; SSRF blocks a card whose service `url` points off the registered origin.

const BASE = 'https://seller.example.com';
const RPC = `${BASE}/a2a/rpc`;

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    jobId: 'j-a2a', workId: `0x${'ab'.repeat(32)}`, state: 'DISPATCHED',
    sellerUrl: BASE, sellerProtocol: 'a2a', callbackToken: 'tok', resultRef: null,
    deadline: new Date(Date.now() + 3600_000), dispatchAttempts: 0, artifact: null,
    outcome: null, settleTxHash: null, lastError: null, ...over,
  };
}

const jsonResp = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, statusText: 'x',
  json: async () => body, text: async () => JSON.stringify(body),
} as Response);

const card = (url = RPC) => ({
  name: 'Ref Seller', description: 'a2a reference seller', version: '1.0.0', protocolVersion: '0.3.0',
  url, preferredTransport: 'JSONRPC', capabilities: {}, defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'], skills: [{ id: 's1', name: 'do', description: 'd', tags: [] }],
});

const completedTask = (id: string) => ({
  kind: 'task', id, contextId: 'c1', status: { state: 'completed' },
  artifacts: [{ artifactId: 'a1', parts: [{ kind: 'data', data: { type: 'answer', payload: 'the a2a answer' } }] }],
});

// A configurable A2A server at the fetch layer. Echoes the request id (the SDK enforces id match).
function mockA2A(opts: { cardUrl?: string; task?: unknown; taskState?: string } = {}) {
  const sent: Array<{ method: string; params: unknown }> = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/.well-known/agent-card.json')) return jsonResp(card(opts.cardUrl));
    const req = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string; params: unknown };
    sent.push({ method: req.method, params: req.params });
    if (req.method === 'message/send') return jsonResp({ jsonrpc: '2.0', id: req.id, result: { kind: 'task', id: 'task-xyz', contextId: 'c1', status: { state: 'submitted' } } });
    if (req.method === 'tasks/get') return jsonResp({ jsonrpc: '2.0', id: req.id, result: opts.task ?? { kind: 'task', id: 'task-xyz', contextId: 'c1', status: { state: opts.taskState ?? 'working' } } });
    return jsonResp({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } }, 200);
  }) as unknown as typeof fetch;
  return { fetchFn, sent };
}

describe('a2aDriver.dispatch', () => {
  it('parses the card, sends message/send with the workId, and persists the returned task id', async () => {
    const { fetchFn, sent } = mockA2A();
    const onResultRef = vi.fn().mockResolvedValue(undefined);
    const d = a2aDriver({ fetchFn, onResultRef, workerPublicUrl: 'https://worker.example' });
    await d.dispatch(job());
    const send = sent.find((s) => s.method === 'message/send');
    expect(send).toBeDefined();
    const parts = (send!.params as { message: { parts: Array<{ kind: string; data?: Record<string, unknown> }> } }).message.parts;
    const dataPart = parts.find((p) => p.kind === 'data');
    expect(dataPart!.data!.workId).toBe(job().workId);
    expect(onResultRef).toHaveBeenCalledWith('j-a2a', 'task-xyz');
  });

  it('throws (retryable) when the seller returns a JSON-RPC error to message/send', async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/.well-known/agent-card.json')) return jsonResp(card());
      const req = JSON.parse(String(init?.body ?? '{}'));
      return jsonResp({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'seller down' } }, 200);
    }) as unknown as typeof fetch;
    const d = a2aDriver({ fetchFn });
    await expect(d.dispatch(job())).rejects.toThrow();
  });

  it('refuses a card whose service url points off the registered seller origin (SSRF)', async () => {
    const { fetchFn } = mockA2A({ cardUrl: 'https://evil.example.com/rpc' });
    const d = a2aDriver({ fetchFn });
    await expect(d.dispatch(job())).rejects.toThrow(/allow/i);
  });
});

describe('a2aDriver.fetchResult', () => {
  it('extracts the DataPart artifact from a completed task, normalized', async () => {
    const { fetchFn } = mockA2A({ task: completedTask('task-xyz') });
    const d = a2aDriver({ fetchFn });
    const art = await d.fetchResult(job(), 'task-xyz');
    expect(art).toEqual({ type: 'answer', payload: 'the a2a answer' });
  });

  it('returns null while the task is still working (not ready)', async () => {
    const { fetchFn } = mockA2A({ taskState: 'working' });
    const d = a2aDriver({ fetchFn });
    expect(await d.fetchResult(job(), 'task-xyz')).toBeNull();
  });

  it('returns null when there is no task id to poll', async () => {
    const { fetchFn } = mockA2A();
    const d = a2aDriver({ fetchFn });
    expect(await d.fetchResult(job())).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
