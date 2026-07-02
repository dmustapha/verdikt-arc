import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// One shared, format-aware ajv (JSON Schema draft 2020-12). strict:false + allErrors matches the
// long-proven tool_output (schema) route behavior. Shared by the schema and tool_trace routes so
// there is a SINGLE ajv config in the worker (no drift between two hand-configured instances).
export const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));

export interface SchemaValidation { ok: boolean; errors: string }

// Validate a value against a JSON Schema. Compile errors (a malformed payer schema) are returned as
// ok:false with the reason — callers decide whether that is a fail (bad delivery) or a routeError
// (bad criteria). Error strings carry instancePath for legibility.
export function validateAgainst(schema: object, value: unknown): SchemaValidation {
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (e) {
    return { ok: false, errors: `invalid schema: ${e instanceof Error ? e.message : String(e)}` };
  }
  const ok = validate(value);
  const errors = (validate.errors ?? []).map((er) => `${er.instancePath || '/'} ${er.message}`).join('; ');
  return { ok: !!ok, errors };
}
