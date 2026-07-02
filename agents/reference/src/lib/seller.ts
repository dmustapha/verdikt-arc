import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { AgentCard } from '@a2a-js/sdk';
import type { Brief, Artifact, DispatchEnvelope, Route } from './types.js';

// The Verdikt-standard seller harness. A reference seller = a skill (what it does + how it does it) +
// this harness (the deliver-then-settle wire contract). The harness NEVER moves money: it receives a
// dispatch, does the work, and POSTs the artifact back to the worker's callback authed by the per-job
// token. The worker's verdict engine alone decides release/refund. A seller earns nothing for bad work.

export interface SellerSkill {
  id: string;                 // URL path segment + A2A card skill id (e.g. 'research')
  name: string;               // human name
  description: string;        // one line
  route: Route;               // which verdict route governs this skill
  tags: string[];             // A2A skill tags
  capability: string;         // registry capability label
  doWork(brief: Brief): Promise<Artifact>;   // the actual work (Claude-powered in the concrete skills)
  // Pre-built acceptance shown in the human catalog: what the buyer supplies + the governing criterion.
  acceptanceTemplate: { spec: string; inputLabel: string };
}

// ── Envelope parsing ─────────────────────────────────────────────────────────
export function parseDispatch(body: unknown): DispatchEnvelope {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.workId !== 'string' || !b.workId) throw new Error('dispatch: workId required');
  if (typeof b.callbackUrl !== 'string' || !b.callbackUrl) throw new Error('dispatch: callbackUrl required');
  if (typeof b.callbackToken !== 'string' || !b.callbackToken) throw new Error('dispatch: callbackToken required');
  const brief = (b.brief ?? null) as Brief | null;
  return { workId: b.workId, brief, callbackUrl: b.callbackUrl, callbackToken: b.callbackToken, deadline: String(b.deadline ?? '') };
}

// ── Delivery (the signed callback) ───────────────────────────────────────────
export async function deliverArtifact(opts: {
  callbackUrl: string; callbackToken: string; artifact: Artifact; jti: string;
  fetchFn?: typeof fetch; timeoutMs?: number;
}): Promise<{ ok: boolean; status: number }> {
  const doFetch = opts.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(opts.callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Callback-Token': opts.callbackToken },
      body: JSON.stringify({ jti: opts.jti, artifact: opts.artifact }),
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

// ── A2A discovery card ───────────────────────────────────────────────────────
export function buildAgentCard(skill: SellerSkill, base: string): AgentCard {
  return {
    name: `Verdikt · ${skill.name}`,
    description: `${skill.description} — a Verdikt reference seller (deliver-then-settle, paid only on a verified-good verdict).`,
    version: '1.0.0', protocolVersion: '0.3.0', url: base, preferredTransport: 'JSONRPC',
    capabilities: {}, defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: [{ id: skill.id, name: skill.name, description: skill.description, tags: skill.tags }],
  };
}

// ── Webhook mount (the fast demo path) ───────────────────────────────────────
// Mounts a skill at /:id: a signed-webhook dispatch endpoint + its discovery card. On dispatch it acks
// 202 immediately, then does the work and delivers asynchronously — the deliver-then-settle lifecycle.
// A failure (bad brief, work error, callback rejected) is intentionally swallowed: the job no-shows at
// its deadline and the buyer is refunded. The seller can only ever earn by delivering verifiable work.
export interface MountOpts { fetchFn?: typeof fetch; idFn?: () => string; onError?: (e: unknown) => void }

export function mountWebhookSeller(app: Express, skill: SellerSkill, opts: MountOpts = {}): void {
  const idFn = opts.idFn ?? randomUUID;
  const log = opts.onError ?? ((e) => console.error(`[${skill.id}] delivery failed:`, e instanceof Error ? e.message : e));

  app.get(`/${skill.id}/.well-known/agent-card.json`, (req: Request, res: Response) => {
    res.json(buildAgentCard(skill, `${baseUrl(req)}/${skill.id}`));
  });

  app.post(`/${skill.id}/dispatch`, (req: Request, res: Response) => {
    let env: DispatchEnvelope;
    try { env = parseDispatch(req.body); } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'bad dispatch' }); return; }
    res.status(202).json({ accepted: true, skill: skill.id }); // ack fast; work runs async

    void (async () => {
      try {
        if (!env.brief) throw new Error('no brief to work from');
        const artifact = await skill.doWork(env.brief);
        const r = await deliverArtifact({ callbackUrl: env.callbackUrl, callbackToken: env.callbackToken, artifact, jti: idFn(), fetchFn: opts.fetchFn });
        if (!r.ok) log(new Error(`callback rejected: ${r.status}`));
      } catch (e) {
        log(e); // job no-shows → buyer refunded; the seller earns nothing for a failure
      }
    })();
  });
}

function baseUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  return `${proto}://${req.get('host')}`;
}
