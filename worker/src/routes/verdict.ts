import { Router } from 'express';
import { recoverMessageAddress, keccak256, toBytes } from 'viem';
import { requireVerdictFee, captureVerdictFee } from '../lib/x402-meter.js';
import { getTask, recordExternalCall, claimForJudging } from '../lib/db.js';
import { runVerdict } from '../engine/orchestrator.js';
import type { Artifact } from '../types.js';

export const verdictRouter = Router();

// The message the worker signs to bind an artifact submission to (worker, work, payload).
// Published so an external worker can reproduce it: `Verdikt:<workId>:<keccak256(payload)>`.
export function artifactMessage(workId: string, payload: string): string {
  return `Verdikt:${workId}:${keccak256(toBytes(payload))}`;
}

// POST /api/verdict — body: { workId, artifact: { type, payload, language?, sig } }
// The escrow for workId must already be FUNDED (the payer funded it on-chain first).
verdictRouter.post('/api/verdict', requireVerdictFee, async (req, res) => {
  const { workId, artifact } = req.body as { workId: `0x${string}`; artifact: Artifact & { sig?: `0x${string}` } };
  if (!workId || !artifact?.payload) { res.status(400).json({ error: 'workId and artifact required' }); return; }

  const task = await getTask(workId);
  if (!task) { res.status(404).json({ error: 'unknown workId — fund the escrow and register the task first' }); return; }

  // H-2: bind the artifact under judgment to the worker who owns the task. Without this, anyone who
  // pays the sub-cent fee could submit a crafted artifact against someone else's funded escrow and
  // flip the outcome. The worker signs `Verdikt:<workId>:<keccak(payload)>`; we recover and require
  // the signer to equal task.worker.
  if (!artifact.sig) { res.status(400).json({ error: 'artifact.sig required (worker signature over workId+payload)' }); return; }
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message: artifactMessage(workId, artifact.payload), signature: artifact.sig });
  } catch {
    res.status(400).json({ error: 'malformed artifact.sig' }); return;
  }
  if (signer.toLowerCase() !== task.worker.toLowerCase()) {
    res.status(403).json({ error: 'artifact signature does not match the task worker' }); return;
  }

  // H-2: single-shot lock — only a FUNDED escrow can transition to 'judging', exactly once. A replay
  // against an already-judged or settled workId returns 409 instead of re-judging.
  const claimed = await claimForJudging(workId);
  if (!claimed) { res.status(409).json({ error: 'escrow not in funded state (already judged or not funded)' }); return; }

  const result = await runVerdict(task, artifact);

  // Auth-and-capture: charge the seller's authorized x402 fee ONLY when we actually rendered a
  // verdict (release/refund) AND it settled on-chain. On `abstain` (we could not verify) or a failed
  // settlement, we DO NOT capture — "if we couldn't verify, we don't take their money." The escrow
  // principal is unaffected (it always refunds the payer on abstain).
  let feeUsdc = 0;
  const rendered = !!result.txHash && (result.outcome === 'release' || result.outcome === 'refund');
  if (rendered) {
    const cap = await captureVerdictFee(res);
    feeUsdc = cap.feeUsdc;
    if (feeUsdc > 0) await recordExternalCall(workId, feeUsdc);
  }

  res.json({ workId, verdict: result.verdict.verdict, outcome: result.outcome, txHash: result.txHash, feeUsdc, error: result.error });
});
