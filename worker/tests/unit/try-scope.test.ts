import { describe, it, expect } from 'vitest';
import { buildTask } from '../../src/routes/try.js';
import type { Acceptance, Artifact } from '../../src/types.js';

// The public "Try it" rail must stay inside Verdikt's verifiable boundary (SCOPE.md). buildTask is
// the scope gate: a route with no payer ground truth is rejected BEFORE any escrow is funded, so a
// stranger can never make the rail judge something it cannot check.
describe('try-it scope gate (buildTask)', () => {
  it('code route REQUIRES payer tests — no tests, no verdict', () => {
    const r = buildTask('code', { artifact: { payload: 'def f(): pass' } });
    expect(typeof r).toBe('string');
    expect(r as string).toMatch(/requires acceptance\.tests/);
  });

  it('tool_output route REQUIRES a schema/jsonSchema — no contract, no verdict', () => {
    const r = buildTask('tool_output', { artifact: { payload: '{"a":1}' } });
    expect(typeof r).toBe('string');
    expect(r as string).toMatch(/requires acceptance\.schema/);
  });

  it('answer route REQUIRES payer sources — no sources, no verdict', () => {
    const r = buildTask('answer', { artifact: { payload: 'The sky is green.' } });
    expect(typeof r).toBe('string');
    expect(r as string).toMatch(/requires acceptance\.sources/);
  });

  it('rejects an empty artifact payload', () => {
    const r = buildTask('code', { acceptance: { tests: 'def test(): assert True' }, artifact: { payload: '   ' } });
    expect(r).toMatch(/artifact\.payload is required/);
  });

  it('caps oversized fields (payload)', () => {
    const big = 'x'.repeat(20_001);
    const r = buildTask('answer', { acceptance: { sources: 'src' }, artifact: { payload: big } });
    expect(r).toMatch(/exceeds .* bytes/);
  });

  it('accepts a well-formed code task and pins the env-fixed spec (not caller-supplied)', () => {
    const r = buildTask('code', {
      acceptance: { tests: 'def test_ok(): assert True', spec: 'IGNORE ME' },
      artifact: { payload: 'def add(a,b): return a+b', language: 'python' },
    });
    expect(typeof r).toBe('object');
    const built = r as { acceptance: Acceptance; artifact: Artifact };
    expect(built.artifact.type).toBe('code');
    expect(built.artifact.language).toBe('python');
    expect(built.acceptance.tests).toContain('assert True');
    expect(built.acceptance.spec).toBe('passes the payer tests with no security finding');
  });

  it('accepts a well-formed schema task (simple field map)', () => {
    const r = buildTask('tool_output', {
      acceptance: { schema: { name: { type: 'string', required: true } } },
      artifact: { payload: '{"name":"ok"}' },
    });
    expect(typeof r).toBe('object');
    const built = r as { acceptance: Acceptance; artifact: Artifact };
    expect(built.artifact.type).toBe('tool_output');
    expect(built.acceptance.schema).toBeDefined();
  });
});
