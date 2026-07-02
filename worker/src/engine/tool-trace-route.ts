import type { Acceptance, Artifact, EvidenceBundle, EvidenceItem, EvidenceStatus } from '../types.js';
import { validateAgainst } from '../lib/json-schema.js';

// tool_trace route — verify that a seller's self-reported tool-call trace CONFORMS to a declared tool
// schema (reuses the shared ajv). HONEST BOUNDARY, surfaced as an evidence item: this proves the
// trace's SHAPE, not that the tool actually ran. Pair with the execution route for on-chain ground
// truth. Determinism: pure function of (schema, payload) — same inputs, same bundle.

function ev(id: string, label: string, status: EvidenceStatus, detail: string): EvidenceItem {
  return { id: `trace:${id}`, kind: 'schema_check', label, status, detail };
}

export function runToolTraceRoute(acceptance: Acceptance, artifact: Artifact): EvidenceBundle {
  const crit = acceptance.toolTrace;
  if (!crit || !crit.jsonSchema || Object.keys(crit.jsonSchema).length === 0) {
    return { route: 'tool_trace', items: [], routeError: 'payer provided no tool schema' };
  }

  // Honest scope disclosure, surfaced as an 'info' item (never a fail). It states what this route
  // DOES attest — structural conformance to the declared schema — framed neutrally so it discloses
  // scope without reading as doubt about THIS delivery (which would wrongly push the reasoner to
  // abstain on a genuinely conforming trace). Execution-level ground truth is the execution route.
  const items: EvidenceItem[] = [ev(
    'scope', 'Route Scope', 'info',
    'structural conformance check: the acceptance criterion for this route is that the tool-call trace matches the declared schema. Execution-level verification (that the tool actually ran on-chain) is the separate execution route.',
  )];

  // 1. VALID_JSON — a non-JSON trace is malformed → fail (refund), never a pass.
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.payload);
  } catch {
    items.push(ev('valid_json', 'Valid JSON', 'fail', 'artifact is not valid JSON'));
    return { route: 'tool_trace', items };
  }
  items.push(ev('valid_json', 'Valid JSON', 'pass', 'parsed'));

  // 2. CONFORMANCE
  if (crit.perCall) {
    // The schema describes ONE tool call; the trace must be a non-empty array of conforming calls.
    if (!Array.isArray(parsed)) {
      items.push(ev('is_array', 'Trace Is Array', 'fail', `perCall schema expects an array of calls, got ${typeof parsed}`));
      return { route: 'tool_trace', items };
    }
    items.push(ev('is_array', 'Trace Is Array', parsed.length > 0 ? 'pass' : 'fail', `${parsed.length} call(s)`));
    if (parsed.length === 0) return { route: 'tool_trace', items };

    const bad: string[] = [];
    parsed.forEach((call, i) => {
      const r = validateAgainst(crit.jsonSchema, call);
      if (!r.ok) bad.push(`[${i}] ${r.errors}`);
    });
    items.push(ev('conforms', 'Schema Conformance', bad.length === 0 ? 'pass' : 'fail',
      bad.length === 0 ? `all ${parsed.length} call(s) conform to the declared tool schema` : bad.join(' | ').slice(0, 400)));
  } else {
    const r = validateAgainst(crit.jsonSchema, parsed);
    items.push(ev('conforms', 'Schema Conformance', r.ok ? 'pass' : 'fail',
      r.ok ? 'trace conforms to the declared tool schema' : r.errors.slice(0, 400)));
  }

  return { route: 'tool_trace', items };
}
