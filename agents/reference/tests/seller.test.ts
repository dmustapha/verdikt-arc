import { describe, it, expect, vi } from 'vitest';
import { parseDispatch, deliverArtifact, buildAgentCard } from '../src/lib/seller.js';
import type { SellerSkill } from '../src/lib/seller.js';
import type { Artifact } from '../src/lib/types.js';

// The Verdikt-standard seller harness (WS5). Pure/injectable pieces of the deliver-then-settle contract:
//  - parseDispatch: read the worker's dispatch envelope (workId + route-filtered brief + callback coords).
//  - deliverArtifact: POST the finished artifact back to the worker's callback, authed by the per-job token.
//  - buildAgentCard: the A2A card that makes the seller discoverable + standard-compliant.

const skill: SellerSkill = {
  id: 'research', name: 'Research & Summary', description: 'Grounded answers with sources',
  route: 'answer', tags: ['research', 'summary'], capability: 'grounded-research',
  doWork: async () => ({ type: 'answer', payload: 'x' }),
  acceptanceTemplate: { spec: 'Answer the question grounded strictly in the provided sources.', inputLabel: 'Your question + the source text' },
};

describe('parseDispatch', () => {
  it('reads a valid dispatch envelope (workId, brief, callback coords)', () => {
    const env = parseDispatch({
      workId: `0x${'ab'.repeat(32)}`,
      brief: { type: 'answer', spec: 'What is the capital of France?', sources: 'Paris is the capital of France.' },
      callbackUrl: 'https://worker.example/webhook/callback/j1', callbackToken: 'tok', deadline: '2026-01-01T00:00:00Z',
    });
    expect(env.workId).toBe(`0x${'ab'.repeat(32)}`);
    expect(env.brief?.spec).toBe('What is the capital of France?');
    expect(env.callbackUrl).toBe('https://worker.example/webhook/callback/j1');
    expect(env.callbackToken).toBe('tok');
  });

  it('throws when the callback coordinates are missing (cannot deliver without them)', () => {
    expect(() => parseDispatch({ workId: `0x${'ab'.repeat(32)}`, brief: null, callbackToken: 'tok', deadline: 'd' })).toThrow(/callbackUrl/i);
    expect(() => parseDispatch({ workId: `0x${'ab'.repeat(32)}`, brief: null, callbackUrl: 'https://w/x', deadline: 'd' })).toThrow(/callbackToken/i);
  });

  it('accepts a null brief (a canned seller needs no input)', () => {
    const env = parseDispatch({ workId: `0x${'cd'.repeat(32)}`, brief: null, callbackUrl: 'https://w/x', callbackToken: 't', deadline: 'd' });
    expect(env.brief).toBeNull();
  });
});

describe('deliverArtifact', () => {
  const artifact: Artifact = { type: 'answer', payload: 'The capital of France is Paris.' };

  it('POSTs the artifact to the callback with the per-job token + a jti', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 })) as unknown as typeof fetch;
    const r = await deliverArtifact({ callbackUrl: 'https://worker.example/webhook/callback/j1', callbackToken: 'secret-tok', artifact, jti: 'jti-1', fetchFn });
    expect(r).toEqual({ ok: true, status: 202 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://worker.example/webhook/callback/j1');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Callback-Token']).toBe('secret-tok');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ jti: 'jti-1', artifact });
  });

  it('reports not-ok on a non-2xx callback (the worker rejected the delivery)', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 409 })) as unknown as typeof fetch;
    const r = await deliverArtifact({ callbackUrl: 'https://w/x', callbackToken: 't', artifact, jti: 'j', fetchFn });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });
});

describe('buildAgentCard', () => {
  it('produces a valid A2A card whose service url is the seller base and lists the skill', () => {
    const card = buildAgentCard(skill, 'https://seller.example/research');
    expect(card.name).toContain('Research');
    expect(card.url).toBe('https://seller.example/research');
    expect(Array.isArray(card.skills)).toBe(true);
    expect(card.skills[0].id).toBe('research');
    expect(card.defaultInputModes).toContain('application/json');
  });
});
