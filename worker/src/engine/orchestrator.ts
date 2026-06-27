import type { Task, Artifact, VerdictResult, EvidenceBundle } from '../types.js';
import { runCodeRoute } from './code-route.js';
import { runSchemaRoute } from './schema-route.js';
import { runGroundingRoute } from './grounding-route.js';
import { reasonOverEvidence } from './reasoner.js';
import { settleVerdict, outcomeFor } from '../settlement/settle.js';
import { buildReceipt } from '../lib/receipt.js';
import { sseBus } from '../lib/sse-bus.js';
import { recordEvidence, recordVerdict, recordSettled, recordReceipt, recordSettleFailed } from '../lib/db.js';

export interface VerdictRunResult {
  verdict: VerdictResult;
  outcome: string;
  txHash: string | null;
  error?: string;
}

async function routeArtifact(task: Task, artifact: Artifact): Promise<EvidenceBundle> {
  switch (task.type) {
    case 'code': return runCodeRoute(task.acceptance, artifact);
    case 'tool_output': return runSchemaRoute(task.acceptance, artifact);
    case 'answer': return runGroundingRoute(task.acceptance, artifact);
  }
}

export async function runVerdict(task: Task, artifact: Artifact): Promise<VerdictRunResult> {
  const { workId } = task;
  sseBus.publish(workId, 'route_selected', { route: task.type });

  // 1. Evidence
  const bundle = await routeArtifact(task, artifact);
  await recordEvidence(workId, bundle);
  for (const item of bundle.items) sseBus.publish(workId, 'evidence_item', item);

  // 2. Verdict (reason over evidence; deterministic guards inside)
  const verdict = await reasonOverEvidence(bundle);
  await recordVerdict(workId, verdict);
  sseBus.publish(workId, 'verdict', {
    verdict: verdict.verdict, confidence: verdict.confidence,
    citedEvidence: verdict.citedEvidence, abstainReason: verdict.abstainReason,
  });

  // 3. Settle on-chain (release / refund / abstain-default)
  sseBus.publish(workId, 'settling', { outcome: outcomeFor(verdict) });
  try {
    const settlement = await settleVerdict(workId, verdict);
    await recordSettled(workId, settlement.outcome, settlement.txHash);
    sseBus.publish(workId, 'settled', { outcome: settlement.outcome, txHash: settlement.txHash });

    // 4. Receipt
    const receipt = await buildReceipt(settlement, verdict, task.amountUsdc);
    await recordReceipt(workId, receipt);
    sseBus.publish(workId, 'receipt', receipt);

    return { verdict, outcome: settlement.outcome, txHash: settlement.txHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordSettleFailed(workId, msg).catch(() => {}); // keep DB honest; never mask the original error
    sseBus.publish(workId, 'error', { stage: 'settlement', message: msg });
    return { verdict, outcome: outcomeFor(verdict), txHash: null, error: msg };
  }
}
