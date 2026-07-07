// Isolated adapter smoke: force the emit_verdict tool over a CLEAN bundle and confirm the swapped
// provider returns a structured PASS (not null/error). Proves the OpenAI-compatible tool-calling
// translation works before we deploy. Run: LLM_PROVIDER=groq GROQ_API_KEY=... npx tsx src/scripts/smoke-llm.ts
import { callTool } from '../engine/llm.js';

const VERDICT_TOOL = {
  name: 'emit_verdict',
  description: 'Emit a verdict over the evidence bundle. Cite the exact evidence ids you relied on.',
  input_schema: {
    type: 'object' as const,
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail', 'partial', 'abstain'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      cited_evidence: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
      abstain_reason: { type: 'string' },
    },
    required: ['verdict', 'confidence', 'cited_evidence', 'rationale'],
  },
};

const cleanBundle = {
  route: 'tool_output',
  items: [
    { id: 'schema:fields_present', kind: 'schema_check', label: 'Fields Present', status: 'pass', detail: 'all required fields present' },
    { id: 'schema:schema_match', kind: 'schema_check', label: 'Schema Match', status: 'pass', detail: 'types match' },
    { id: 'schema:value_bounds', kind: 'schema_check', label: 'Value Bounds', status: 'pass', detail: 'within bounds' },
  ],
};

const SYSTEM =
  'You are an evidence arbiter that decides whether to release escrowed money for delivered work. ' +
  'Reason ONLY over the provided EvidenceBundle. NEVER pass if any item has status "fail". ' +
  'When all items pass and there is no routeError, pass with high confidence. Cite the evidence ids you used.';

async function main() {
  console.log(`provider=${process.env.LLM_PROVIDER ?? 'anthropic'} model=${process.env.LLM_MODEL ?? '(default)'}`);
  const t0 = Date.now();
  const out = await callTool({
    system: SYSTEM,
    tool: VERDICT_TOOL,
    maxTokens: 1024,
    userContent: `EvidenceBundle:\n${JSON.stringify(cleanBundle, null, 2)}`,
  });
  console.log(`latency=${Date.now() - t0}ms`);
  console.log('structured output:', JSON.stringify(out, null, 2));
  if (!out) { console.error('FAIL: null (no tool call parsed)'); process.exit(1); }
  if (out.verdict !== 'pass') { console.error(`WARN: expected pass on a clean bundle, got ${out.verdict}`); process.exit(2); }
  console.log('OK: clean bundle -> pass. Adapter works.');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
