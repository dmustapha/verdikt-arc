import { Router } from 'express';
import { evaluateArtifact } from '../engine/orchestrator.js';
import { buildTask } from './try.js';
import { createRateLimiter, clientIp } from '../lib/rate-limit.js';
import type { ArtifactType, Task } from '../types.js';

export const evaluateRouter = Router();

// PUBLIC pure-verdict API (no escrow, no Arc settlement, no DB writes). Verdikt renders a VERDICT over a
// deliverable and returns it — the caller settles on its own rails. This is the seam WS12's ACP evaluator
// uses: a Virtuals ACP job's deliverable is judged here, and the evaluator maps the verdict onto ACP's
// session.complete()/reject(). Same verdict engine as everything else (evaluateArtifact = the pure brain);
// it just skips the record + settle half, so there is no vk_tasks row to satisfy and no money moves.
const ROUTES: ArtifactType[] = ['code', 'tool_output', 'answer', 'execution', 'tool_trace'];
const rateLimit = createRateLimiter({
  perIp: Number(process.env.EVALUATE_PER_IP ?? 30),
  ipWindowMs: 10 * 60 * 1000,
  globalPerDay: Number(process.env.EVALUATE_GLOBAL_DAY ?? 500),
});
// A synthetic, non-persisted workId — evaluateArtifact never records it; routeArtifact only reads
// type + acceptance. Fixed value keeps the pure path deterministic.
const SYNTHETIC: `0x${string}` = `0x${'e5'.repeat(32)}`;
const ZERO_ADDR = `0x${'00'.repeat(20)}` as `0x${string}`;

// pass/partial → approve (the deliverable meets acceptance); fail/abstain → reject (unmet or unverifiable).
function approveFor(verdict: string): boolean {
  return verdict === 'pass' || verdict === 'partial';
}

// POST /api/evaluate  body: { route, acceptance, artifact } — same shape as /api/try minus the money.
evaluateRouter.post('/api/evaluate', async (req, res) => {
  const limited = rateLimit(clientIp(req), Date.now());
  if (limited) { res.status(429).json({ error: limited }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const route = body.route as ArtifactType;
  if (!ROUTES.includes(route)) { res.status(400).json({ error: `route must be one of: ${ROUTES.join(', ')}` }); return; }

  const built = buildTask(route, body); // SCOPE gate: rejects a route with no ground truth (no false verdicts)
  if (typeof built === 'string') { res.status(400).json({ error: built }); return; }

  try {
    const task: Task = { workId: SYNTHETIC, type: route, acceptance: built.acceptance, payer: ZERO_ADDR, worker: ZERO_ADDR, amountUsdc: 0 };
    const { verdict, bundle } = await evaluateArtifact(task, built.artifact);
    res.json({
      verdict: verdict.verdict,                 // pass | fail | partial | abstain
      approve: approveFor(verdict.verdict),     // the binary an ACP evaluator maps onto complete/reject
      confidence: verdict.confidence,
      score: verdict.score,
      rationale: verdict.rationale,
      abstainReason: verdict.abstainReason ?? null,
      evidenceHash: verdict.evidenceHash,
      route: verdict.route,
      evidence: bundle.items,                   // the cited findings, so the caller can attach real reasons
    });
  } catch (err) {
    res.status(502).json({ error: `evaluation failed: ${err instanceof Error ? err.message : String(err)}` });
  }
});
