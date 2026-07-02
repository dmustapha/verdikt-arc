import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { sql } from '@vercel/postgres';
import { insertTask } from '../../src/lib/db.js';
import { createJob } from '../../src/lib/job-store.js';
import { makeCallbackRouter } from '../../src/routes/callback.js';
import type { JobRow } from '../../src/lib/job-store.js';
import type { Delivery } from '../../src/routes/callback.js';
import type { Task, Artifact } from '../../src/types.js';

// Proves the REAL HTTP callback wire end-to-end: an actual socket → express.json() →
// makeCallbackRouter's handler (header/bearer/body parsing) → handleCallback → real getJob/
// recordSeenJti (live Neon). onDelivery is a spy so no engine/chain runs. Closes the "express wrapper
// untested" gap and exercises the callback half of the seller wire over a real port.

const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const workId = `0x${Buffer.from(`cbw${suffix}`).toString('hex').padEnd(64, '0').slice(0, 64)}` as `0x${string}`;
const jobId = `cbw-${suffix}`;
const TOKEN = 'super-secret-token';
const artifact: Artifact = { type: 'answer', payload: 'the delivered answer' };

let server: Server;
let base: string;
const onDelivery = vi.fn<(job: JobRow, d: Delivery) => Promise<void>>().mockResolvedValue(undefined);

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL required');
  const task: Task = { workId, type: 'answer', payer: `0x${'11'.repeat(20)}`, worker: `0x${'22'.repeat(20)}`, amountUsdc: 0.1, acceptance: { spec: 's', sources: 'x' } };
  await insertTask(task);
  await createJob({ jobId, workId, sellerUrl: 'https://seller.example.com/d', sellerProtocol: 'webhook', callbackToken: TOKEN, resultRef: null, deadline: new Date(Date.now() + 3600_000) });

  const app = express();
  app.use(express.json());
  app.use(makeCallbackRouter(onDelivery));
  await new Promise<void>((resolve) => { server = app.listen(0, () => { base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; resolve(); }); });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await sql`DELETE FROM vk_jobs WHERE job_id = ${jobId}`;
  await sql`DELETE FROM vk_seen_jti WHERE job_id = ${jobId}`;
  await sql`DELETE FROM vk_tasks WHERE work_id = ${workId}`;
});

const post = (headers: Record<string, string>, body: unknown) =>
  fetch(`${base}/webhook/callback/${jobId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('callback wire (real HTTP)', () => {
  it('rejects a forged token over the wire → 401', async () => {
    const r = await post({ 'X-Callback-Token': 'WRONG' }, { jti: `w-${suffix}-a`, artifact });
    expect(r.status).toBe(401);
    expect(onDelivery).not.toHaveBeenCalled();
  });

  it('accepts a valid X-Callback-Token, parses the body, and invokes onDelivery → 202', async () => {
    const r = await post({ 'X-Callback-Token': TOKEN }, { jti: `w-${suffix}-b`, artifact });
    expect(r.status).toBe(202);
    expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ jobId }), { artifact });
  });

  it('accepts the token via Authorization: Bearer (wrapper bearer extraction)', async () => {
    onDelivery.mockClear();
    const r = await post({ Authorization: `Bearer ${TOKEN}` }, { jti: `w-${suffix}-c`, artifact });
    expect(r.status).toBe(202);
    expect(onDelivery).toHaveBeenCalledTimes(1);
  });

  it('rejects a replayed jti over the wire → 409', async () => {
    const jti = `w-${suffix}-replay`;
    const first = await post({ 'X-Callback-Token': TOKEN }, { jti, artifact });
    const second = await post({ 'X-Callback-Token': TOKEN }, { jti, artifact });
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
  });
});
