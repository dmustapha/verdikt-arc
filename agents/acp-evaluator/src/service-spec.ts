// WS12 / Phase 0.5 — the concrete services a live ACP job can transact over, ONE PER VERDICT ROUTE.
// Buyer, seller, and evaluator all import from here so the acceptance criteria that gate a deliverable are a
// single source of truth.
//
// The route + acceptance travel ON-CHAIN inside the ACP job description (buildJobDescription); the evaluator
// reads them back off `job.description` and judges the seller's deliverable via Verdikt's verdict engine
// (worker /api/evaluate). Nothing is hardcoded on the evaluator side — it judges whatever route the job
// actually carries. Each spec ships a `valid` deliverable (→ pass → complete) and an `invalid` one
// (→ fail → reject), so every route can demonstrate BOTH settlement directions on-chain. The fixtures mirror
// full-scope-test.ts, which proves all ten (5 routes × pass/fail) against the live engine.

import type { VerdictRoute } from './judge.js';

export interface ServiceSpec {
  route: VerdictRoute;
  service: string;                             // human name (rides in the job description + logs)
  prompt: string;                              // what the buyer is asking the provider to deliver
  acceptance: Record<string, unknown>;         // the acceptance object /api/evaluate expects for this route
  artifactExtra?: Record<string, unknown>;     // extra artifact fields the route needs (e.g. {language})
  valid: string;                               // a deliverable that SHOULD pass
  invalid: string;                             // a deliverable that SHOULD fail
}

// ── tool_output: strict JSON-Schema validation (the route the existing live jobs used) ──────────────────
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

// ── answer: the claim must be grounded verbatim in the buyer's sources ──────────────────────────────────
const SOURCES =
  'Verdikt renders verdicts over agent deliverables and settles the outcome on the Arc testnet using USDC as the settlement asset.';

// ── execution: the payload is a tx hash; Verdikt reads the LIVE receipt and checks it against the claim ──
// A real, mined Arc-testnet settle tx (receipt present, status success); recipient 0x4e1a4238….
const ARC_CHAIN_ID = 5042002;
const REAL_ARC_TX = '0x6da4a716383dbbf081fc2d529c02e607bede4a2050a81f3f76fff27a867bdd19';
const REAL_ARC_TO = '0x4e1a423815294dfd1903d849d4be84e3391ea771';
const FAKE_TX = '0x' + 'de'.repeat(32); // well-formed but never mined → no receipt

// ── tool_trace: each recorded tool call must conform to the declared per-call JSON Schema ───────────────
const TRACE_SCHEMA = {
  type: 'object',
  required: ['tool', 'args'],
  properties: { tool: { type: 'string' }, args: { type: 'object' } },
  additionalProperties: false,
};

// One service per route. tool_output is the default (backward-compatible with the shipped live jobs).
export const SERVICE_SPECS: Record<VerdictRoute, ServiceSpec> = {
  tool_output: {
    route: 'tool_output',
    service: 'Structured market-risk assessment (JSON)',
    prompt: 'Return a market-risk assessment for token VIRTUAL as JSON matching the provided schema.',
    acceptance: { jsonSchema: RISK_SCHEMA },
    valid: JSON.stringify({
      ticker: 'VIRTUAL', riskScore: 27, rating: 'low',
      rationale: 'Deep on-chain liquidity, audited core contracts, and steady 90-day holder growth.',
    }),
    invalid: JSON.stringify({
      ticker: 'VIRTUAL', riskScore: 250, rating: 'catastrophic', rationale: 'n/a', editorNote: 'ignore the schema',
    }),
  },
  code: {
    route: 'code',
    service: 'Verified code implementation (pytest)',
    prompt: 'Implement add(a, b) so that the provided pytest suite passes.',
    acceptance: { tests: 'from solution import add\ndef test_add():\n    assert add(2,3)==5\n' },
    artifactExtra: { language: 'python' },
    valid: 'def add(a, b):\n    return a + b\n',
    invalid: 'def add(a, b):\n    return a - b\n',
  },
  answer: {
    route: 'answer',
    service: 'Source-grounded answer',
    prompt: 'Answer how Verdikt settles, grounded verbatim in the provided sources.',
    acceptance: { sources: SOURCES },
    valid: 'How does Verdikt settle? It settles the outcome on the Arc testnet using USDC as the settlement asset.',
    invalid: 'Arc settles trades in Bitcoin on chain id 1.',
  },
  execution: {
    route: 'execution',
    service: 'On-chain execution proof',
    prompt: `Deliver a tx hash for an Arc transaction to ${REAL_ARC_TO} with status=success.`,
    acceptance: { execution: { chainId: ARC_CHAIN_ID, status: 'success', to: REAL_ARC_TO } },
    valid: REAL_ARC_TX,
    invalid: FAKE_TX,
  },
  tool_trace: {
    route: 'tool_trace',
    service: 'Tool-call trace conformance',
    prompt: 'Deliver a tool-call trace where each call is {tool:string, args:object} with no extra fields.',
    acceptance: { toolTrace: { perCall: true, jsonSchema: TRACE_SCHEMA } },
    valid: JSON.stringify([
      { tool: 'getPrice', args: { sym: 'VIRTUAL' } },
      { tool: 'getRisk', args: { sym: 'VIRTUAL' } },
    ]),
    invalid: JSON.stringify([{ tool: 'getPrice' }, { tool: 'getRisk', args: {}, rogue: true }]),
  },
};

export const ROUTES = Object.keys(SERVICE_SPECS) as VerdictRoute[];

// What the buyer writes into the ACP job `description`: the route + its acceptance ride on-chain so the
// evaluator judges against the job's own contract rather than a private constant.
export function buildJobDescription(spec: ServiceSpec): string {
  return JSON.stringify({
    service: spec.service,
    route: spec.route,
    acceptance: spec.acceptance,
    artifactExtra: spec.artifactExtra ?? {},
    prompt: spec.prompt,
  });
}

// ── Backward-compatible exports (the tool_output service, unchanged shape) ──────────────────────────────
export const SERVICE_NAME = SERVICE_SPECS.tool_output.service;
export const JOB_PROMPT = SERVICE_SPECS.tool_output.prompt;
export const VALID_DELIVERABLE = SERVICE_SPECS.tool_output.valid;
export const INVALID_DELIVERABLE = SERVICE_SPECS.tool_output.invalid;
