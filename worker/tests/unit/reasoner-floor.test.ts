import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvidenceBundle } from '../../src/types.js';

// Mock the Anthropic SDK so the reasoner's deterministic guards can be tested without network,
// credits, or non-determinism. Each test sets what the "model" returns via mockToolInput.
let mockToolInput: Record<string, unknown> | null = { verdict: 'pass', confidence: 1, cited_evidence: [], rationale: 'ok' };
let mockThrows = false;

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = {
        create: async () => {
          if (mockThrows) throw new Error('simulated API error');
          if (mockToolInput === null) return { content: [{ type: 'text', text: 'no tool' }] };
          return { content: [{ type: 'tool_use', name: 'emit_verdict', input: mockToolInput }] };
        },
      };
    },
  };
});

const { reasonOverEvidence } = await import('../../src/engine/reasoner.js');

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockThrows = false;
  mockToolInput = { verdict: 'pass', confidence: 1, cited_evidence: [], rationale: 'ok' };
});

const staticBundle: EvidenceBundle = {
  route: 'code',
  items: [
    { id: 'test:t', kind: 'test', label: 't', status: 'fail', detail: '' },
    { id: 'semgrep:sqli', kind: 'static', label: 'sqli', status: 'fail', detail: '' },
  ],
};

describe('reasonOverEvidence — deterministic floor (anti false-certify)', () => {
  it('static finding can NEVER become pass even if the model says pass → fail', async () => {
    mockToolInput = { verdict: 'pass', confidence: 1, cited_evidence: ['semgrep:sqli'], rationale: 'looks fine' };
    const r = await reasonOverEvidence(staticBundle);
    expect(r.verdict).toBe('fail');
    expect(r.verdictCode).toBe(1);
  });

  it('static finding with API down → still fail (floor independent of Claude)', async () => {
    mockThrows = true;
    const r = await reasonOverEvidence(staticBundle);
    expect(r.verdict).toBe('fail');
    expect(r.citedEvidence).toContain('semgrep:sqli');
  });

  it('routeError bundle → abstain', async () => {
    const r = await reasonOverEvidence({ route: 'code', items: [], routeError: 'sandbox error' });
    expect(r.verdict).toBe('abstain');
  });

  it('empty bundle → abstain', async () => {
    const r = await reasonOverEvidence({ route: 'answer', items: [] });
    expect(r.verdict).toBe('abstain');
  });

  it('fabricated citation forces abstain (anti-hallucination)', async () => {
    const goodBundle: EvidenceBundle = {
      route: 'tool_output',
      items: [{ id: 'schema:has_body', kind: 'schema_check', label: 'b', status: 'pass', detail: '' }],
    };
    mockToolInput = { verdict: 'pass', confidence: 1, cited_evidence: ['schema:does_not_exist'], rationale: 'x' };
    const r = await reasonOverEvidence(goodBundle);
    expect(r.verdict).toBe('abstain');
    expect(r.abstainReason).toBe('fabricated citation');
  });

  it('all-pass bundle with valid citation → honors model pass', async () => {
    const goodBundle: EvidenceBundle = {
      route: 'tool_output',
      items: [{ id: 'schema:has_body', kind: 'schema_check', label: 'b', status: 'pass', detail: '' }],
    };
    mockToolInput = { verdict: 'pass', confidence: 0.95, cited_evidence: ['schema:has_body'], rationale: 'all checks pass' };
    const r = await reasonOverEvidence(goodBundle);
    expect(r.verdict).toBe('pass');
    expect(r.verdictCode).toBe(0);
  });

  it('no structured output on a clean bundle → abstain (never fabricate pass)', async () => {
    const goodBundle: EvidenceBundle = {
      route: 'tool_output',
      items: [{ id: 'schema:has_body', kind: 'schema_check', label: 'b', status: 'pass', detail: '' }],
    };
    mockToolInput = null;
    const r = await reasonOverEvidence(goodBundle);
    expect(r.verdict).toBe('abstain');
  });
});
