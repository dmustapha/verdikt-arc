// E1: full JSON Schema (draft 2020-12 + ajv-formats) mode, and format/pattern in the simple field map.
import { describe, it, expect } from 'vitest';
import { runSchemaRoute } from '../../src/engine/schema-route.js';
import type { Acceptance, Artifact } from '../../src/types.js';

const art = (payload: string): Artifact => ({ type: 'tool_output', payload });
const find = (b: ReturnType<typeof runSchemaRoute>, id: string) => b.items.find((i) => i.id === id);

describe('E1 — full JSON Schema mode', () => {
  const acceptance: Acceptance = {
    spec: 'order',
    jsonSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        qty: { type: 'integer', minimum: 1, maximum: 100 },
        sku: { type: 'string', pattern: '^[A-Z]{3}-[0-9]{4}$' },
      },
      required: ['email', 'qty', 'sku'],
      additionalProperties: false,
    },
    minResponseBytes: 5,
  };

  it('valid object → json_schema passes', () => {
    const b = runSchemaRoute(acceptance, art('{"email":"a@b.com","qty":5,"sku":"ABC-1234"}'));
    expect(find(b, 'schema:json_schema')?.status).toBe('pass');
    expect(b.items.every((i) => i.status === 'pass')).toBe(true);
  });

  it('bad email format → fail (format assertion is ON)', () => {
    const b = runSchemaRoute(acceptance, art('{"email":"not-an-email","qty":5,"sku":"ABC-1234"}'));
    expect(find(b, 'schema:json_schema')?.status).toBe('fail');
    expect(find(b, 'schema:json_schema')?.detail).toMatch(/email/);
  });

  it('out-of-range integer → fail', () => {
    const b = runSchemaRoute(acceptance, art('{"email":"a@b.com","qty":999,"sku":"ABC-1234"}'));
    expect(find(b, 'schema:json_schema')?.status).toBe('fail');
  });

  it('pattern mismatch → fail', () => {
    const b = runSchemaRoute(acceptance, art('{"email":"a@b.com","qty":5,"sku":"bad"}'));
    expect(find(b, 'schema:json_schema')?.status).toBe('fail');
  });

  it('additionalProperties:false rejects extra fields', () => {
    const b = runSchemaRoute(acceptance, art('{"email":"a@b.com","qty":5,"sku":"ABC-1234","leak":1}'));
    expect(find(b, 'schema:json_schema')?.status).toBe('fail');
  });

  it('malformed payer schema → routeError (abstain), never throws', () => {
    const bad: Acceptance = { spec: 'x', jsonSchema: { type: 'object', properties: { a: { type: 'not-a-type' } } } };
    expect(() => runSchemaRoute(bad, art('{"a":1}'))).not.toThrow();
    const b = runSchemaRoute(bad, art('{"a":1}'));
    expect(b.routeError).toMatch(/invalid payer JSON Schema/);
  });
});

describe('E1 — format/pattern in the simple field map', () => {
  const acceptance: Acceptance = {
    spec: 'profile',
    schema: {
      handle: { type: 'string', required: true, pattern: '^@[a-z0-9_]+$' },
      site: { type: 'string', required: false, format: 'uri' },
    },
    minResponseBytes: 5,
  };

  it('valid handle + uri → format_match passes', () => {
    const b = runSchemaRoute(acceptance, art('{"handle":"@neo","site":"https://x.io"}'));
    expect(find(b, 'schema:format_match')?.status).toBe('pass');
  });

  it('bad handle pattern → format_match fails', () => {
    const b = runSchemaRoute(acceptance, art('{"handle":"NEO!","site":"https://x.io"}'));
    expect(find(b, 'schema:format_match')?.status).toBe('fail');
    expect(find(b, 'schema:format_match')?.detail).toMatch(/handle/);
  });

  it('no format/pattern fields → no format_match item (back-compat)', () => {
    const plain: Acceptance = { spec: 'x', schema: { a: { type: 'number', required: true } }, minResponseBytes: 2 };
    const b = runSchemaRoute(plain, art('{"a":1}'));
    expect(find(b, 'schema:format_match')).toBeUndefined();
  });
});
