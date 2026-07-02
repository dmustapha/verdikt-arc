import express from 'express';
import { mountWebhookSeller } from './lib/seller.js';
import type { SellerSkill } from './lib/seller.js';
import { Brain } from './lib/brain.js';
import { researchSkill } from './skills/research.js';
import { dataTransformSkill } from './skills/data-transform.js';
import { codeSkill } from './skills/code.js';

// The reference-seller service. Hosts the Claude-powered reference sellers that implement the Verdikt
// standard (signed-webhook dispatch + A2A discovery card), each mounted at its own /:id path so one
// deployable process serves the whole catalog. Each seller is registered independently with the worker's
// /sellers/register. Money never flows here: a seller delivers work and the worker's verdict settles.

export function buildSkills(): SellerSkill[] {
  const brain = new Brain('reference');
  return [researchSkill(brain), dataTransformSkill(brain), codeSkill(brain)];
}

export function buildApp(skills: SellerSkill[]): express.Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, sellers: skills.map((s) => ({ id: s.id, route: s.route, dispatch: `/${s.id}/dispatch`, card: `/${s.id}/.well-known/agent-card.json` })) }));
  for (const skill of skills) mountWebhookSeller(app, skill);
  return app;
}

// Entrypoint (skipped when imported by a test).
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const app = buildApp(buildSkills());
  const port = Number(process.env.PORT ?? 8790);
  app.listen(port, () => console.log(`[reference-sellers] listening on :${port}`));
}
