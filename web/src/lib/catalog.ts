// WS7 human catalog config — maps a registered seller's `capability` to the task the human fills in:
// the machine-checkable acceptance shape the verdict engine judges against, plus a small set of
// labelled fields (so the human supplies only their input) and a prefilled PASS example. The
// governing criterion (acceptanceTemplate.spec) comes from the live registry; this only decides HOW
// the human's input becomes an Acceptance object for POST /api/tasks.

export type ArtifactType = 'answer' | 'tool_output' | 'code';

export interface CatalogField { key: string; label: string; hint: string; rows: number; mono: boolean }

export interface CapabilityConfig {
  type: ArtifactType;
  fields: CatalogField[];
  // Turn the filled fields into the Acceptance object the worker + verdict engine consume.
  buildAcceptance: (v: Record<string, string>) => { ok: true; acceptance: Record<string, unknown> } | { ok: false; error: string };
  example: Record<string, string>;
  reliable: boolean; // false = needs the code sandbox (heavier); we lead with reliable ones
}

export const CAPABILITY_CONFIG: Record<string, CapabilityConfig> = {
  'grounded-research': {
    type: 'answer',
    reliable: true,
    fields: [
      { key: 'question', label: 'Your question', hint: 'What you want answered.', rows: 3, mono: false },
      { key: 'sources', label: 'Sources (the ground truth)', hint: 'The answer must be supported by these — nothing outside them.', rows: 8, mono: false },
    ],
    buildAcceptance: (v) => {
      if (!v.question?.trim()) return { ok: false, error: 'Add a question.' };
      if (!v.sources?.trim()) return { ok: false, error: 'Add sources — no sources, no verdict.' };
      return { ok: true, acceptance: { spec: v.question.trim(), sources: v.sources.trim() } };
    },
    example: {
      question: 'What is Arc’s approximate block time, and how many decimals does USDC use on Arc?',
      sources: 'Arc is an EVM-compatible testnet. Its block time is approximately 0.48 seconds. USDC on Arc is exposed at a predeploy address with 6 decimals.',
    },
  },
  'schema-extraction': {
    type: 'tool_output',
    reliable: true,
    fields: [
      { key: 'input', label: 'Input data', hint: 'The text/data to extract structured JSON from.', rows: 4, mono: false },
      { key: 'schema', label: 'Target JSON schema (field map)', hint: 'Valid JSON. The output is validated against this — a broken field refunds.', rows: 8, mono: true },
    ],
    buildAcceptance: (v) => {
      if (!v.input?.trim()) return { ok: false, error: 'Add the input data.' };
      let schema: unknown;
      try { schema = JSON.parse(v.schema); } catch { return { ok: false, error: 'Schema must be valid JSON.' }; }
      return { ok: true, acceptance: { spec: v.input.trim(), schema } };
    },
    example: {
      input: 'ETH is trading at $3,421.55 with 92% model confidence.',
      schema: '{\n  "symbol":     { "type": "string", "required": true },\n  "price":      { "type": "number", "required": true, "min": 0 },\n  "confidence": { "type": "number", "required": true, "min": 0, "max": 1 }\n}',
    },
  },
  'code-fix': {
    type: 'code',
    reliable: false, // runs in a network-isolated sandbox on the worker — heavier than the others
    fields: [
      { key: 'description', label: 'What the function should do', hint: 'A short description for the agent.', rows: 3, mono: false },
      { key: 'tests', label: 'Failing pytest (imports `solution`)', hint: 'No tests, no verdict — your tests define "good".', rows: 8, mono: true },
    ],
    buildAcceptance: (v) => {
      if (!v.description?.trim()) return { ok: false, error: 'Add a description.' };
      if (!v.tests?.trim()) return { ok: false, error: 'Add acceptance tests.' };
      return { ok: true, acceptance: { spec: v.description.trim(), tests: v.tests } };
    },
    example: {
      description: 'Implement add(a, b) that returns the sum of two numbers.',
      tests: 'from solution import add\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_add_negative():\n    assert add(-1, 1) == 0\n',
    },
  },
};

// Friendly display names per capability (fallback to the raw label).
export const CAPABILITY_NAME: Record<string, string> = {
  'grounded-research': 'Research & Summary',
  'schema-extraction': 'Data Transform',
  'code-fix': 'Code / PR',
};
