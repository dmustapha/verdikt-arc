import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Acceptance, Artifact, EvidenceBundle, EvidenceItem, SchemaField } from '../types.js';

function evItem(id: string, label: string, passed: boolean, detail: string): EvidenceItem {
  return { id: `schema:${id}`, kind: 'schema_check', label, status: passed ? 'pass' : 'fail', detail };
}

// One shared ajv with formats enabled (E1: format assertion is opt-in under draft 2020-12).
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));

// Validate a single value against a one-off {type, format, pattern, enum} schema via ajv. Returns a
// human violation string or null. Lets the simple SchemaField map gain real format/pattern checks.
function fieldViolation(spec: SchemaField, val: unknown): string | null {
  if (val === undefined || val === null) return null; // presence handled elsewhere
  const sub: Record<string, unknown> = { type: spec.type };
  if (spec.format) sub.format = spec.format;
  if (spec.pattern) sub.pattern = spec.pattern;
  if (!spec.format && !spec.pattern) return null;     // nothing format-ish to check
  const validate = ajv.compile(sub);
  return validate(val) ? null : (validate.errors ?? []).map((e) => e.message).join('; ');
}

export function runSchemaRoute(acceptance: Acceptance, artifact: Artifact): EvidenceBundle {
  const minBytes = acceptance.minResponseBytes ?? 2;
  const body = artifact.payload;
  const items: EvidenceItem[] = [];

  // 1. HAS_BODY
  const size = Buffer.byteLength(body, 'utf8');
  items.push(evItem('has_body', 'Has Body', size >= minBytes, `${size} bytes (min ${minBytes})`));

  // 2. VALID_JSON
  let parsed: unknown = null;
  try { parsed = JSON.parse(body); items.push(evItem('valid_json', 'Valid JSON', true, 'parsed')); }
  catch { items.push(evItem('valid_json', 'Valid JSON', false, 'invalid JSON')); }
  if (parsed === null && size < minBytes) return { route: 'tool_output', items };
  if (parsed === null) return { route: 'tool_output', items };

  // ── Full JSON Schema mode (E1) ─────────────────────────────────────────────
  // If the payer supplied a complete JSON Schema (draft 2020-12), validate against it with ajv +
  // formats. This unlocks pattern, enum/const, if/then/else, dependentRequired, unevaluatedProperties,
  // multipleOf, format assertion, etc. — far beyond the hand-rolled field map.
  if (acceptance.jsonSchema && Object.keys(acceptance.jsonSchema).length > 0) {
    let validate;
    try { validate = ajv.compile(acceptance.jsonSchema); }
    catch (e) {
      return { route: 'tool_output', items, routeError: `invalid payer JSON Schema: ${e instanceof Error ? e.message : String(e)}` };
    }
    const okValid = validate(parsed);
    const errs = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    items.push(evItem('json_schema', 'JSON Schema', okValid, okValid ? 'validates against payer schema' : errs.slice(0, 400)));
    return { route: 'tool_output', items };
  }

  // ── Simple field-map mode (legacy + format/pattern) ────────────────────────
  const schema = acceptance.schema ?? {};
  if (Object.keys(schema).length === 0) {
    return { route: 'tool_output', items: [], routeError: 'payer provided no schema' };
  }
  const obj = (typeof parsed === 'object' && parsed !== null) ? parsed as Record<string, unknown> : {};

  // 3. FIELDS_PRESENT
  const missing: string[] = [];
  for (const [field, spec] of Object.entries(schema)) {
    if (!spec.required) continue;
    const v = obj[field];
    if (v === undefined || v === null || v === '') missing.push(field);
  }
  items.push(evItem('fields_present', 'Fields Present', missing.length === 0,
    missing.length === 0 ? 'all required fields present' : `missing: ${missing.join(', ')}`));

  // 4. SCHEMA_MATCH (type check)
  const mismatches: string[] = [];
  for (const [field, spec] of Object.entries(schema)) {
    if (!(field in obj)) continue;
    const val = obj[field];
    const actual = Array.isArray(val) ? 'array' : typeof val;
    if (actual !== spec.type) mismatches.push(`${field}: expected ${spec.type}, got ${actual}`);
  }
  items.push(evItem('schema_match', 'Schema Match', mismatches.length === 0,
    mismatches.length === 0 ? 'types match' : mismatches.join('; ')));

  // 5. VALUE_BOUNDS (min/max/enum)
  const violations: string[] = [];
  for (const [field, spec] of Object.entries(schema)) {
    const val = obj[field];
    if (spec.type === 'number' && typeof val === 'number') {
      if (spec.min !== undefined && val < spec.min) violations.push(`${field}: ${val} < ${spec.min}`);
      if (spec.max !== undefined && val > spec.max) violations.push(`${field}: ${val} > ${spec.max}`);
    }
    if (spec.enum && typeof val === 'string' && !spec.enum.includes(val)) violations.push(`${field}: "${val}" not in enum`);
  }
  items.push(evItem('value_bounds', 'Value Bounds', violations.length === 0,
    violations.length === 0 ? 'within bounds' : violations.join('; ')));

  // 6. NO_EXTRA_FIELDS (strict)
  const extras = Object.keys(obj).filter((k) => !(k in schema));
  items.push(evItem('no_extra_fields', 'No Extra Fields', extras.length === 0,
    extras.length === 0 ? 'no undeclared fields' : `unexpected field(s): ${extras.join(', ')}`));

  // 7. FORMAT_MATCH (E1: format + pattern, only when any field declares one)
  const fmtFields = Object.entries(schema).filter(([, s]) => s.format || s.pattern);
  if (fmtFields.length > 0) {
    const fmtViolations: string[] = [];
    for (const [field, spec] of fmtFields) {
      const v = fieldViolation(spec, obj[field]);
      if (v) fmtViolations.push(`${field}: ${v}`);
    }
    items.push(evItem('format_match', 'Format Match', fmtViolations.length === 0,
      fmtViolations.length === 0 ? 'formats/patterns valid' : fmtViolations.join('; ')));
  }

  return { route: 'tool_output', items };
}
