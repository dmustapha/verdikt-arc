// WS12 — Verdikt's ACP evaluation brain. Judges a Virtuals ACP deliverable by calling Verdikt's live
// verdict engine (/api/evaluate) and maps the verdict onto ACP's session.complete()/reject(). This module
// is transport-agnostic — the ACP session is an interface — so the decision is unit-testable against a mock
// while the real AcpJobSession is wired in acp-client.ts.
//
// ROUTE-FLEXIBLE (Phase 0.5): the buyer's requirement carries a `route` + `acceptance` object, and Verdikt
// judges whatever route the job actually asked for. The worker /api/evaluate already handles all five routes
// (code, tool_output, answer, execution, tool_trace) — this adapter simply forwards them, so each route can
// settle a REAL ACP job. `tool_output` (JSON-Schema validation) remains the default path that produced the
// existing live jobs; other routes are additive.

const WORKER = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';

export type VerdictRoute = 'code' | 'tool_output' | 'answer' | 'execution' | 'tool_trace';

export interface EvalResult {
  approve: boolean;      // did the deliverable meet acceptance? (drives complete vs reject)
  verdict: string;       // pass | fail | partial | abstain (Verdikt's raw verdict)
  reason: string;        // the rationale Verdikt cited — attached to the ACP settlement note
  evidenceHash: string;  // keccak256 anchor of the evidence bundle
}

// Judge a deliverable against ANY verdict route via Verdikt's engine. `acceptance` is the route's acceptance
// object exactly as /api/evaluate expects it (e.g. {jsonSchema}, {tests}, {sources}, {execution}, {toolTrace}).
// `artifactExtra` merges into the artifact for routes that need more than a payload (e.g. code needs {language}).
// No Arc settlement — ACP settles on its own rails; Verdikt only renders the verdict.
export async function judge(
  deliverable: string,
  route: VerdictRoute,
  acceptance: Record<string, unknown>,
  artifactExtra: Record<string, unknown> = {},
): Promise<EvalResult> {
  const res = await fetch(`${WORKER}/api/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ route, acceptance, artifact: { ...artifactExtra, payload: deliverable } }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`/api/evaluate ${res.status}: ${(d as { error?: string }).error ?? 'error'}`);
  const r = d as { approve?: boolean; verdict?: string; rationale?: string; evidenceHash?: string };
  return { approve: !!r.approve, verdict: r.verdict ?? 'abstain', reason: r.rationale ?? '', evidenceHash: r.evidenceHash ?? '' };
}

// Legacy convenience: judge a structured-data deliverable against a JSON Schema (the tool_output route).
export async function judgeStructured(deliverable: string, jsonSchema: Record<string, unknown>): Promise<EvalResult> {
  return judge(deliverable, 'tool_output', { jsonSchema });
}

// The minimal ACP session surface the evaluator drives (the real AcpJobSession implements both).
export interface EvalSession {
  complete(reason: string): Promise<void>;
  reject(reason: string): Promise<void>;
}

export interface EvalJob {
  deliverable: string | null;                 // the provider's submitted deliverable (string)
  // Route-flexible form (preferred): the route + its acceptance object off the job requirement.
  route?: VerdictRoute;
  acceptance?: Record<string, unknown>;
  artifactExtra?: Record<string, unknown>;    // extra artifact fields (e.g. {language} for code)
  // Legacy tool_output form (still accepted): a bare JSON Schema.
  jsonSchema?: Record<string, unknown>;
}

// Resolve an EvalJob into the concrete (route, acceptance, artifactExtra) triple. New callers pass
// route+acceptance directly; legacy callers pass only jsonSchema → treated as the tool_output route.
function resolveRoute(job: EvalJob): { route: VerdictRoute; acceptance: Record<string, unknown>; artifactExtra: Record<string, unknown> } {
  if (job.route && job.acceptance) {
    return { route: job.route, acceptance: job.acceptance, artifactExtra: job.artifactExtra ?? {} };
  }
  if (job.jsonSchema) {
    return { route: 'tool_output', acceptance: { jsonSchema: job.jsonSchema }, artifactExtra: {} };
  }
  throw new Error('EvalJob has no acceptance criteria (need route+acceptance or jsonSchema)');
}

// THE decision point for a `job.submitted` event: judge the deliverable, then settle the ACP job.
// A missing deliverable is a straight reject. Otherwise Verdikt's verdict decides complete vs reject,
// and its rationale rides in the ACP settlement note so the outcome is explainable on-chain.
export async function evaluateSubmitted(job: EvalJob, session: EvalSession): Promise<EvalResult> {
  if (!job.deliverable || !job.deliverable.trim()) {
    await session.reject('Verdikt: no deliverable was submitted.');
    return { approve: false, verdict: 'abstain', reason: 'no deliverable', evidenceHash: '' };
  }
  const { route, acceptance, artifactExtra } = resolveRoute(job);
  const r = await judge(job.deliverable, route, acceptance, artifactExtra);
  const note = `[Verdikt verdict: ${r.verdict}] ${r.reason}`.slice(0, 500);
  if (r.approve) await session.complete(note);
  else await session.reject(note);
  return r;
}
