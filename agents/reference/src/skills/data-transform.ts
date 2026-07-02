import type { SellerSkill } from '../lib/seller.js';
import type { Brain } from '../lib/brain.js';
import { stripFences } from '../lib/text.js';

// Reference seller #2 — Data Transform. Input: some raw text/data (in the task spec) + a target JSON
// schema. Output: structured JSON that validates against that schema (the `tool_output` route, verified
// by the worker's ajv schema check). Honesty is enforced downstream: a payload that does not validate
// against the payer's schema fails the verdict — the agent cannot get paid for malformed output. The
// system prompt forbids inventing fields not supported by the input.

const SYSTEM = [
  'You are a precise data-transformation agent. Convert the input into a SINGLE JSON object that',
  'validates against the target JSON schema the user provides. Output ONLY the raw JSON — no prose, no',
  'explanation, no markdown code fences. Include exactly the fields the schema requires; do not invent',
  'values that the input does not support (use null or omit optional fields instead of guessing).',
].join(' ');

export function dataTransformSkill(brain: Brain): SellerSkill {
  return {
    id: 'data-transform',
    name: 'Data Transform',
    description: 'Turns raw input into structured JSON matching a target schema',
    route: 'tool_output',
    tags: ['data', 'json', 'schema', 'extraction'],
    capability: 'schema-extraction',
    acceptanceTemplate: {
      spec: 'Transform the input into a JSON object that validates against the target schema.',
      inputLabel: 'The input text/data + the target JSON schema fields',
    },
    async doWork(brief) {
      const schema = brief.jsonSchema ?? brief.schema ?? {};
      const answer = await brain.say(
        SYSTEM,
        `Target JSON schema:\n${JSON.stringify(schema, null, 2)}\n\nTask + input:\n${brief.spec}\n\nOutput the JSON object now.`,
      );
      return { type: 'tool_output', payload: stripFences(answer) };
    },
  };
}
