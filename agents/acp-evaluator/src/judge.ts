// WS12 — Verdikt's ACP evaluation brain. Judges a Virtuals ACP deliverable by calling Verdikt's live
// verdict engine (/api/evaluate) and maps the verdict onto ACP's session.complete()/reject(). The chosen
// concrete service is STRUCTURED DATA: the buyer's requirement carries a JSON Schema, the provider
// delivers JSON, and Verdikt validates it deterministically (the tool_output route). This module is
// transport-agnostic — the ACP session is an interface — so the decision is unit-testable against a mock
// while the real AcpJobSession is wired in acp-client.ts.

const WORKER = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';

export interface EvalResult {
  approve: boolean;      // did the deliverable meet acceptance? (drives complete vs reject)
  verdict: string;       // pass | fail | partial | abstain (Verdikt's raw verdict)
  reason: string;        // the rationale Verdikt cited — attached to the ACP settlement note
  evidenceHash: string;  // keccak256 anchor of the evidence bundle
}

// Judge a structured-data deliverable against a JSON Schema via Verdikt's verdict engine. No Arc
// settlement — ACP settles on its own rails; Verdikt only renders the verdict.
export async function judgeStructured(deliverable: string, jsonSchema: Record<string, unknown>): Promise<EvalResult> {
  const res = await fetch(`${WORKER}/api/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ route: 'tool_output', acceptance: { jsonSchema }, artifact: { payload: deliverable } }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`/api/evaluate ${res.status}: ${(d as { error?: string }).error ?? 'error'}`);
  const r = d as { approve?: boolean; verdict?: string; rationale?: string; evidenceHash?: string };
  return { approve: !!r.approve, verdict: r.verdict ?? 'abstain', reason: r.rationale ?? '', evidenceHash: r.evidenceHash ?? '' };
}

// The minimal ACP session surface the evaluator drives (the real AcpJobSession implements both).
export interface EvalSession {
  complete(reason: string): Promise<void>;
  reject(reason: string): Promise<void>;
}

export interface EvalJob {
  deliverable: string | null;               // the provider's submitted JSON (string)
  jsonSchema: Record<string, unknown>;      // the acceptance schema (from the job requirement)
}

// THE decision point for a `job.submitted` event: judge the deliverable, then settle the ACP job.
// A missing deliverable is a straight reject. Otherwise Verdikt's verdict decides complete vs reject,
// and its rationale rides in the ACP settlement note so the outcome is explainable on-chain.
export async function evaluateSubmitted(job: EvalJob, session: EvalSession): Promise<EvalResult> {
  if (!job.deliverable || !job.deliverable.trim()) {
    await session.reject('Verdikt: no deliverable was submitted.');
    return { approve: false, verdict: 'abstain', reason: 'no deliverable', evidenceHash: '' };
  }
  const r = await judgeStructured(job.deliverable, job.jsonSchema);
  const note = `[Verdikt verdict: ${r.verdict}] ${r.reason}`.slice(0, 500);
  if (r.approve) await session.complete(note);
  else await session.reject(note);
  return r;
}
