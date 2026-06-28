import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { insertTask, getTask, recordFunded } from '../lib/db.js';
import { runVerdict } from '../engine/orchestrator.js';
import { fundEscrow } from '../settlement/fund-escrow.js';
import { sseBus } from '../lib/sse-bus.js';
import type { Task, Artifact, Acceptance } from '../types.js';

export const demoRouter = Router();

// In-flight workIds: idempotency for the async run (a duplicate POST for a workId already
// running is rejected 409 rather than double-funding). Cleared in the async finally block.
const inFlight = new Set<string>();

const FIXTURES = process.env.FIXTURES_DIR ?? join(process.cwd(), '..', 'fixtures');

// Read the payer's schema contract — honors the payer's real min_response_bytes (not a hardcode).
async function schemaAcceptance(): Promise<Acceptance> {
  const contract = JSON.parse(await readFile(join(FIXTURES, 'task-schema/contract.json'), 'utf8'));
  return { spec: 'matches schema', schema: contract.promised_schema, minResponseBytes: contract.min_response_bytes };
}

// Demo scenarios map to (task type, fixture acceptance, fixture artifact).
const SCENARIOS: Record<string, { type: Task['type']; load: () => Promise<{ acceptance: Acceptance; artifact: Artifact }> }> = {
  good: { type: 'code', load: async () => ({
    acceptance: { spec: 'parameterized query', tests: await readFile(join(FIXTURES, 'task-code/payer_test.py'), 'utf8') },
    artifact: { type: 'code', language: 'python', payload: await readFile(join(FIXTURES, 'task-code/good_solution.py'), 'utf8') },
  }) },
  bad: { type: 'code', load: async () => ({
    acceptance: { spec: 'parameterized query', tests: await readFile(join(FIXTURES, 'task-code/payer_test.py'), 'utf8') },
    artifact: { type: 'code', language: 'python', payload: await readFile(join(FIXTURES, 'task-code/bad_solution.py'), 'utf8') },
  }) },
  abstain: { type: 'answer', load: async () => ({
    acceptance: { spec: 'answer grounded in sources', sources: await readFile(join(FIXTURES, 'task-answer/sources.md'), 'utf8') },
    artifact: { type: 'answer', payload: await readFile(join(FIXTURES, 'task-answer/unsupported_answer.txt'), 'utf8') },
  }) },
  schema: { type: 'tool_output', load: async () => ({
    acceptance: await schemaAcceptance(),
    artifact: { type: 'tool_output', payload: await readFile(join(FIXTURES, 'task-schema/good_output.json'), 'utf8') },
  }) },
  'schema-bad': { type: 'tool_output', load: async () => ({
    acceptance: await schemaAcceptance(),
    artifact: { type: 'tool_output', payload: await readFile(join(FIXTURES, 'task-schema/bad_output.json'), 'utf8') },
  }) },
};

// POST /api/demo/:type  body: { workId, payer?, worker?, amountUsdc? }
demoRouter.post('/api/demo/:type', async (req, res) => {
  // Shared-secret guard — this route moves real test USDC (M-01). Fail CLOSED:
  // if the secret is not configured, refuse rather than leave the money route open (debug Phase 8).
  const secret = process.env.DEMO_SHARED_SECRET;
  if (!secret) { res.status(503).json({ error: 'demo disabled: DEMO_SHARED_SECRET not configured' }); return; }
  if (req.header('X-Demo-Secret') !== secret) {
    res.status(401).json({ error: 'unauthorized' }); return;
  }
  const scenario = SCENARIOS[req.params.type];
  if (!scenario) { res.status(400).json({ error: 'unknown demo type' }); return; }
  const { workId } = req.body as { workId: `0x${string}` };
  if (!workId) { res.status(400).json({ error: 'workId required' }); return; }

  // M-2: this route moves REAL test USDC. NEVER honor client-supplied worker/payer (a caller could
  // redirect a release to their own wallet) — use the env-fixed demo addresses only. Clamp the
  // amount to a hard ceiling so a crafted body cannot drain the demo payer wallet.
  const DEMO_MAX_USDC = Number(process.env.DEMO_MAX_USDC ?? 1);
  const worker = process.env.DEMO_WORKER_ADDRESS as `0x${string}`;
  const payer = process.env.DEMO_PAYER_ADDRESS as `0x${string}`;
  const reqAmount = Number(req.body.amountUsdc);
  const amountUsdc = Math.min(Number.isFinite(reqAmount) && reqAmount > 0 ? reqAmount : DEMO_MAX_USDC, DEMO_MAX_USDC);

  if (inFlight.has(workId)) { res.status(409).json({ error: 'workId already in flight' }); return; }

  const { acceptance, artifact } = await scenario.load();
  let task = await getTask(workId);
  if (!task) {
    task = { workId, type: scenario.type, acceptance, payer, worker, amountUsdc };
    await insertTask(task);
  }
  const t = task; // non-null capture for the async closure

  // ACK immediately (202) so the client's already-open SSE renders the run unfolding LIVE,
  // instead of a ~25s dead spinner followed by a history dump. The fund→verdict→settle runs
  // async and publishes every step (task_funded → route → evidence → verdict → settled) over
  // the SSE bus. Funding errors are published as an SSE error, not a lost HTTP 500.
  inFlight.add(workId);
  res.status(202).json({ workId, accepted: true });

  void (async () => {
    try {
      const fundTx = await fundEscrow({ payerKey: process.env.DEMO_PAYER_KEY as `0x${string}`, workId, worker: t.worker, amountUsdc: t.amountUsdc });
      await recordFunded(workId, fundTx);
      sseBus.publish(workId, 'task_funded', { fundTx, amountUsdc: t.amountUsdc });
      await runVerdict(t, artifact);
    } catch (err) {
      sseBus.publish(workId, 'error', { stage: 'funding', message: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.delete(workId);
    }
  })();
});
