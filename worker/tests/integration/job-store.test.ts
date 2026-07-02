import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@vercel/postgres';
import { insertTask } from '../../src/lib/db.js';
import {
  createJob, getJob, getJobByWorkId,
  markDispatched, markAwaiting, claimDelivery, markVerifying, markSettled, markExpired,
  recordDispatchAttempt, listByState, recordSeenJti, setResultRef,
} from '../../src/lib/job-store.js';
import type { Task, Artifact } from '../../src/types.js';

// Integration: hits the live Neon Postgres loaded from root .env by setup-env.ts. Each run uses a
// unique suffix so reruns never collide; rows are cleaned up in afterAll.
const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const ids: { work: `0x${string}`; job: string }[] = [];

function mkWork(tag: string): `0x${string}` {
  // deterministic 32-byte hex derived from tag+suffix, unique per test
  const hex = Buffer.from(`${tag}${suffix}`).toString('hex').padEnd(64, '0').slice(0, 64);
  return `0x${hex}` as `0x${string}`;
}

async function seedTask(work: `0x${string}`): Promise<Task> {
  const t: Task = { workId: work, type: 'code', payer: `0x${'11'.repeat(20)}`, worker: `0x${'22'.repeat(20)}`, amountUsdc: 0.1, acceptance: { spec: 's' } };
  await insertTask(t);
  return t;
}

const artifact: Artifact = { type: 'code', language: 'python', payload: 'print(1)' };
const deadline = new Date(Date.now() + 3600_000);

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL required for job-store integration tests');
});

afterAll(async () => {
  for (const { work, job } of ids) {
    await sql`DELETE FROM vk_jobs WHERE job_id = ${job}`;
    await sql`DELETE FROM vk_seen_jti WHERE job_id = ${job}`;
    await sql`DELETE FROM vk_tasks WHERE work_id = ${work}`;
  }
});

describe('job-store — create + read', () => {
  it('round-trips a created job', async () => {
    const work = mkWork('create'); const job = `job-${suffix}-create`; ids.push({ work, job });
    await seedTask(work);
    await createJob({ jobId: job, workId: work, sellerUrl: 'https://seller.example/deliver', sellerProtocol: 'webhook', callbackToken: 'tok-123', resultRef: null, deadline });

    const row = await getJob(job);
    expect(row).not.toBeNull();
    expect(row!.workId).toBe(work);
    expect(row!.state).toBe('FUNDED');
    expect(row!.sellerUrl).toBe('https://seller.example/deliver');
    expect(row!.sellerProtocol).toBe('webhook');
    expect(row!.callbackToken).toBe('tok-123');
    expect(row!.dispatchAttempts).toBe(0);

    const byWork = await getJobByWorkId(work);
    expect(byWork!.jobId).toBe(job);
  });

  it('returns null for an unknown job', async () => {
    expect(await getJob('nope')).toBeNull();
  });
});

describe('job-store — atomic transitions', () => {
  it('markDispatched moves FUNDED→DISPATCHED exactly once', async () => {
    const work = mkWork('disp'); const job = `job-${suffix}-disp`; ids.push({ work, job });
    await seedTask(work);
    await createJob({ jobId: job, workId: work, sellerUrl: 'https://s/x', sellerProtocol: 'webhook', callbackToken: 't', resultRef: null, deadline });

    expect(await markDispatched(job)).toBe(true);
    expect((await getJob(job))!.state).toBe('DISPATCHED');
    expect(await markDispatched(job)).toBe(false); // no longer FUNDED
  });

  it('claimDelivery is single-shot and stores the artifact', async () => {
    const work = mkWork('deliv'); const job = `job-${suffix}-deliv`; ids.push({ work, job });
    await seedTask(work);
    await createJob({ jobId: job, workId: work, sellerUrl: 'https://s/x', sellerProtocol: 'webhook', callbackToken: 't', resultRef: null, deadline });
    await markDispatched(job); await markAwaiting(job);

    expect(await claimDelivery(job, artifact)).toBe(true);
    const row = await getJob(job);
    expect(row!.state).toBe('DELIVERED');
    expect(row!.artifact).toEqual(artifact);
    expect(await claimDelivery(job, artifact)).toBe(false); // duplicate delivery rejected
  });

  it('claimDelivery accepts a delivery straight from FUNDED (fast-callback race)', async () => {
    const work = mkWork('fastcb'); const job = `job-${suffix}-fastcb`; ids.push({ work, job });
    await seedTask(work);
    await createJob({ jobId: job, workId: work, sellerUrl: 'https://s/x', sellerProtocol: 'webhook', callbackToken: 't', resultRef: null, deadline });
    // No markDispatched — simulate a callback that beat the DISPATCHED write.
    expect(await claimDelivery(job, artifact)).toBe(true);
    expect((await getJob(job))!.state).toBe('DELIVERED');
  });

  it('drives the full happy path to SETTLED', async () => {
    const work = mkWork('happy'); const job = `job-${suffix}-happy`; ids.push({ work, job });
    await seedTask(work);
    await createJob({ jobId: job, workId: work, sellerUrl: 'https://s/x', sellerProtocol: 'webhook', callbackToken: 't', resultRef: null, deadline });
    await markDispatched(job); await markAwaiting(job); await claimDelivery(job, artifact);
    expect(await markVerifying(job)).toBe(true);
    expect(await markSettled(job, 'release', '0xtxrelease')).toBe(true);
    const row = await getJob(job);
    expect(row!.state).toBe('SETTLED');
    expect(row!.outcome).toBe('release');
    expect(row!.settleTxHash).toBe('0xtxrelease');
  });

  it('an abstain verdict lands in ABSTAINED', async () => {
    const work = mkWork('abst'); const job = `job-${suffix}-abst`; ids.push({ work, job });
    await seedTask(work);
    await createJob({ jobId: job, workId: work, sellerUrl: 'https://s/x', sellerProtocol: 'webhook', callbackToken: 't', resultRef: null, deadline });
    await markDispatched(job); await markAwaiting(job); await claimDelivery(job, artifact); await markVerifying(job);
    expect(await markSettled(job, 'abstain', '0xtxabstain')).toBe(true);
    expect((await getJob(job))!.state).toBe('ABSTAINED');
  });

  it('markExpired works from a non-terminal state and refuses from terminal', async () => {
    const work = mkWork('exp'); const job = `job-${suffix}-exp`; ids.push({ work, job });
    await seedTask(work);
    await createJob({ jobId: job, workId: work, sellerUrl: 'https://s/x', sellerProtocol: 'webhook', callbackToken: 't', resultRef: null, deadline });
    await markDispatched(job); await markAwaiting(job);
    expect(await markExpired(job, '0xtxexpire')).toBe(true);
    expect((await getJob(job))!.state).toBe('EXPIRED');
    expect(await markExpired(job, '0xtxexpire2')).toBe(false); // already terminal
  });

  it('setResultRef persists the seller-assigned reference once (A2A task id / x402 job URL)', async () => {
    const work = mkWork('rref'); const job = `job-${suffix}-rref`; ids.push({ work, job });
    await seedTask(work);
    await createJob({ jobId: job, workId: work, sellerUrl: 'https://s/x', sellerProtocol: 'a2a', callbackToken: 't', resultRef: null, deadline });
    await setResultRef(job, 'task-abc');
    expect((await getJob(job))!.resultRef).toBe('task-abc');
    // Idempotent: a late second discovery does not clobber the first (only sets when NULL).
    await setResultRef(job, 'task-different');
    expect((await getJob(job))!.resultRef).toBe('task-abc');
  });

  it('recordDispatchAttempt increments the counter and stores the error', async () => {
    const work = mkWork('att'); const job = `job-${suffix}-att`; ids.push({ work, job });
    await seedTask(work);
    await createJob({ jobId: job, workId: work, sellerUrl: 'https://s/x', sellerProtocol: 'webhook', callbackToken: 't', resultRef: null, deadline });
    await recordDispatchAttempt(job, 'ECONNREFUSED');
    await recordDispatchAttempt(job, 'ETIMEDOUT');
    const row = await getJob(job);
    expect(row!.dispatchAttempts).toBe(2);
    expect(row!.lastError).toBe('ETIMEDOUT');
  });
});

describe('job-store — jti dedupe + listByState', () => {
  it('recordSeenJti accepts a fresh jti and rejects a replay', async () => {
    const work = mkWork('jti'); const job = `job-${suffix}-jti`; ids.push({ work, job });
    await seedTask(work);
    await createJob({ jobId: job, workId: work, sellerUrl: 'https://s/x', sellerProtocol: 'webhook', callbackToken: 't', resultRef: null, deadline });
    const jti = `jti-${suffix}`;
    expect(await recordSeenJti(jti, job)).toBe(true);
    expect(await recordSeenJti(jti, job)).toBe(false); // replay
  });

  it('scopes jti dedupe per-job — the same jti value on two jobs does not collide', async () => {
    const workA = mkWork('jtiA'); const jobA = `job-${suffix}-jtiA`; ids.push({ work: workA, job: jobA });
    const workB = mkWork('jtiB'); const jobB = `job-${suffix}-jtiB`; ids.push({ work: workB, job: jobB });
    await seedTask(workA); await seedTask(workB);
    await createJob({ jobId: jobA, workId: workA, sellerUrl: 'https://s/x', sellerProtocol: 'webhook', callbackToken: 't', resultRef: null, deadline });
    await createJob({ jobId: jobB, workId: workB, sellerUrl: 'https://s/x', sellerProtocol: 'webhook', callbackToken: 't', resultRef: null, deadline });
    const shared = `counter-1-${suffix}`;
    expect(await recordSeenJti(shared, jobA)).toBe(true);
    expect(await recordSeenJti(shared, jobB)).toBe(true);  // different job — NOT a replay
    expect(await recordSeenJti(shared, jobA)).toBe(false); // same job — replay
  });

  it('listByState returns jobs in the requested states', async () => {
    const work = mkWork('list'); const job = `job-${suffix}-list`; ids.push({ work, job });
    await seedTask(work);
    await createJob({ jobId: job, workId: work, sellerUrl: 'https://s/x', sellerProtocol: 'webhook', callbackToken: 't', resultRef: null, deadline });
    await markDispatched(job); await markAwaiting(job);
    const awaiting = await listByState(['AWAITING_DELIVERY']);
    expect(awaiting.some((j: { jobId: string }) => j.jobId === job)).toBe(true);
    const funded = await listByState(['FUNDED']);
    expect(funded.some((j: { jobId: string }) => j.jobId === job)).toBe(false);
  });
});
