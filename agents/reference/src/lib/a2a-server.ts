import express from 'express';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';
import { jsonRpcHandler, agentCardHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { SellerSkill } from './seller.js';
import { buildAgentCard } from './seller.js';
import type { Brief } from './types.js';

// A2A server mode for a reference seller (the standard-compliant, discoverable dispatch path). Because
// an A2A agent card must live at the ORIGIN ROOT (/.well-known/agent-card.json), an A2A seller is a
// SINGLE-ORIGIN service — one skill per deployed app. The worker's a2aDriver resolves the card, sends a
// message/send task envelope, and POLLS tasks/get for the result (A2A is poll-authoritative), so this
// executor just has to complete the task with the deliverable in a DataPart. Money never moves here.

class SkillExecutor implements AgentExecutor {
  constructor(private skill: SellerSkill) {}

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const dataPart = ctx.userMessage.parts.find((p) => p.kind === 'data');
    const envelope = (dataPart && 'data' in dataPart ? dataPart.data : null) as { brief?: Brief } | null;
    const taskId = ctx.taskId, contextId = ctx.contextId;

    // Canonical A2A event flow: submitted → working → artifact → completed (the a2aDriver polls until completed).
    bus.publish({ kind: 'task', id: taskId, contextId, status: { state: 'submitted' }, history: [ctx.userMessage], artifacts: [] });
    bus.publish({ kind: 'status-update', taskId, contextId, status: { state: 'working' }, final: false });
    try {
      if (!envelope?.brief) throw new Error('A2A message carried no Verdikt brief');
      const artifact = await this.skill.doWork(envelope.brief);
      bus.publish({ kind: 'artifact-update', taskId, contextId, artifact: { artifactId: 'result', parts: [{ kind: 'data', data: artifact as unknown as Record<string, unknown> }] } });
      bus.publish({ kind: 'status-update', taskId, contextId, status: { state: 'completed' }, final: true });
    } catch {
      // A failed task → the worker polls, sees no completed artifact, and the no-show deadline refunds the buyer.
      bus.publish({ kind: 'status-update', taskId, contextId, status: { state: 'failed' }, final: true });
    }
    bus.finished();
  }

  async cancelTask(_taskId: string, bus: ExecutionEventBus): Promise<void> { bus.finished(); }
}

// One A2A app per skill (single origin). `publicUrl` is the card's service url the worker POSTs JSON-RPC
// to — must equal the deployed origin (set via A2A_PUBLIC_URL).
export function buildA2AApp(skill: SellerSkill, publicUrl: string): express.Express {
  const card = buildAgentCard(skill, publicUrl);
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new SkillExecutor(skill));
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, mode: 'a2a', skill: skill.id, route: skill.route, url: publicUrl }));
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: async () => card }));
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  return app;
}
