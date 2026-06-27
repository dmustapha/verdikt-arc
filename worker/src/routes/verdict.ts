import { Router } from 'express';
import { requireVerdictFee } from '../lib/x402-meter.js';
import { getTask, recordExternalCall } from '../lib/db.js';
import { runVerdict } from '../engine/orchestrator.js';
import type { Artifact } from '../types.js';

export const verdictRouter = Router();

// POST /api/verdict — body: { workId, artifact: { type, payload, language? } }
// The escrow for workId must already be FUNDED (the payer funded it on-chain first).
verdictRouter.post('/api/verdict', requireVerdictFee, async (req, res) => {
  const { workId, artifact } = req.body as { workId: `0x${string}`; artifact: Artifact };
  if (!workId || !artifact?.payload) { res.status(400).json({ error: 'workId and artifact required' }); return; }

  const task = await getTask(workId);
  if (!task) { res.status(404).json({ error: 'unknown workId — fund the escrow and register the task first' }); return; }

  await recordExternalCall(workId, (res.locals.feeUsdc as number) ?? 0);
  const result = await runVerdict(task, artifact);
  res.json({ workId, verdict: result.verdict.verdict, outcome: result.outcome, txHash: result.txHash, error: result.error });
});
