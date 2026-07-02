import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { sql } from '@vercel/postgres';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';
import { jsonRpcHandler, agentCardHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { AgentCard } from '@a2a-js/sdk';
import { insertTask, getTask } from '../../src/lib/db.js';
import * as jobStore from '../../src/lib/job-store.js';
import type { JobStore } from '../../src/lib/job-engine.js';
import { makeEngine } from '../../src/lib/job-engine.js';
import { sellerAdapter } from '../../src/lib/adapter/index.js';
import { a2aDriver } from '../../src/lib/adapter/a2a.js';
import { httpTransport } from '../../src/lib/transport.js';
import { pollOnce } from '../../src/lib/keeper.js';
import type { KeeperDeps } from '../../src/lib/keeper.js';
import type { Task as VkTask, Artifact, VerdictResult } from '../../src/types.js';
import type { VerdictRunResult } from '../../src/engine/orchestrator.js';

// THE continuous A2A seller round-trip over REAL sockets — the flow WS4 never ran end-to-end (only
// isolated + spy-engine tests). A REAL @a2a-js/sdk server does the work; our generic adapter drives it
// through the SAME composition engine-instance uses in production:
//   engine.startJob → sellerAdapter → a2aDriver.dispatch (message/send over a real socket, task id
//   persisted via onResultRef=jobStore.setResultRef) → keeper.pollOnce → a2aDriver.fetchResult
//   (tasks/get over the socket) → engine.onDelivery → verify → SETTLED.
// verify is a spy (release) so this is repeatable with no chain spend; the real runVerdict→Arc settle
// leg is proven live in prove-a2a-roundtrip.ts. A2A is poll-only by design (MASTER-PLAN PART 2), so
// the keeper — not a callback — is what delivers. Closes the WS4 [IMPORTANT] gap for A2A.

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 }); // real sockets + Neon polling

const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const workId = `0x${Buffer.from(`a2a${suffix}`).toString('hex').padEnd(64, '0').slice(0, 64)}` as `0x${string}`;
const jobId = `a2a-${suffix}`;
const deliveredArtifact: Artifact = { type: 'answer', payload: 'Paris is the capital of France, on the Seine.' };

const verdict = { verdict: 'pass', confidence: 1, citedEvidence: [], rationale: '', route: 'answer', evidenceHash: `0x${'0'.repeat(64)}`, verdictCode: 0 } as VerdictResult;
const verify = vi.fn<(t: VkTask, a: Artifact) => Promise<VerdictRunResult>>().mockResolvedValue({ verdict, outcome: 'release', txHash: '0xsettle' });

let sellerServer: Server;
let sellerBase = '';
let engine: ReturnType<typeof makeEngine>;
let keeperDeps: KeeperDeps;
const sentEnvelopes: unknown[] = [];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const listen = (app: express.Express): Promise<{ server: Server; base: string }> =>
  new Promise((resolve) => { const s = app.listen(0, () => resolve({ server: s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` })); });

// A REAL A2A agent (via @a2a-js/sdk server). On message/send it captures the Verdikt envelope from the
// user message's DataPart, "works" briefly, then completes the task with the deliverable in a DataPart —
// exactly the canonical event flow a compliant A2A seller emits (submitted → working → artifact → completed).
class RoundTripExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const dataPart = ctx.userMessage.parts.find((p) => p.kind === 'data');
    sentEnvelopes.push(dataPart && 'data' in dataPart ? dataPart.data : null);
    const taskId = ctx.taskId, contextId = ctx.contextId;
    bus.publish({ kind: 'task', id: taskId, contextId, status: { state: 'submitted' }, history: [ctx.userMessage], artifacts: [] });
    bus.publish({ kind: 'status-update', taskId, contextId, status: { state: 'working' }, final: false });
    await sleep(200); // async work — the poller sees `working` first, then `completed`
    bus.publish({ kind: 'artifact-update', taskId, contextId, artifact: { artifactId: 'result', parts: [{ kind: 'data', data: deliveredArtifact as unknown as Record<string, unknown> }] } });
    bus.publish({ kind: 'status-update', taskId, contextId, status: { state: 'completed' }, final: true });
    bus.finished();
  }
  async cancelTask(_taskId: string, bus: ExecutionEventBus): Promise<void> { bus.finished(); }
}

function makeSellerApp(card: AgentCard): express.Express {
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new RoundTripExecutor());
  const app = express();
  app.use(express.json());
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: async () => card }));
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  return app;
}

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL required');

  // The card's service `url` must match the serving origin (the driver POSTs JSON-RPC there, SSRF-scoped
  // to the seller origin). Listen once, then patch card.url to the real base — the agentCardHandler
  // closure returns the mutated card, and JSON-RPC routing is the express mount, not card.url.
  const card: AgentCard = {
    name: 'Verdikt Reference A2A Seller', description: 'round-trip test seller', version: '1.0.0',
    protocolVersion: '0.3.0', url: '', preferredTransport: 'JSONRPC',
    capabilities: {}, defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: [{ id: 'answer', name: 'answer', description: 'grounded answers', tags: ['research'] }],
  };
  ({ server: sellerServer, base: sellerBase } = await listen(makeSellerApp(card)));
  card.url = sellerBase;

  const transport = sellerAdapter({
    webhook: httpTransport({ workerPublicUrl: '', allowPrivate: true }),
    a2a: a2aDriver({ allowPrivate: true, onResultRef: jobStore.setResultRef, workerPublicUrl: '' }),
    x402: { async dispatch() { throw new Error('x402 not under test'); }, async fetchResult() { return null; } },
  });
  engine = makeEngine({
    store: jobStore as JobStore,
    transport, verify, getTask,
    refundExpiredOnChain: vi.fn<() => Promise<string>>().mockResolvedValue('0x'),
    now: () => Date.now(),
    dispatch: { maxAttempts: 2, baseDelayMs: 5, sleep },
  });
  keeperDeps = { engine, listByState: jobStore.listByState, transport, now: () => Date.now() };
});

afterAll(async () => {
  await new Promise<void>((r) => sellerServer.close(() => r()));
  await sql`DELETE FROM vk_jobs WHERE job_id = ${jobId}`;
  await sql`DELETE FROM vk_tasks WHERE work_id = ${workId}`;
});

async function pollForState(want: string, ms = 15_000): Promise<string> {
  const end = Date.now() + ms; let last = '';
  while (Date.now() < end) {
    await pollOnce(keeperDeps); // the keeper's authoritative fetch drives A2A delivery
    last = (await jobStore.getJob(jobId))?.state ?? '';
    if (last === want) return last;
    await sleep(250);
  }
  return last;
}

describe('A2A seller round-trip over real sockets', () => {
  it('startJob → message/send → task id persisted → poll tasks/get → verify → SETTLED', async () => {
    const task: VkTask = { workId, type: 'answer', payer: `0x${'11'.repeat(20)}`, worker: `0x${'22'.repeat(20)}`, amountUsdc: 0.1, acceptance: { spec: 'answer grounded', sources: 'Paris is the capital of France.' } };
    await insertTask(task);

    await engine.startJob({ jobId, workId, sellerUrl: sellerBase, sellerProtocol: 'a2a', callbackToken: `tok-${suffix}`, resultRef: null, deadline: new Date(Date.now() + 3600_000) });

    // The A2A message/send actually reached the seller with OUR envelope over the wire.
    expect(sentEnvelopes).toHaveLength(1);
    expect((sentEnvelopes[0] as { workId: string }).workId).toBe(workId);

    // The seller received its route-filtered BRIEF in the message (Option C): the question + the
    // sources to ground in — enough to actually do the work over the wire.
    expect((sentEnvelopes[0] as { brief?: unknown }).brief).toEqual({ type: 'answer', spec: 'answer grounded', sources: 'Paris is the capital of France.' });

    // dispatch persisted the server-assigned task id as the job's resultRef (so poll survives a restart).
    const afterDispatch = await jobStore.getJob(jobId);
    expect(afterDispatch!.resultRef).toBeTruthy();

    expect(await pollForState('SETTLED')).toBe('SETTLED');

    // The artifact that was verified is the one tasks/get returned over the wire (not a local shortcut).
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ workId }), deliveredArtifact);
    const row = await jobStore.getJob(jobId);
    expect(row!.outcome).toBe('release');
    expect(row!.artifact).toEqual(deliveredArtifact);
  });
});
