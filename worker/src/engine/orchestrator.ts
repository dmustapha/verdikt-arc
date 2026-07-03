import type { Task, Artifact, VerdictResult, EvidenceBundle } from '../types.js';
import { runCodeRoute } from './code-route.js';
import { runSchemaRoute } from './schema-route.js';
import { runGroundingRoute } from './grounding-route.js';
import { runGroundingV2 } from './grounding-nli.js';
import { runExecutionRoute } from './execution-route.js';
import { runToolTraceRoute } from './tool-trace-route.js';
import { reasonOverEvidence } from './reasoner.js';
import { settleVerdict, outcomeFor } from '../settlement/settle.js';
import { buildReceipt } from '../lib/receipt.js';
import { attestAfterSettle } from '../lib/attestor.js';
import { sseBus } from '../lib/sse-bus.js';
import { recordEvidence, recordVerdict, recordSettled, recordReceipt, recordSettleFailed } from '../lib/db.js';

export interface VerdictRunResult {
  verdict: VerdictResult;
  outcome: string;
  txHash: string | null;
  bps?: number;            // worker's share on a partial settlement (1..9999); undefined otherwise
  error?: string;
}

async function routeArtifact(task: Task, artifact: Artifact): Promise<EvidenceBundle> {
  switch (task.type) {
    case 'code': return runCodeRoute(task.acceptance, artifact);
    case 'tool_output': return runSchemaRoute(task.acceptance, artifact);
    // F1: claim-decomposition + per-claim entailment gate when enabled; the lexical gate is the
    // safe default so the live behavior is unchanged unless GROUNDING_V2 is turned on.
    case 'answer': return process.env.GROUNDING_V2 === 'true'
      ? runGroundingV2(task.acceptance, artifact)
      : runGroundingRoute(task.acceptance, artifact);
    case 'execution': return runExecutionRoute(task.acceptance, artifact);
    case 'tool_trace': return runToolTraceRoute(task.acceptance, artifact);
  }
}

// Steps 1–2 of a verdict: route the artifact into evidence and reason over it into a verdict, recording
// both and streaming the courtroom SSE — WITHOUT settling on-chain. runVerdict (the default path)
// composes this then settles immediately; the WS11 dispute path calls this alone to HOLD a verdict in
// PROPOSED (funds stay FUNDED) so a party can contest it before any money moves. The returned bundle is
// the arbiter's factual basis if the verdict is later disputed.
export async function computeVerdict(task: Task, artifact: Artifact): Promise<{ verdict: VerdictResult; bundle: EvidenceBundle }> {
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

  return { verdict, bundle };
}

export async function runVerdict(task: Task, artifact: Artifact): Promise<VerdictRunResult> {
  const { workId } = task;

  // 1–2. Evidence + verdict (recorded + streamed), no settlement yet.
  const { verdict } = await computeVerdict(task, artifact);

  // 3. Settle on-chain (release / refund / abstain-default)
  sseBus.publish(workId, 'settling', { outcome: outcomeFor(verdict) });
  try {
    const settlement = await settleVerdict(workId, verdict);
    await recordSettled(workId, settlement.outcome, settlement.txHash);
    sseBus.publish(workId, 'settled', { outcome: settlement.outcome, txHash: settlement.txHash, bps: settlement.bps });

    // Post-settle ERC-8004 attestation — the SINGLE chokepoint both the sync /verdict route and the
    // async job path settle through. Best-effort, off the money path, fire-and-forget (never awaited,
    // never throws): it adds zero latency to the verdict response and a Base Sepolia failure can never
    // affect this already-recorded Arc settlement. Env-gated no-op unless the attestor is configured.
    void attestAfterSettle(task, verdict, settlement);

    // 4. Receipt
    const receipt = await buildReceipt(settlement, verdict, task.amountUsdc);
    await recordReceipt(workId, receipt);
    sseBus.publish(workId, 'receipt', receipt);

    return { verdict, outcome: settlement.outcome, txHash: settlement.txHash, bps: settlement.bps };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordSettleFailed(workId, msg).catch(() => {}); // keep DB honest; never mask the original error
    sseBus.publish(workId, 'error', { stage: 'settlement', message: msg });
    return { verdict, outcome: outcomeFor(verdict), txHash: null, error: msg };
  }
}
