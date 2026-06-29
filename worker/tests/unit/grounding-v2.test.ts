// F1: claim-decomposition + per-claim entailment grounding gate. The Anthropic SDK is mocked to
// return claims (emit_claims) then per-claim entailment (emit_entailments). The deterministic gate
// requires every entailed claim to have a verbatim-locatable span in the sources.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Acceptance, Artifact } from '../../src/types.js';

let claims: string[] = [];
let entailments: Array<{ claim: string; label: string; supporting_span: string }> = [];

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (req: { tools: Array<{ name: string }> }) => {
        const tool = req.tools[0].name;
        const input = tool === 'emit_claims' ? { claims } : { results: entailments };
        return { content: [{ type: 'tool_use', name: tool, input }] };
      },
    };
  },
}));

const { runGroundingV2 } = await import('../../src/engine/grounding-nli.js');

const SOURCES = 'The Arc testnet finalizes blocks in approximately 0.48 seconds. USDC on Arc has 6 decimals.';
const acceptance: Acceptance = { spec: 'grounded', sources: SOURCES };
const art: Artifact = { type: 'answer', payload: 'Arc finalizes blocks in ~0.48s and USDC has 6 decimals.' };

beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test'; delete process.env.GROUNDING_NLI; });

describe('F1 — grounding v2 (claim decomposition + entailment)', () => {
  it('all claims entailed with located spans → pass, no routeError', async () => {
    claims = ['Arc finalizes blocks in about 0.48 seconds', 'USDC on Arc has 6 decimals'];
    entailments = [
      { claim: claims[0], label: 'entailed', supporting_span: 'finalizes blocks in approximately 0.48 seconds' },
      { claim: claims[1], label: 'entailed', supporting_span: 'USDC on Arc has 6 decimals' },
    ];
    const b = await runGroundingV2(acceptance, art);
    expect(b.routeError).toBeUndefined();
    expect(b.items.length).toBe(2);
    expect(b.items.every((i) => i.status === 'pass')).toBe(true);
  });

  it('a contradicted claim → fail (refund), span item marked fail', async () => {
    claims = ['Arc uses proof of work'];
    entailments = [{ claim: claims[0], label: 'contradicted', supporting_span: '' }];
    const b = await runGroundingV2(acceptance, art);
    expect(b.items[0].status).toBe('fail');
    expect(b.routeError).toBeUndefined(); // contradiction surfaces as a hard fail, not abstain
  });

  it('entailed claim but span NOT in sources → abstain (deterministic anchor blocks it)', async () => {
    claims = ['Arc finalizes in 0.48s'];
    entailments = [{ claim: claims[0], label: 'entailed', supporting_span: 'this text is absent from the sources entirely' }];
    const b = await runGroundingV2(acceptance, art);
    expect(b.items[0].status).toBe('info');
    expect(b.routeError).toMatch(/not all claims/);
  });

  it('a not_entailed claim → abstain', async () => {
    claims = ['Arc finalizes in 0.48s', 'Arc has a native governance token called ARC'];
    entailments = [
      { claim: claims[0], label: 'entailed', supporting_span: 'finalizes blocks in approximately 0.48 seconds' },
      { claim: claims[1], label: 'not_entailed', supporting_span: '' },
    ];
    const b = await runGroundingV2(acceptance, art);
    expect(b.routeError).toMatch(/not all claims/);
  });

  it('no sources → routeError', async () => {
    const b = await runGroundingV2({ spec: 'x' }, art);
    expect(b.routeError).toBe('payer provided no sources');
  });

  it('no claims extracted → routeError (abstain)', async () => {
    claims = [];
    const b = await runGroundingV2(acceptance, art);
    expect(b.routeError).toMatch(/no checkable claims/);
  });
});
