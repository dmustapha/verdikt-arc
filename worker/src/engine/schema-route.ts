import type { Acceptance, Artifact, EvidenceBundle, EvidenceItem, SchemaField } from '../types.js';

function evItem(id: string, label: string, passed: boolean, detail: string): EvidenceItem {
  return { id: `schema:${id}`, kind: 'schema_check', label, status: passed ? 'pass' : 'fail', detail };
}

export function runSchemaRoute(acceptance: Acceptance, artifact: Artifact): EvidenceBundle {
  const schema = acceptance.schema ?? {};
  const minBytes = acceptance.minResponseBytes ?? 2;
  const body = artifact.payload;

  if (Object.keys(schema).length === 0) {
    return { route: 'tool_output', items: [], routeError: 'payer provided no schema' };
  }

  const items: EvidenceItem[] = [];

  // 1. HAS_BODY
  const size = Buffer.byteLength(body, 'utf8');
  items.push(evItem('has_body', 'Has Body', size >= minBytes, `${size} bytes (min ${minBytes})`));

  // 2. VALID_JSON
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(body); items.push(evItem('valid_json', 'Valid JSON', true, 'parsed')); }
  catch { items.push(evItem('valid_json', 'Valid JSON', false, 'invalid JSON')); }

  if (parsed) {
    // 3. FIELDS_PRESENT
    const missing: string[] = [];
    for (const [field, spec] of Object.entries(schema)) {
      if (!spec.required) continue;
      const v = parsed[field];
      if (v === undefined || v === null || v === '') missing.push(field);
    }
    items.push(evItem('fields_present', 'Fields Present', missing.length === 0,
      missing.length === 0 ? 'all required fields present' : `missing: ${missing.join(', ')}`));

    // 4. SCHEMA_MATCH (type check)
    const mismatches: string[] = [];
    for (const [field, spec] of Object.entries(schema)) {
      if (!(field in parsed)) continue;
      const val = parsed[field];
      const actual = Array.isArray(val) ? 'array' : typeof val;
      if (actual !== (spec as SchemaField).type) mismatches.push(`${field}: expected ${spec.type}, got ${actual}`);
    }
    items.push(evItem('schema_match', 'Schema Match', mismatches.length === 0,
      mismatches.length === 0 ? 'types match' : mismatches.join('; ')));

    // 5. VALUE_BOUNDS (min/max/enum)
    const violations: string[] = [];
    for (const [field, spec] of Object.entries(schema)) {
      const s = spec as SchemaField;
      const val = parsed[field];
      if (s.type === 'number' && typeof val === 'number') {
        if (s.min !== undefined && val < s.min) violations.push(`${field}: ${val} < ${s.min}`);
        if (s.max !== undefined && val > s.max) violations.push(`${field}: ${val} > ${s.max}`);
      }
      if (s.enum && typeof val === 'string' && !s.enum.includes(val)) violations.push(`${field}: "${val}" not in enum`);
    }
    items.push(evItem('value_bounds', 'Value Bounds', violations.length === 0,
      violations.length === 0 ? 'within bounds' : violations.join('; ')));
  }

  return { route: 'tool_output', items };
}
