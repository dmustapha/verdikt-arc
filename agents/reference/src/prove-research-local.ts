import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { buildApp, buildSkills } from './server.js';
import type { Artifact } from './lib/types.js';

// LIVE proof of the Research reference seller over real sockets with a REAL Claude brain (no chain, no
// worker package): stand up the seller + a mock worker callback catcher, dispatch two tasks, and show
//   (1) a groundable question  → a grounded answer  (would PASS the verdict → seller paid), and
//   (2) an ungroundable question → an honest refusal (would ABSTAIN → buyer refunded, seller earns nothing).
// The honesty is the point: the agent never fabricates a claim its sources don't support.
//
// Run: set -a; . ../../.env; set +a; npx tsx src/prove-research-local.ts   (needs ANTHROPIC_API_KEY)

const listen = (app: express.Express): Promise<{ server: Server; base: string }> =>
  new Promise((res) => { const s = app.listen(0, () => res({ server: s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` })); });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function dispatchAndAwait(sellerBase: string, workerBase: string, deliveries: Map<string, { token: string; artifact: Artifact }>, spec: string, sources: string): Promise<{ artifact: Artifact; tokenOk: boolean }> {
  const jobId = randomUUID();
  const callbackToken = randomUUID();
  const res = await fetch(`${sellerBase}/research/dispatch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workId: `0x${'ab'.repeat(32)}`,
      brief: { type: 'answer', spec, sources },
      callbackUrl: `${workerBase}/webhook/callback/${jobId}`, callbackToken, deadline: new Date(Date.now() + 3600_000).toISOString(),
    }),
  });
  if (res.status !== 202) throw new Error(`dispatch not accepted: ${res.status}`);
  for (let i = 0; i < 60; i++) { if (deliveries.has(jobId)) break; await sleep(500); }
  const d = deliveries.get(jobId);
  if (!d) throw new Error('seller never delivered (timeout)');
  return { artifact: d.artifact, tokenOk: d.token === callbackToken };
}

async function main() {
  const deliveries = new Map<string, { token: string; artifact: Artifact }>();
  const worker = express();
  worker.use(express.json());
  worker.post('/webhook/callback/:jobId', (req, res) => {
    deliveries.set(req.params.jobId, { token: req.header('x-callback-token') ?? '', artifact: (req.body as { artifact: Artifact }).artifact });
    res.status(202).json({ accepted: true });
  });
  const { server: workerServer, base: workerBase } = await listen(worker);
  const { server: sellerServer, base: sellerBase } = await listen(buildApp(buildSkills()));

  console.log(`\nResearch reference seller @ ${sellerBase}  (worker callback @ ${workerBase})\n`);

  // (1) Groundable — the answer is in the sources.
  const pos = await dispatchAndAwait(sellerBase, workerBase, deliveries,
    'What is the capital of France, and what river runs through it?',
    'France is a country in Western Europe. Its capital is Paris. The river Seine runs through Paris.');
  console.log('POSITIVE (groundable):');
  console.log(`  token authed: ${pos.tokenOk}`);
  console.log(`  answer: ${pos.artifact.payload}\n`);

  // (2) Ungroundable — the sources say nothing about this.
  const neg = await dispatchAndAwait(sellerBase, workerBase, deliveries,
    'What is the population of Tokyo?',
    'France is a country in Western Europe. Its capital is Paris. The river Seine runs through Paris.');
  console.log('NEGATIVE (ungroundable):');
  console.log(`  answer: ${neg.artifact.payload}\n`);

  workerServer.close(); sellerServer.close();

  const posGrounded = pos.tokenOk && pos.artifact.type === 'answer' && /paris/i.test(pos.artifact.payload) && /seine/i.test(pos.artifact.payload);
  const negHonest = /do not cover|not cover|no information|sources do not/i.test(neg.artifact.payload);
  if (!posGrounded) throw new Error('positive case did not produce a grounded Paris/Seine answer');
  if (!negHonest) throw new Error(`negative case was not an honest refusal — got: ${neg.artifact.payload}`);
  console.log('✅ Research seller proven: grounded answer on groundable input; honest refusal on ungroundable input.');
  console.log('   (positive → verdict PASS → seller paid;  negative → verdict ABSTAIN → buyer refunded)');
  process.exit(0);
}

main().catch((e) => { console.error('RESEARCH SELLER PROOF FAILED:', e); process.exit(1); });
