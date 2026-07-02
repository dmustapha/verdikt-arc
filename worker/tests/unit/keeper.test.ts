import { describe, it, expect, vi } from 'vitest';
import { pollOnce, expireOnce, guardedInterval } from '../../src/lib/keeper.js';
import type { KeeperDeps } from '../../src/lib/keeper.js';
import type { JobRow } from '../../src/lib/job-store.js';
import type { SellerTransport } from '../../src/lib/transport.js';
import type { Artifact } from '../../src/types.js';

const artifact: Artifact = { type: 'answer', payload: 'the answer' };

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    jobId: 'j1', workId: `0x${'ab'.repeat(32)}`, state: 'AWAITING_DELIVERY',
    sellerUrl: 'https://seller.example.com/x', sellerProtocol: 'a2a', callbackToken: 't',
    resultRef: 'https://seller.example.com/tasks/1', deadline: new Date(Date.now() + 3600_000),
    dispatchAttempts: 1, artifact: null, outcome: null, settleTxHash: null, lastError: null, ...over,
  };
}

function deps(over: Partial<KeeperDeps> = {}): { deps: KeeperDeps; onDelivery: ReturnType<typeof vi.fn>; expireJob: ReturnType<typeof vi.fn>; fetchResult: ReturnType<typeof vi.fn> } {
  const onDelivery = vi.fn().mockResolvedValue(undefined);
  const expireJob = vi.fn().mockResolvedValue({ expired: true });
  const fetchResult = vi.fn().mockResolvedValue(null);
  const transport: SellerTransport = { dispatch: vi.fn(), fetchResult };
  const base: KeeperDeps = {
    engine: { onDelivery, expireJob },
    listByState: vi.fn().mockResolvedValue([]),
    transport,
    now: () => Date.now(),
    ...over,
  };
  return { deps: base, onDelivery, expireJob, fetchResult };
}

describe('keeper — pollOnce (delivery fallback)', () => {
  it('delivers an authoritative artifact for an awaiting job whose seller has the result', async () => {
    const j = job();
    const { deps: d, onDelivery, fetchResult } = deps({ listByState: vi.fn().mockResolvedValue([j]) });
    fetchResult.mockResolvedValue(artifact);
    const n = await pollOnce(d);
    expect(fetchResult).toHaveBeenCalledWith(j);
    expect(onDelivery).toHaveBeenCalledWith(j, { artifact });
    expect(n).toBe(1);
  });

  it('does not deliver when the result is not ready yet (fetchResult null)', async () => {
    const { deps: d, onDelivery } = deps({ listByState: vi.fn().mockResolvedValue([job()]) });
    const n = await pollOnce(d);
    expect(onDelivery).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it('skips awaiting jobs already past their deadline (expiry owns those)', async () => {
    const { deps: d, onDelivery, fetchResult } = deps({ listByState: vi.fn().mockResolvedValue([job({ deadline: new Date(Date.now() - 1000) })]) });
    fetchResult.mockResolvedValue(artifact);
    await pollOnce(d);
    expect(fetchResult).not.toHaveBeenCalled();
    expect(onDelivery).not.toHaveBeenCalled();
  });

  it('isolates a failing seller — one throw does not abort the batch', async () => {
    const good = job({ jobId: 'good' });
    const bad = job({ jobId: 'bad' });
    const fetchResult = vi.fn()
      .mockRejectedValueOnce(new Error('seller 500'))
      .mockResolvedValueOnce(artifact);
    const transport: SellerTransport = { dispatch: vi.fn(), fetchResult };
    const { deps: d, onDelivery } = deps({ listByState: vi.fn().mockResolvedValue([bad, good]), transport });
    const n = await pollOnce(d);
    expect(onDelivery).toHaveBeenCalledTimes(1);
    expect(onDelivery).toHaveBeenCalledWith(good, { artifact });
    expect(n).toBe(1);
  });
});

describe('keeper — expireOnce (no-show)', () => {
  it('expires non-terminal jobs past their deadline', async () => {
    const j = job({ state: 'AWAITING_DELIVERY', deadline: new Date(Date.now() - 1000) });
    const { deps: d, expireJob } = deps({ listByState: vi.fn().mockResolvedValue([j]) });
    const n = await expireOnce(d);
    expect(expireJob).toHaveBeenCalledWith('j1');
    expect(n).toBe(1);
  });

  it('does not expire jobs before their deadline', async () => {
    const { deps: d, expireJob } = deps({ listByState: vi.fn().mockResolvedValue([job({ deadline: new Date(Date.now() + 3600_000) })]) });
    const n = await expireOnce(d);
    expect(expireJob).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it('queries only the non-terminal states', async () => {
    const listByState = vi.fn().mockResolvedValue([]);
    const { deps: d } = deps({ listByState });
    await expireOnce(d);
    const states = listByState.mock.calls[0][0] as string[];
    expect(states).toEqual(expect.arrayContaining(['FUNDED', 'DISPATCHED', 'AWAITING_DELIVERY', 'DELIVERED', 'VERIFYING']));
    expect(states).not.toContain('SETTLED');
    expect(states).not.toContain('EXPIRED');
  });
});

describe('keeper — guardedInterval (no overlapping sweeps)', () => {
  it('skips a tick while the previous run is still in flight', async () => {
    let active = 0, maxConcurrent = 0, calls = 0;
    const gates: (() => void)[] = [];
    const slow = () => { calls++; active++; maxConcurrent = Math.max(maxConcurrent, active); return new Promise<void>((r) => gates.push(() => { active--; r(); })); };
    const g = guardedInterval(slow, 1_000_000); // interval irrelevant; we tick manually
    const first = g.tick();   // enters, blocks on gates[0]
    await g.tick();           // SKIPPED (previous still running)
    await g.tick();           // skipped again
    expect(calls).toBe(1);
    expect(maxConcurrent).toBe(1);
    gates[0](); await first;  // release the first run
    const fourth = g.tick();  // now free → runs again
    expect(calls).toBe(2);
    gates[1](); await fourth; // release the second run
    g.stop();
  });

  it('a throwing sweep never breaks the loop', async () => {
    const g = guardedInterval(async () => { throw new Error('boom'); }, 1_000_000);
    await expect(g.tick()).resolves.toBeUndefined(); // swallowed
    g.stop();
  });
});
