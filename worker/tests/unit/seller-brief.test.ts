import { describe, it, expect } from 'vitest';
import { buildSellerBrief } from '../../src/lib/seller-brief.js';
import type { Task, Acceptance } from '../../src/types.js';

// buildSellerBrief turns a funded Task into the SELLER-FACING view that rides in the dispatch envelope
// (Option C). It is a deliberate, route-filtered projection: the seller sees exactly the input it needs
// to do the work (the question + sources, the target schema, or the failing test) — never more. The
// payer's full `acceptance` still governs the money at verdict time; the brief is not a criterion.

function task(type: Task['type'], acceptance: Acceptance): Task {
  return { workId: `0x${'ab'.repeat(32)}`, type, acceptance, payer: `0x${'11'.repeat(20)}`, worker: `0x${'22'.repeat(20)}`, amountUsdc: 0.1 };
}

describe('buildSellerBrief', () => {
  it('answer route: exposes the question (spec) + the sources to ground in', () => {
    const b = buildSellerBrief(task('answer', { spec: 'What is the capital of France?', sources: 'Paris is the capital of France.' }));
    expect(b).toEqual({ type: 'answer', spec: 'What is the capital of France?', sources: 'Paris is the capital of France.' });
  });

  it('tool_output route: exposes the target schema (both simple + full JSON Schema)', () => {
    const schema = { name: { type: 'string', required: true } } as Acceptance['schema'];
    const jsonSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const b = buildSellerBrief(task('tool_output', { spec: 'Extract the name.', schema, jsonSchema }));
    expect(b).toEqual({ type: 'tool_output', spec: 'Extract the name.', schema, jsonSchema });
  });

  it('code route (fair mode, no informal brief): shows the failing test the seller must make pass', () => {
    const tests = 'def test_average_empty():\n    assert average([]) == 0';
    const b = buildSellerBrief(task('code', { spec: 'Write average(nums).', tests }));
    expect(b).toEqual({ type: 'code', spec: 'Write average(nums).', tests });
  });

  it('code route (informal brief set): uses the informal brief as spec and HIDES the exact tests', () => {
    // The payer deliberately briefs loosely; the strict suite stays hidden and still governs the money
    // (the honest seller-gap model). The seller must not see the exact acceptance tests here.
    const b = buildSellerBrief(task('code', {
      spec: 'the strict internal spec', tests: 'def test_edge(): assert average([]) == 0',
      sellerBrief: 'Write average(nums) returning the mean of a list.',
    }));
    expect(b).toEqual({ type: 'code', spec: 'Write average(nums) returning the mean of a list.' });
    expect(b.tests).toBeUndefined();
  });

  it('an informal sellerBrief overrides spec for any route (seller sees the public brief, not the internal spec)', () => {
    const b = buildSellerBrief(task('answer', { spec: 'internal spec', sources: 'S', sellerBrief: 'Answer: what year did the Eiffel Tower open?' }));
    expect(b.spec).toBe('Answer: what year did the Eiffel Tower open?');
    expect(b.sources).toBe('S');
  });
});
