import { Router } from 'express';
import { insertTask } from '../lib/db.js';
import { criteriaHash } from '../lib/task-offer.js';
import { VERDICT_FEE_USDC } from '../lib/x402-meter.js';
import { createRateLimiter, clientIp } from '../lib/rate-limit.js';
import type { Task, Acceptance, ArtifactType } from '../types.js';

export const tasksRouter = Router();

const TYPES: ArtifactType[] = ['code', 'tool_output', 'answer', 'execution'];

// B3: /api/tasks is public and writes a DB row (no money moves). Rate-limit per IP so it can't be
// spammed into DB bloat. Generous: a real payer registers a handful of tasks, not hundreds.
const TASKS_PER_IP = Number(process.env.TASKS_PER_IP ?? 30);
const TASKS_WINDOW_MS = Number(process.env.TASKS_WINDOW_MS ?? 10 * 60 * 1000);
const rateLimit = createRateLimiter({ perIp: TASKS_PER_IP, ipWindowMs: TASKS_WINDOW_MS });

// POST /api/tasks — a PAYER (buyer) agent registers a task's acceptance criteria + parties and gets
// back the workId + criteriaHash needed to fund the escrow and build a signed Task Offer for an
// INDEPENDENT seller. This is the public on-ramp: it does NOT move money (the payer funds the escrow
// on-chain separately via EIP-3009); it only commits the criteria the verdict engine will judge
// against, so the seller can trust what it is being measured on before doing the work.
// body: { workId, type, acceptance, payer, seller, amountUsdc }
tasksRouter.post('/api/tasks', async (req, res) => {
  const { workId, type, acceptance, payer, seller, amountUsdc } = req.body as {
    workId?: `0x${string}`;
    type?: ArtifactType;
    acceptance?: Acceptance;
    payer?: `0x${string}`;
    seller?: `0x${string}`;
    amountUsdc?: number;
  };

  const limited = rateLimit(clientIp(req), Date.now());
  if (limited) { res.status(429).json({ error: limited }); return; }

  if (!workId || !/^0x[0-9a-fA-F]{64}$/.test(workId)) { res.status(400).json({ error: 'valid bytes32 workId required' }); return; }
  if (!type || !TYPES.includes(type)) { res.status(400).json({ error: `type must be one of ${TYPES.join(', ')}` }); return; }
  if (!acceptance || typeof acceptance !== 'object') { res.status(400).json({ error: 'acceptance criteria required' }); return; }
  if (!payer || !seller) { res.status(400).json({ error: 'payer and seller addresses required' }); return; }
  if (typeof amountUsdc !== 'number' || !(amountUsdc > 0)) { res.status(400).json({ error: 'amountUsdc must be a positive number' }); return; }

  // Internally the seller maps to the escrow's `worker` field (the release recipient).
  const task: Task = { workId, type, acceptance, payer, worker: seller, amountUsdc };
  await insertTask(task); // ON CONFLICT DO NOTHING — idempotent re-registration is safe

  res.status(201).json({
    workId,
    criteriaHash: criteriaHash(acceptance),
    escrow: process.env.ESCROW_ADDRESS ?? null,
    chainId: 5042002,
    feeUsdc: VERDICT_FEE_USDC,
  });
});
