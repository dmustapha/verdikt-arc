// WS2 Gate B1 — tool_trace route: conformance of a claimed tool-call trace to a declared schema.
// Deterministic + pure. Money-safety: malformed / non-conforming → fail (→ floor → refund), never a
// clean pass; a missing schema → routeError → abstain. The honest caveat is always surfaced.
import { describe, it, expect } from 'vitest';
import { runToolTraceRoute } from '../../src/engine/tool-trace-route.js';
import type { Acceptance, Artifact, ToolTraceCriteria } from '../../src/types.js';

// A declared tool schema: one call = { tool: string, input: object, output: any }.
const CALL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { tool: { type: 'string' }, input: { type: 'object' }, output: {} },
  required: ['tool', 'input', 'output'],
  additionalProperties: false,
};

function acc(toolTrace?: ToolTraceCriteria): Acceptance { return { spec: 'trace', toolTrace }; }
function art(payload: string): Artifact { return { type: 'tool_trace', payload }; }
const byId = (b: { items: { id: string; status: string }[] }) =>
  Object.fromEntries(b.items.map((i) => [i.id, i.status]));

const goodCall = JSON.stringify({ tool: 'search', input: { q: 'x' }, output: [1, 2] });
const goodTrace = JSON.stringify([{ tool: 'search', input: { q: 'x' }, output: [] }, { tool: 'fetch', input: { url: 'u' }, output: 'ok' }]);

describe('tool_trace — conformance passes + honest caveat', () => {
  it('conforming single-object trace → conforms PASS, scope disclosed', () => {
    const b = runToolTraceRoute(acc({ jsonSchema: CALL_SCHEMA }), art(goodCall));
    const s = byId(b);
    expect(b.routeError).toBeUndefined();
    expect(s['trace:scope']).toBe('info');
    expect(s['trace:valid_json']).toBe('pass');
    expect(s['trace:conforms']).toBe('pass');
    expect(b.items.some((i) => i.status === 'fail')).toBe(false);
  });

  it('perCall: every element validated → PASS on a conforming array', () => {
    const b = runToolTraceRoute(acc({ jsonSchema: CALL_SCHEMA, perCall: true }), art(goodTrace));
    const s = byId(b);
    expect(s['trace:is_array']).toBe('pass');
    expect(s['trace:conforms']).toBe('pass');
    expect(b.items.some((i) => i.status === 'fail')).toBe(false);
  });

  it('the scope item is always informational (never a fail) and discloses the honest boundary', () => {
    const b = runToolTraceRoute(acc({ jsonSchema: CALL_SCHEMA }), art(goodCall));
    const scope = b.items.find((i) => i.id === 'trace:scope');
    expect(scope?.status).toBe('info');
    expect(scope?.detail.toLowerCase()).toContain('execution route'); // discloses that on-chain truth is a separate route
  });
});

describe('tool_trace — rejects malformed / non-conforming (never release)', () => {
  it('non-JSON payload → valid_json FAIL', () => {
    const b = runToolTraceRoute(acc({ jsonSchema: CALL_SCHEMA }), art('{ not json'));
    expect(byId(b)['trace:valid_json']).toBe('fail');
    expect(b.items.some((i) => i.id === 'trace:conforms')).toBe(false); // short-circuits before conformance
  });

  it('missing a required field → conforms FAIL', () => {
    const b = runToolTraceRoute(acc({ jsonSchema: CALL_SCHEMA }), art(JSON.stringify({ tool: 'search', input: {} })));
    expect(byId(b)['trace:conforms']).toBe('fail');
  });

  it('extra undeclared field (additionalProperties:false) → conforms FAIL', () => {
    const b = runToolTraceRoute(acc({ jsonSchema: CALL_SCHEMA }), art(JSON.stringify({ tool: 'x', input: {}, output: 1, secret: 'leak' })));
    expect(byId(b)['trace:conforms']).toBe('fail');
  });

  it('perCall: one bad element in the array → conforms FAIL', () => {
    const mixed = JSON.stringify([{ tool: 'ok', input: {}, output: 1 }, { tool: 'bad' /* missing input+output */ }]);
    const b = runToolTraceRoute(acc({ jsonSchema: CALL_SCHEMA, perCall: true }), art(mixed));
    expect(byId(b)['trace:conforms']).toBe('fail');
  });

  it('perCall: non-array payload → is_array FAIL', () => {
    const b = runToolTraceRoute(acc({ jsonSchema: CALL_SCHEMA, perCall: true }), art(goodCall));
    expect(byId(b)['trace:is_array']).toBe('fail');
  });

  it('perCall: empty array → is_array FAIL (an empty trace proves nothing)', () => {
    const b = runToolTraceRoute(acc({ jsonSchema: CALL_SCHEMA, perCall: true }), art('[]'));
    expect(byId(b)['trace:is_array']).toBe('fail');
  });
});

describe('tool_trace — abstain when criteria absent', () => {
  it('no toolTrace criteria → routeError', () => {
    expect(runToolTraceRoute(acc(undefined), art(goodCall)).routeError).toBeTruthy();
  });
  it('empty jsonSchema → routeError', () => {
    expect(runToolTraceRoute(acc({ jsonSchema: {} }), art(goodCall)).routeError).toBeTruthy();
  });
});

describe('tool_trace — determinism', () => {
  it('same schema + payload → identical bundle', () => {
    const c: ToolTraceCriteria = { jsonSchema: CALL_SCHEMA };
    expect(runToolTraceRoute(acc(c), art(goodCall))).toEqual(runToolTraceRoute(acc(c), art(goodCall)));
  });
});
