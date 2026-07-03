import { Router } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import { getTask, getVerdict, getEscrowMeta } from '../lib/db.js';
import { createJob, getJob, recordJobError, listByPayer } from '../lib/job-store.js';
import type { SellerProtocol } from '../lib/job-store.js';
import { readEscrowOnChain } from '../settlement/escrow-read.js';
import { formatUnits } from 'viem';
import { assertSafeUrl } from '../lib/ssrf.js';
import { engine } from '../lib/engine-instance.js';
import { createRateLimiter, clientIp } from '../lib/rate-limit.js';

export const jobsRouter = Router();

const STATUS_FUNDED = 1; // VerdiktEscrow on-chain status enum
const VALID_WORKID = /^0x[0-9a-fA-F]{64}$/;
const VALID_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PROTOCOLS: SellerProtocol[] = ['webhook', 'a2a', 'x402'];

// Decode the on-chain escrow enums (mirrors VerdiktEscrow.sol constants) so the dashboard reads a
// truthful, human-readable chain status rather than a bare uint8.
const STATUS_LABEL: Record<number, string> = { 0: 'EMPTY', 1: 'FUNDED', 2: 'SETTLED' };
const OUTCOME_LABEL: Record<number, string> = { 0: 'release', 1: 'refund', 2: 'abstain', 3: 'partial', 4: 'expired' };

const JOBS_PER_IP = Number(process.env.JOBS_PER_IP ?? 20);
const rateLimit = createRateLimiter({ perIp: JOBS_PER_IP, ipWindowMs: 10 * 60 * 1000 });
// /expire is unauthenticated (it only ever refunds the buyer), but each call is a DB read + a possible
// on-chain tx — rate-limit per IP so it can't be used to spam doomed refundExpired attempts.
const expireRateLimit = createRateLimiter({ perIp: Number(process.env.EXPIRE_PER_IP ?? 30), ipWindowMs: 10 * 60 * 1000 });

// POST /api/jobs — start the async lifecycle for an ALREADY-FUNDED escrow. The escrow must be funded
// on-chain (the payer funds it separately via EIP-3009) and its task registered via /api/tasks; this
// route only orchestrates dispatch → await delivery → verify → settle. It moves no money at creation.
// Gated by the shared secret (control-plane auth); WS7 adds proper payer auth for the human/SDK path.
// body: { workId, seller: { url, protocol, resultRef? } }
jobsRouter.post('/api/jobs', async (req, res) => {
  const secret = process.env.DEMO_SHARED_SECRET;
  if (!secret) { res.status(503).json({ error: 'jobs disabled: DEMO_SHARED_SECRET not configured' }); return; }
  if (req.header('X-Demo-Secret') !== secret) { res.status(401).json({ error: 'unauthorized' }); return; }

  const limited = rateLimit(clientIp(req), Date.now());
  if (limited) { res.status(429).json({ error: limited }); return; }

  const { workId, seller } = (req.body ?? {}) as {
    workId?: `0x${string}`;
    seller?: { url?: string; protocol?: SellerProtocol; resultRef?: string };
  };
  if (!workId || !VALID_WORKID.test(workId)) { res.status(400).json({ error: 'valid bytes32 workId required' }); return; }
  if (!seller?.url || !seller.protocol || !PROTOCOLS.includes(seller.protocol)) {
    res.status(400).json({ error: `seller.url and seller.protocol (${PROTOCOLS.join('|')}) required` }); return;
  }
  try {
    assertSafeUrl(seller.url); // block private/loopback dispatch targets up front
    if (seller.resultRef) assertSafeUrl(seller.resultRef, { allowedOrigins: [new URL(seller.url).origin] });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'unsafe seller URL' }); return;
  }

  const task = await getTask(workId);
  if (!task) { res.status(404).json({ error: 'unknown workId — register the task via /api/tasks and fund the escrow first' }); return; }

  // Chain-authoritative: only start a job for an escrow that is actually FUNDED, and take the deadline
  // from the chain so the keeper's no-show clock matches the contract's exactly.
  let deadline: Date;
  try {
    const onchain = await readEscrowOnChain(workId);
    if (Number(onchain.status) !== STATUS_FUNDED) { res.status(409).json({ error: 'escrow is not FUNDED on-chain' }); return; }
    deadline = new Date(Number(onchain.deadline) * 1000);
    if (!deadline.getTime()) { res.status(409).json({ error: 'escrow has no on-chain deadline' }); return; }
  } catch (e) {
    res.status(502).json({ error: `could not read escrow on-chain: ${e instanceof Error ? e.message : String(e)}` }); return;
  }

  const jobId = randomUUID();
  const callbackToken = randomBytes(24).toString('hex');
  const input = { jobId, workId, sellerUrl: seller.url, sellerProtocol: seller.protocol, callbackToken, resultRef: seller.resultRef ?? null, deadline };

  await createJob(input); // persist before ack so an immediate GET / callback resolves
  const base = process.env.WORKER_PUBLIC_URL ?? '';
  res.status(202).json({
    jobId,
    state: 'FUNDED',
    callbackToken,
    callbackUrls: {
      webhook: `${base}/webhook/callback/${jobId}`,
      a2a: `${base}/a2a/callback/${jobId}`,
    },
    deadline: deadline.toISOString(),
  });

  // Dispatch asynchronously (retries + backoff); startJob re-creates idempotently then dispatches.
  void engine.startJob(input).catch((err) => recordJobError(jobId, err instanceof Error ? err.message : String(err)));
});

// GET /api/jobs?payer=0x… — the returnable job LIST for one buyer (WS8 dashboard). Joins vk_jobs to
// vk_tasks on the escrow payer (public on-chain, so no leak). Lightweight: DB state only, no per-row
// chain read (that would be N RPC calls) — the DB state is already chain-derived (every terminal state
// is set from a confirmed on-chain tx). The detail view does the independent on-chain cross-check.
jobsRouter.get('/api/jobs', async (req, res) => {
  const limited = rateLimit(clientIp(req), Date.now());
  if (limited) { res.status(429).json({ error: limited }); return; }

  const payer = String(req.query.payer ?? '');
  if (!VALID_ADDRESS.test(payer)) { res.status(400).json({ error: 'valid ?payer=0x… address required' }); return; }
  const jobs = await listByPayer(payer);
  res.json({
    payer,
    jobs: jobs.map((j) => ({
      jobId: j.jobId,
      workId: j.workId,
      state: j.state,
      outcome: j.outcome,
      sellerProtocol: j.sellerProtocol,
      settleTxHash: j.settleTxHash,
      deadline: j.deadline.toISOString(),
    })),
  });
});

// GET /api/jobs/:id — the returnable status DETAIL (DB-backed; survives worker restarts). Enriched for
// WS8 with the independent on-chain escrow cross-check + fund/settle proof tx hashes + the recorded
// verdict, so the dashboard can PROVE its DB state matches chain reality. jobId is an unguessable UUID,
// so it acts as a per-job capability token: only someone with it (the buyer / their tracked link) sees
// the artifact + verdict. Every field is a read of a source of truth — nothing is invented here.
jobsRouter.get('/api/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) { res.status(404).json({ error: 'unknown job' }); return; }

  // Independent on-chain read (the correct 13-field escrow ABI). try/catch → chain:null on any RPC
  // hiccup so the view never breaks; the DB state still renders.
  let chain: {
    status: number; statusLabel: string; outcome: number | null; outcomeLabel: string | null;
    amountUsdc: string; feeUsdc: string; deadline: string;
  } | null = null;
  try {
    const e = await readEscrowOnChain(job.workId);
    const settled = Number(e.status) === 2;
    chain = {
      status: Number(e.status),
      statusLabel: STATUS_LABEL[Number(e.status)] ?? String(e.status),
      outcome: settled ? Number(e.outcome) : null,
      outcomeLabel: settled ? (OUTCOME_LABEL[Number(e.outcome)] ?? String(e.outcome)) : null,
      amountUsdc: formatUnits(e.amount, 6),
      feeUsdc: formatUnits(e.fee, 6),
      deadline: new Date(Number(e.deadline) * 1000).toISOString(),
    };
  } catch { chain = null; }

  const [meta, verdict] = await Promise.all([getEscrowMeta(job.workId), getVerdict(job.workId)]);

  res.json({
    jobId: job.jobId,
    workId: job.workId,
    state: job.state,
    sellerProtocol: job.sellerProtocol,
    dispatchAttempts: job.dispatchAttempts,
    outcome: job.outcome,
    settleTxHash: job.settleTxHash ?? meta?.settleTxHash ?? null,
    fundTxHash: meta?.fundTxHash ?? null,
    deadline: job.deadline.toISOString(),
    lastError: job.lastError,
    artifact: job.artifact,   // the seller's delivered deliverable (null pre-delivery)
    chain,                    // independent on-chain escrow truth (null on RPC failure)
    verdict,                  // recorded verdict for the result view (null pre-verdict)
  });
});

// POST /api/jobs/:id/expire — manual keeper trigger. Only refunds the buyer, and only past the
// deadline for a non-terminal job (the engine + contract both guard). Safe to expose.
jobsRouter.post('/api/jobs/:id/expire', async (req, res) => {
  const limited = expireRateLimit(clientIp(req), Date.now());
  if (limited) { res.status(429).json({ error: limited }); return; }
  try {
    const r = await engine.expireJob(req.params.id);
    res.status(r.expired ? 200 : 409).json(r);
  } catch (e) {
    res.status(502).json({ error: `refundExpired failed: ${e instanceof Error ? e.message : String(e)}` });
  }
});
