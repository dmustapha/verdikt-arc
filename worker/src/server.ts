import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { verdictRouter } from './routes/verdict.js';
import { streamRouter } from './routes/stream.js';
import { demoRouter } from './routes/demo.js';
import { tasksRouter } from './routes/tasks.js';
import { tryRouter } from './routes/try.js';
import { jobsRouter } from './routes/jobs.js';
import { relayerRouter } from './routes/relayer.js';
import { faucetRouter } from './routes/faucet.js';
import { makeSellersRouter } from './routes/sellers.js';
import { makeCallbackRouter } from './routes/callback.js';
import { evidenceRouter } from './routes/evidence.js';
import { enableEvidencePersistence } from './lib/evidence-store.js';
import { enableAttestation } from './lib/attestor.js';
import { engine, startWorkerKeeper } from './lib/engine-instance.js';

const app = express();
// Behind Fly's proxy: trust the first hop so req.ip / X-Forwarded-For reflect the real client
// (the public /api/try rail rate-limits per IP).
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
// Restrict money-moving routes to the known web origin. The SSE stream route (read-only)
// sets its own `*` header. WEB_ORIGIN unset falls back to `*` for local dev only.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.WEB_ORIGIN ?? '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Payment-Signature,X-Payment,X-Demo-Secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // WS7: a browser POST /relayer/fund with Content-Type: application/json triggers a CORS preflight.
  // Answer it here (204) so the human web path can call the money-moving routes cross-origin.
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'verdikt-worker' }));
app.use(verdictRouter);
app.use(streamRouter);
app.use(demoRouter);
app.use(tasksRouter);
app.use(tryRouter);
app.use(jobsRouter);
// WS7: gasless relayer — submits a human's pre-signed EIP-3009 authorization so the human pays no gas.
app.use(relayerRouter);
// WS7: ERC-20 USDC faucet so a fresh browser wallet can get test USDC to escrow (gas-free path).
app.use(faucetRouter);
// ERC-8004 evidence bundles (public, read-only) — the responseURI a validationResponse points at.
app.use(evidenceRouter);
// Seller registry: register (validate → probe → store healthy/unhealthy) + list the healthy catalog.
app.use(makeSellersRouter());
// Seller delivery callbacks feed the shared job engine's onDelivery (verify → settle).
app.use(makeCallbackRouter(engine.onDelivery));

// JSON error handler. Replaces Express's default HTML error page (which leaks
// absolute file paths and a stack trace in the body). Malformed JSON bodies from
// the body parser surface as a SyntaxError with `status` 400 → clean 400 JSON;
// anything else → clean 500 JSON. Never exposes internals to clients.
app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const badJson = err.type === 'entity.parse.failed' || (err.status === 400 && err instanceof SyntaxError);
  if (badJson) { res.status(400).json({ error: 'malformed JSON body' }); return; }
  // Oversize body: the parser rejected it before any handler ran (never processed),
  // so answer with the correct 413 instead of a generic 500 + console noise.
  if (err.type === 'entity.too.large' || err.status === 413) { res.status(413).json({ error: 'payload too large' }); return; }
  console.error('[verdikt-worker] unhandled error:', err);
  res.status(500).json({ error: 'internal error' });
});

// Durable ERC-8004 evidence: persist bundles to Postgres so the on-chain responseURIs keep resolving
// across worker restarts. Opt-in (only when a DB is configured) — unit tests stay Map-only.
if (process.env.POSTGRES_URL) enableEvidencePersistence();
// Turn on post-settle ERC-8004 attestation only in the running server (and only when configured), so
// tests exercising the real runVerdict never fire live Base Sepolia writes.
if (process.env.ERC8004_AGENT_ID) enableAttestation();

const port = parseInt(process.env.PORT ?? '8080', 10);
app.listen(port, () => console.log(`[verdikt-worker] listening on :${port}`));

// Background keeper: poll fallback for push-less sellers + no-show expiry. Opt-in so local/test
// imports never spawn timers.
if (process.env.KEEPER_ENABLED === 'true') {
  startWorkerKeeper();
  console.log('[verdikt-worker] keeper started (poll + no-show expiry)');
}
