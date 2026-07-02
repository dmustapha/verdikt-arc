import { Router } from 'express';
import { insertTask, getTask, recordFunded } from '../lib/db.js';
import { runVerdict } from '../engine/orchestrator.js';
import { fundEscrow } from '../settlement/fund-escrow.js';
import { sseBus } from '../lib/sse-bus.js';
import { createRateLimiter, clientIp } from '../lib/rate-limit.js';
import type { Artifact, Acceptance, ArtifactType, ExecutionCriteria, ToolTraceCriteria } from '../types.js';

export const tryRouter = Router();

// PUBLIC "Try it" rail. A stranger supplies their OWN task + artifact and gets a REAL Arc
// settlement, funded by the demo payer wallet (env-fixed). Three guardrails keep it honest and
// the wallet safe:
//  1. SCOPE — only the three verifiable routes are accepted; each REQUIRES its payer ground
//     truth (code→tests, tool_output→schema, answer→sources) or we 400 before spending a cent.
//     Anything still unverifiable abstains+refunds at runtime (never a false release).
//  2. MONEY — worker/payer addresses + keys are env-fixed (never client-supplied, M-2), and the
//     escrow amount is clamped to TRY_MAX_USDC. The most a caller can spend is gas, never a payout.
//  3. ABUSE — per-IP + global daily rate limits + per-field size caps.

const TRY_MAX_USDC = Number(process.env.TRY_MAX_USDC ?? 0.1);
const MAX_FIELD_BYTES = Number(process.env.TRY_MAX_FIELD_BYTES ?? 20_000);
const PER_IP_LIMIT = Number(process.env.TRY_PER_IP ?? 3);
const PER_IP_WINDOW_MS = Number(process.env.TRY_IP_WINDOW_MS ?? 10 * 60 * 1000);
const GLOBAL_DAY_LIMIT = Number(process.env.TRY_GLOBAL_DAY ?? 60);

const inFlight = new Set<string>();
const rateLimit = createRateLimiter({ perIp: PER_IP_LIMIT, ipWindowMs: PER_IP_WINDOW_MS, globalPerDay: GLOBAL_DAY_LIMIT });

function bytes(s: unknown): number {
  return typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : 0;
}

const SPEC: Record<ArtifactType, string> = {
  code: 'passes the payer tests with no security finding',
  tool_output: 'matches the payer JSON contract',
  answer: 'answer grounded in the payer sources',
  execution: 'the claimed on-chain transaction satisfies the payer criteria',
  tool_trace: 'the claimed tool-call trace conforms to the declared tool schema',
};

// Build a validated Acceptance + Artifact for the chosen route, or return an error string.
// This is the SCOPE gate: a route with no ground truth cannot be judged, so we reject it here
// rather than funding an escrow that can only abstain.
export function buildTask(route: ArtifactType, body: Record<string, unknown>): { acceptance: Acceptance; artifact: Artifact } | string {
  const accIn = (body.acceptance ?? {}) as Record<string, unknown>;
  const artIn = (body.artifact ?? {}) as Record<string, unknown>;
  const payload = artIn.payload;
  if (typeof payload !== 'string' || payload.trim() === '') return 'artifact.payload is required';
  if (bytes(payload) > MAX_FIELD_BYTES) return `artifact.payload exceeds ${MAX_FIELD_BYTES} bytes`;

  if (route === 'code') {
    const tests = accIn.tests;
    if (typeof tests !== 'string' || tests.trim() === '') return 'code route requires acceptance.tests (your pytest file) — no tests, no verdict';
    if (bytes(tests) > MAX_FIELD_BYTES) return `acceptance.tests exceeds ${MAX_FIELD_BYTES} bytes`;
    const language = artIn.language === 'typescript' ? 'typescript' : 'python';
    return { acceptance: { spec: SPEC.code, tests }, artifact: { type: 'code', language, payload } };
  }

  if (route === 'tool_output') {
    const schema = accIn.schema as Record<string, unknown> | undefined;
    const jsonSchema = accIn.jsonSchema as Record<string, unknown> | undefined;
    const hasSchema = schema && typeof schema === 'object' && Object.keys(schema).length > 0;
    const hasJsonSchema = jsonSchema && typeof jsonSchema === 'object' && Object.keys(jsonSchema).length > 0;
    if (!hasSchema && !hasJsonSchema) return 'tool_output route requires acceptance.schema or acceptance.jsonSchema — no contract, no verdict';
    if (bytes(JSON.stringify(schema ?? jsonSchema)) > MAX_FIELD_BYTES) return `acceptance schema exceeds ${MAX_FIELD_BYTES} bytes`;
    const minResponseBytes = typeof accIn.minResponseBytes === 'number' ? accIn.minResponseBytes : undefined;
    const acceptance: Acceptance = { spec: SPEC.tool_output, minResponseBytes };
    if (hasSchema) acceptance.schema = schema as Acceptance['schema'];
    if (hasJsonSchema) acceptance.jsonSchema = jsonSchema as Acceptance['jsonSchema'];
    return { acceptance, artifact: { type: 'tool_output', payload } };
  }

  if (route === 'execution') {
    const exec = accIn.execution as Record<string, unknown> | undefined;
    if (!exec || typeof exec !== 'object' || typeof exec.chainId !== 'number') {
      return 'execution route requires acceptance.execution.chainId (the chain to read) — no chain, no verdict';
    }
    if (bytes(JSON.stringify(exec)) > MAX_FIELD_BYTES) return `acceptance.execution exceeds ${MAX_FIELD_BYTES} bytes`;
    // payload is the claimed tx hash; the execution route validates its format + reads the receipt.
    return { acceptance: { spec: SPEC.execution, execution: exec as unknown as ExecutionCriteria }, artifact: { type: 'execution', payload } };
  }

  if (route === 'tool_trace') {
    const tt = accIn.toolTrace as Record<string, unknown> | undefined;
    const jsonSchema = tt?.jsonSchema as Record<string, unknown> | undefined;
    if (!tt || typeof tt !== 'object' || !jsonSchema || typeof jsonSchema !== 'object' || Object.keys(jsonSchema).length === 0) {
      return 'tool_trace route requires acceptance.toolTrace.jsonSchema (the declared tool schema) — no schema, no verdict';
    }
    if (bytes(JSON.stringify(tt)) > MAX_FIELD_BYTES) return `acceptance.toolTrace exceeds ${MAX_FIELD_BYTES} bytes`;
    const toolTrace: ToolTraceCriteria = { jsonSchema };
    if (tt.perCall === true) toolTrace.perCall = true;
    return { acceptance: { spec: SPEC.tool_trace, toolTrace }, artifact: { type: 'tool_trace', payload } };
  }

  // answer
  const sources = accIn.sources;
  if (typeof sources !== 'string' || sources.trim() === '') return 'answer route requires acceptance.sources (the text claims must be grounded in) — no sources, no verdict';
  if (bytes(sources) > MAX_FIELD_BYTES) return `acceptance.sources exceeds ${MAX_FIELD_BYTES} bytes`;
  return { acceptance: { spec: SPEC.answer, sources }, artifact: { type: 'answer', payload } };
}

const VALID_WORKID = /^0x[0-9a-fA-F]{64}$/;
const ROUTES: ArtifactType[] = ['code', 'tool_output', 'answer', 'execution', 'tool_trace'];

// POST /api/try  body: { workId, route, acceptance, artifact }
tryRouter.post('/api/try', async (req, res) => {
  if (!process.env.DEMO_PAYER_KEY || !process.env.DEMO_WORKER_ADDRESS || !process.env.DEMO_PAYER_ADDRESS) {
    res.status(503).json({ error: 'try-it disabled: demo wallet not configured' }); return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const route = body.route as ArtifactType;
  if (!ROUTES.includes(route)) { res.status(400).json({ error: `route must be one of: ${ROUTES.join(', ')}` }); return; }

  const workId = body.workId as `0x${string}`;
  if (!workId || !VALID_WORKID.test(workId)) { res.status(400).json({ error: 'workId required (0x + 64 hex)' }); return; }

  const built = buildTask(route, body);
  if (typeof built === 'string') { res.status(400).json({ error: built }); return; }

  const now = Date.now();
  const limited = rateLimit(clientIp(req), now);
  if (limited) { res.status(429).json({ error: limited }); return; }

  if (inFlight.has(workId)) { res.status(409).json({ error: 'workId already in flight' }); return; }

  // Money is env-fixed; the caller never picks who gets paid or how much (M-2).
  const worker = process.env.DEMO_WORKER_ADDRESS as `0x${string}`;
  const payer = process.env.DEMO_PAYER_ADDRESS as `0x${string}`;
  const amountUsdc = TRY_MAX_USDC;

  let task = await getTask(workId);
  if (!task) {
    task = { workId, type: route, acceptance: built.acceptance, payer, worker, amountUsdc };
    await insertTask(task);
  }
  const t = task;

  // ACK 202 so the client's already-open SSE renders the run live (same pattern as /api/demo).
  inFlight.add(workId);
  res.status(202).json({ workId, accepted: true });

  void (async () => {
    try {
      const fundTx = await fundEscrow({ payerKey: process.env.DEMO_PAYER_KEY as `0x${string}`, workId, worker: t.worker, amountUsdc: t.amountUsdc });
      await recordFunded(workId, fundTx);
      sseBus.publish(workId, 'task_funded', { fundTx, amountUsdc: t.amountUsdc });
      await runVerdict(t, built.artifact);
    } catch (err) {
      sseBus.publish(workId, 'error', { stage: 'funding', message: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.delete(workId);
    }
  })();
});
