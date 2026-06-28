import { describe, it, expect } from 'vitest';
import { runSchemaRoute } from '../../src/engine/schema-route.js';
import type { Acceptance, Artifact } from '../../src/types.js';

const acceptance: Acceptance = {
  spec: '',
  schema: {
    symbol: { type: 'string', required: true },
    price: { type: 'number', required: true, min: 0 },
    confidence: { type: 'number', required: true, min: 0, max: 1 },
  },
  minResponseBytes: 10,
};

function art(payload: string): Artifact {
  return { type: 'tool_output', payload };
}

function item(bundle: ReturnType<typeof runSchemaRoute>, id: string) {
  return bundle.items.find((i) => i.id === id);
}

describe('runSchemaRoute', () => {
  it('good output: all six checks pass, no fail items', () => {
    const b = runSchemaRoute(acceptance, art('{ "symbol": "ETH", "price": 3421.55, "confidence": 0.92 }'));
    expect(b.route).toBe('tool_output');
    expect(b.routeError).toBeUndefined();
    expect(b.items).toHaveLength(6); // 1D: has_body, valid_json, fields_present, schema_match, value_bounds, no_extra_fields
    expect(b.items.every((i) => i.status === 'pass')).toBe(true);
  });

  it('extra undeclared field fails no_extra_fields (strict matching)', () => {
    const b = runSchemaRoute(acceptance, art('{ "symbol": "ETH", "price": 1, "confidence": 0.5, "leaked": "smuggled" }'));
    expect(item(b, 'schema:no_extra_fields')?.status).toBe('fail');
    expect(item(b, 'schema:no_extra_fields')?.detail).toContain('leaked');
  });

  it('bad output: schema_match fails (wrong type) and value_bounds fails (out of range)', () => {
    const b = runSchemaRoute(acceptance, art('{ "symbol": "ETH", "price": "expensive", "confidence": 1.8 }'));
    expect(item(b, 'schema:schema_match')?.status).toBe('fail');
    expect(item(b, 'schema:schema_match')?.detail).toContain('price');
    expect(item(b, 'schema:value_bounds')?.status).toBe('fail');
    expect(item(b, 'schema:value_bounds')?.detail).toContain('confidence');
  });

  it('missing required field is flagged by fields_present', () => {
    const b = runSchemaRoute(acceptance, art('{ "symbol": "ETH", "price": 1 }'));
    expect(item(b, 'schema:fields_present')?.status).toBe('fail');
    expect(item(b, 'schema:fields_present')?.detail).toContain('confidence');
  });

  it('invalid JSON fails valid_json and skips deeper checks', () => {
    const b = runSchemaRoute(acceptance, art('not json'));
    expect(item(b, 'schema:valid_json')?.status).toBe('fail');
    expect(item(b, 'schema:schema_match')).toBeUndefined();
  });

  it('empty schema → routeError (abstain upstream)', () => {
    const b = runSchemaRoute({ spec: '' }, art('{}'));
    expect(b.routeError).toBe('payer provided no schema');
    expect(b.items).toHaveLength(0);
  });
});
