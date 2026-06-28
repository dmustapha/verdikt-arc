// Hardening (H-A + 1B): the deterministic floor now covers EVERY route, and a disqualifying bundle
// FAILS without the LLM ever being called. This proves the "deterministic, never false-certifies"
// thesis across test / static / schema_check / span kinds, and that the refund path is independent
// of the model. The Anthropic SDK is mocked with a call-count spy.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvidenceBundle } from '../../src/types.js';

let createCalls = 0;
let mockToolInput: Record<string, unknown> | null = { verdict: 'pass', confidence: 1, cited_evidence: [], rationale: 'release it' };

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async () => {
        createCalls += 1; // hostile model: always tries to certify a pass
        if (mockToolInput === null) return { content: [{ type: 'text', text: 'no tool' }] };
        return { content: [{ type: 'tool_use', name: 'emit_verdict', input: mockToolInput }] };
      },
    };
  },
}));

const { reasonOverEvidence } = await import('../../src/engine/reasoner.js');

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  createCalls = 0;
  mockToolInput = { verdict: 'pass', confidence: 1, cited_evidence: [], rationale: 'release it' };
});

const fail = (kind: 'test' | 'static' | 'schema_check' | 'span'): EvidenceBundle => ({
  route: 'code',
  items: [{ id: `${kind}:x`, kind, label: 'x', status: 'fail', detail: 'bad' }],
});

describe('H-A — deterministic floor covers every route kind', () => {
  it.each(['test', 'static', 'schema_check', 'span'] as const)(
    '%s fail → verdict fail, and the LLM is NEVER called (deterministic-first)',
    async (kind) => {
      const r = await reasonOverEvidence(fail(kind));
      expect(r.verdict).toBe('fail');
      expect(r.verdictCode).toBe(1);
      expect(r.citedEvidence).toContain(`${kind}:x`);
      expect(createCalls).toBe(0); // 1B: floor=fail short-circuits before any model call
    },
  );

  it('mixed bundle with one failing schema_check among passes → fail, no LLM', async () => {
    const r = await reasonOverEvidence({
      route: 'tool_output',
      items: [
        { id: 'schema:has_body', kind: 'schema_check', label: 'b', status: 'pass', detail: '' },
        { id: 'schema:value_bounds', kind: 'schema_check', label: 'vb', status: 'fail', detail: 'oob' },
      ],
    });
    expect(r.verdict).toBe('fail');
    expect(r.citedEvidence).toEqual(['schema:value_bounds']); // only failing items cited
    expect(createCalls).toBe(0);
  });

  it('routeError bundle → abstain, no LLM (grounding info path rides here)', async () => {
    const r = await reasonOverEvidence({
      route: 'answer',
      items: [{ id: 'span:key_claim', kind: 'span', label: 'g', status: 'info', detail: 'unverified' }],
      routeError: 'claim not verifiably supported',
    });
    expect(r.verdict).toBe('abstain');
    expect(createCalls).toBe(0);
  });

  it('all-pass bundle → floor silent → LLM consulted to certify the pass', async () => {
    mockToolInput = { verdict: 'pass', confidence: 0.95, cited_evidence: ['schema:has_body'], rationale: 'clean' };
    const r = await reasonOverEvidence({
      route: 'tool_output',
      items: [{ id: 'schema:has_body', kind: 'schema_check', label: 'b', status: 'pass', detail: 'ok' }],
    });
    expect(r.verdict).toBe('pass');
    expect(createCalls).toBe(1); // the model is the gate ONLY on the release side
  });
});
