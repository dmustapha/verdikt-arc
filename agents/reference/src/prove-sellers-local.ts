import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildApp, buildSkills } from './server.js';
import type { Artifact, Brief } from './lib/types.js';

// LIVE proof of all THREE reference sellers over real sockets with a REAL Claude brain (no chain, no
// worker package): stand up the seller service + a mock worker callback catcher, dispatch a task to each
// skill, and check the delivered artifact is the kind of verifiable output its verdict route governs:
//   research      → an answer grounded in the sources (would PASS grounding).
//   data-transform → JSON that matches the target schema (would PASS the ajv check).
//   code          → a Python module that actually makes the test pass (RUN locally here — would PASS the sandbox).
// This proves the sellers do real, verifiable work end-to-end; the full escrow→verdict→Arc-settle loop
// is the Gate C3 live script.
//
// Run: set -a; . ../../.env; set +a; npx tsx src/prove-sellers-local.ts   (needs ANTHROPIC_API_KEY)

const listen = (app: express.Express): Promise<{ server: Server; base: string }> =>
  new Promise((res) => { const s = app.listen(0, () => res({ server: s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` })); });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function dispatch(sellerBase: string, workerBase: string, deliveries: Map<string, { token: string; artifact: Artifact }>, skillId: string, brief: Brief): Promise<{ artifact: Artifact; tokenOk: boolean }> {
  const jobId = randomUUID();
  const callbackToken = randomUUID();
  const res = await fetch(`${sellerBase}/${skillId}/dispatch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workId: `0x${'ab'.repeat(32)}`, brief, callbackUrl: `${workerBase}/webhook/callback/${jobId}`, callbackToken, deadline: new Date(Date.now() + 3600_000).toISOString() }),
  });
  if (res.status !== 202) throw new Error(`${skillId} dispatch not accepted: ${res.status}`);
  for (let i = 0; i < 90; i++) { if (deliveries.has(jobId)) break; await sleep(500); }
  const d = deliveries.get(jobId);
  if (!d) throw new Error(`${skillId} never delivered (timeout)`);
  return { artifact: d.artifact, tokenOk: d.token === callbackToken };
}

// Actually run the code seller's module against a test — the real proof for the code route.
function runPython(source: string): 'pass' | 'fail' {
  const dir = mkdtempSync(join(tmpdir(), 'vk-code-'));
  writeFileSync(join(dir, 'solution.py'), source);
  writeFileSync(join(dir, 'check.py'), 'from solution import average\nassert average([1,2,3]) == 2\nassert average([]) == 0\nprint("OK")\n');
  try { return execFileSync('python3', ['check.py'], { cwd: dir, encoding: 'utf8' }).includes('OK') ? 'pass' : 'fail'; }
  catch { return 'fail'; }
}

async function main() {
  const deliveries = new Map<string, { token: string; artifact: Artifact }>();
  const worker = express();
  worker.use(express.json({ limit: '256kb' }));
  worker.post('/webhook/callback/:jobId', (req, res) => {
    deliveries.set(req.params.jobId, { token: req.header('x-callback-token') ?? '', artifact: (req.body as { artifact: Artifact }).artifact });
    res.status(202).json({ accepted: true });
  });
  const { server: workerServer, base: workerBase } = await listen(worker);
  const { server: sellerServer, base: sellerBase } = await listen(buildApp(buildSkills()));
  console.log(`\nReference sellers @ ${sellerBase}  (worker callback @ ${workerBase})\n`);

  // 1. Research — grounded answer.
  const research = await dispatch(sellerBase, workerBase, deliveries, 'research', {
    type: 'answer', spec: 'What is the capital of France and what river runs through it?',
    sources: 'France is in Western Europe. Its capital is Paris. The river Seine runs through Paris.',
  });
  const researchOk = research.tokenOk && research.artifact.type === 'answer' && /paris/i.test(research.artifact.payload) && /seine/i.test(research.artifact.payload);
  console.log(`research      → ${researchOk ? 'PASS' : 'FAIL'}  ${research.artifact.payload.replace(/\s+/g, ' ').slice(0, 90)}`);

  // 2. Data transform — JSON matching the target schema.
  const jsonSchema = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } }, required: ['name', 'age'], additionalProperties: false };
  const dt = await dispatch(sellerBase, workerBase, deliveries, 'data-transform', {
    type: 'tool_output', spec: 'Extract the person from this text: "Ada Lovelace is 36 years old."', jsonSchema,
  });
  let dtOk = false, dtParsed: unknown = null;
  try { dtParsed = JSON.parse(dt.artifact.payload); dtOk = dt.artifact.type === 'tool_output' && typeof (dtParsed as { name?: unknown }).name === 'string' && /ada/i.test((dtParsed as { name: string }).name) && Number.isInteger((dtParsed as { age?: unknown }).age); } catch { dtOk = false; }
  console.log(`data-transform → ${dtOk ? 'PASS' : 'FAIL'}  ${dt.artifact.payload.replace(/\s+/g, ' ').slice(0, 90)}`);

  // 3. Code — a module that actually makes the test pass (run in Python).
  const code = await dispatch(sellerBase, workerBase, deliveries, 'code', {
    type: 'code',
    spec: 'Implement average(nums): the arithmetic mean of a list of numbers; the empty list returns 0.',
    tests: 'from solution import average\n\ndef test_mean():\n    assert average([1, 2, 3]) == 2\n\ndef test_empty():\n    assert average([]) == 0\n',
  });
  const codeRun = code.artifact.type === 'code' ? runPython(code.artifact.payload) : 'fail';
  console.log(`code          → ${codeRun === 'pass' ? 'PASS' : 'FAIL'}  (ran solution.py against the test → ${codeRun})`);

  workerServer.close(); sellerServer.close();

  if (!researchOk) throw new Error('research seller did not produce a grounded answer');
  if (!dtOk) throw new Error(`data-transform seller did not produce schema-valid JSON: ${dt.artifact.payload}`);
  if (codeRun !== 'pass') throw new Error('code seller did not produce a module that passes the test');
  console.log('\n✅ All three reference sellers produce real, verifiable work over real sockets (token-authed delivery).');
  process.exit(0);
}

main().catch((e) => { console.error('SELLERS PROOF FAILED:', e); process.exit(1); });
