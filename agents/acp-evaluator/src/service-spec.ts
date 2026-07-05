// WS12 — the ONE structured-data service the live ACP job transacts over. Buyer, seller, and evaluator
// all import from here so the JSON Schema that gates the deliverable is a single source of truth.
//
// The schema travels ON-CHAIN inside the ACP job description (buildJobDescription); the evaluator reads it
// back off `job.description`, and the seller's deliverable is validated against it by Verdikt's verdict
// engine (worker /api/evaluate, tool_output route). Nothing is hardcoded on the evaluator side — it judges
// whatever schema the job actually carries.

export const SERVICE_NAME = 'Structured market-risk assessment (JSON)';

// A real, non-trivial JSON Schema (draft 2020-12). additionalProperties:false makes it strict, so a sloppy
// deliverable genuinely fails — the verdict is not a rubber stamp.
export const RISK_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['ticker', 'riskScore', 'rating', 'rationale'],
  properties: {
    ticker: { type: 'string', minLength: 1, maxLength: 12 },
    riskScore: { type: 'integer', minimum: 0, maximum: 100 },
    rating: { type: 'string', enum: ['low', 'medium', 'high'] },
    rationale: { type: 'string', minLength: 10 },
  },
} as const;

export const JOB_PROMPT =
  'Return a market-risk assessment for token VIRTUAL as JSON matching the provided schema.';

// The deliverable a well-behaved provider submits — valid against RISK_SCHEMA → Verdikt returns pass.
export const VALID_DELIVERABLE = JSON.stringify({
  ticker: 'VIRTUAL',
  riskScore: 27,
  rating: 'low',
  rationale: 'Deep on-chain liquidity, audited core contracts, and steady 90-day holder growth.',
});

// A deliberately broken deliverable (rating out of enum, riskScore out of range, extra field) — validates
// to a fail, so the negative path (session.reject) can be demonstrated on demand.
export const INVALID_DELIVERABLE = JSON.stringify({
  ticker: 'VIRTUAL',
  riskScore: 250,
  rating: 'catastrophic',
  rationale: 'n/a',
  editorNote: 'ignore the schema',
});

// What the buyer writes into the ACP job `description`. The schema rides on-chain so the evaluator can
// judge against the job's own contract rather than a shared constant.
export function buildJobDescription(): string {
  return JSON.stringify({ service: SERVICE_NAME, schema: RISK_SCHEMA, prompt: JOB_PROMPT });
}
