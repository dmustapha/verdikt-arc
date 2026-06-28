// Hardening (1E): the grounding route is no longer "just an LLM". The model proposes a key claim +
// span; deterministic lexical checks (verbatim + substantive + claim-token recall) dispose. These
// tests mock the model and prove a degenerate/injected response cannot certify a trivial span.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Acceptance, Artifact } from '../../src/types.js';

let mockOut: { key_claim: string; label: string; supporting_span: string } | null = null;

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async () => {
        if (mockOut === null) return { content: [{ type: 'text', text: 'no tool' }] };
        return { content: [{ type: 'tool_use', name: 'report_grounding', input: mockOut }] };
      },
    };
  },
}));

const { runGroundingRoute } = await import('../../src/engine/grounding-route.js');

const SOURCES =
  'The Arc testnet finalizes blocks in approximately 0.48 seconds using a proof-of-authority validator set.';
const acceptance: Acceptance = { spec: 'grounded answer', sources: SOURCES };
const art: Artifact = { type: 'answer', payload: 'Arc finalizes blocks in about 0.48 seconds.' };
const GENUINE_SPAN = 'finalizes blocks in approximately 0.48 seconds';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockOut = null;
});

describe('grounding deterministic entailment gate', () => {
  it('genuine supported + substantive verbatim span covering the claim → pass, no routeError', async () => {
    mockOut = { key_claim: 'Arc finalizes blocks in about 0.48 seconds', label: 'supported', supporting_span: GENUINE_SPAN };
    const b = await runGroundingRoute(acceptance, art);
    expect(b.items[0].status).toBe('pass');
    expect(b.routeError).toBeUndefined();
  });

  it('trivial span ("the") cannot pass even when labeled supported → abstain', async () => {
    mockOut = { key_claim: 'Arc finalizes blocks in about 0.48 seconds', label: 'supported', supporting_span: 'the' };
    const b = await runGroundingRoute(acceptance, art);
    expect(b.items[0].status).toBe('info');
    expect(b.routeError).toMatch(/substantive/);
  });

  it('span not present verbatim in sources → abstain', async () => {
    mockOut = { key_claim: 'x', label: 'supported', supporting_span: 'this exact sentence is absent from the provided sources entirely' };
    const b = await runGroundingRoute(acceptance, art);
    expect(b.items[0].status).toBe('info');
    expect(b.routeError).toMatch(/verbatim/);
  });

  it('substantive verbatim span that does NOT cover the claim tokens → abstain', async () => {
    mockOut = { key_claim: 'bitcoin proof of work mining difficulty halving epoch', label: 'supported', supporting_span: GENUINE_SPAN };
    const b = await runGroundingRoute(acceptance, art);
    expect(b.items[0].status).toBe('info');
    expect(b.routeError).toMatch(/% of the claim/);
  });

  it('model labels unsupported → abstain regardless of span', async () => {
    mockOut = { key_claim: 'Arc finalizes blocks in about 0.48 seconds', label: 'unsupported', supporting_span: GENUINE_SPAN };
    const b = await runGroundingRoute(acceptance, art);
    expect(b.items[0].status).toBe('info');
    expect(b.routeError).toMatch(/unsupported/);
  });

  it('no sources → routeError before any model call', async () => {
    const b = await runGroundingRoute({ spec: 'x' }, art);
    expect(b.routeError).toBe('payer provided no sources');
  });
});
