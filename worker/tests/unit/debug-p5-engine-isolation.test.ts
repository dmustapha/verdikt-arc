// Debug Phase 5.4 — RC-10 per-instance config isolation.
// CONCERN: two verdicts running concurrently with DIFFERENT acceptance criteria / types must
// each use their OWN task config. Verdict A's acceptance/evidence must not leak into verdict B.
// We mock the Anthropic client to ECHO the bundle it was handed, then assert each concurrent call
// got back exactly its own bundle's evidence — proving no shared module-level mutable state.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvidenceBundle } from '../../src/types.js';

// The mock parses the bundle out of the user message and cites that bundle's own first item,
// so a leak (call B seeing A's bundle) would surface as a mismatched citation.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (req: { messages: { content: string }[] }) => {
        const text = req.messages[0].content;
        const json = text.slice(text.indexOf('{'));
        const bundle = JSON.parse(json) as EvidenceBundle;
        const firstId = bundle.items[0]?.id ?? 'none';
        // Small async yield so concurrent calls genuinely interleave.
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return {
          content: [{
            type: 'tool_use', name: 'emit_verdict',
            input: { verdict: 'pass', confidence: 1, cited_evidence: [firstId], rationale: `saw ${firstId}` },
          }],
        };
      },
    };
  },
}));

const { reasonOverEvidence } = await import('../../src/engine/reasoner.js');

beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; });

function bundleFor(tag: string): EvidenceBundle {
  return {
    route: 'tool_output',
    items: [{ id: `schema:${tag}`, kind: 'schema_check', label: tag, status: 'pass', detail: tag }],
  };
}

describe('RC-10 — concurrent verdicts do not share acceptance/evidence state', () => {
  it('two concurrent reasoner calls each see ONLY their own bundle', async () => {
    const [a, b] = await Promise.all([
      reasonOverEvidence(bundleFor('alpha')),
      reasonOverEvidence(bundleFor('beta')),
    ]);
    // Each verdict cites its own bundle's evidence id — no cross-contamination.
    expect(a.citedEvidence).toEqual(['schema:alpha']);
    expect(a.rationale).toContain('schema:alpha');
    expect(b.citedEvidence).toEqual(['schema:beta']);
    expect(b.rationale).toContain('schema:beta');
    // The evidence hashes are distinct (different canonical bundles).
    expect(a.evidenceHash).not.toEqual(b.evidenceHash);
  });

  it('high-concurrency fan-out: 20 distinct bundles, each verdict isolated', async () => {
    const tags = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const results = await Promise.all(tags.map((t) => reasonOverEvidence(bundleFor(t))));
    results.forEach((r, i) => {
      expect(r.citedEvidence).toEqual([`schema:t${i}`]);
    });
    // All evidence hashes unique → no two verdicts collapsed onto a shared bundle.
    const hashes = new Set(results.map((r) => r.evidenceHash));
    expect(hashes.size).toBe(20);
  });

  it('a failing bundle concurrent with passing bundles does not contaminate the passers', async () => {
    const failing: EvidenceBundle = {
      route: 'code',
      items: [{ id: 'bandit:B608', kind: 'static', label: 'B608', status: 'fail', detail: 'SQLi' }],
    };
    const [bad, good1, good2] = await Promise.all([
      reasonOverEvidence(failing),
      reasonOverEvidence(bundleFor('clean1')),
      reasonOverEvidence(bundleFor('clean2')),
    ]);
    expect(bad.verdict).toBe('fail');          // floor fires for the bad one
    expect(good1.verdict).toBe('pass');         // good ones unaffected
    expect(good2.verdict).toBe('pass');
    expect(good1.citedEvidence).toEqual(['schema:clean1']);
    expect(good2.citedEvidence).toEqual(['schema:clean2']);
  });
});
