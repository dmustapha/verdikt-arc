// WS2 Gate B1 — execution route: deterministic on-chain receipt verification.
// The chain reader is INJECTED so the route logic is tested without a live node; the real viem
// reader is exercised by the live proof (prove-execution-route.ts). Money-safety focus: a garbage /
// reverted / absent / criteria-missing tx must produce a FAIL item (→ floor → refund), never a clean
// pass; an unreadable chain abstains (routeError), never releases.
import { describe, it, expect } from 'vitest';
import { runExecutionRoute, type ChainReader, type ExecTx } from '../../src/engine/execution-route.js';
import type { Acceptance, Artifact, ExecutionCriteria } from '../../src/types.js';

const ARC = 5042002;
const ESCROW = '0x96c47a608218E1aFea36E37f9619FB83E24CDF77' as const;
const SENDER = '0x973eA2c67D8d10e8C41e23be283b6CCb31a5686c' as const;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const; // Transfer(a,a,u)
const HASH = '0x6da4a716383dbbf081fc2d529c02e607bede4a2050a81f3f76fff27a867bdd19' as const; // real Arc tx

const okTx: ExecTx = {
  status: 'success', from: SENDER, to: ESCROW, valueWei: 1000n,
  logs: [{ address: ESCROW, topics: [TRANSFER] }],
};

const reader = (tx: ExecTx | null): ChainReader => ({ read: async () => tx });
const throwing: ChainReader = { read: async () => { throw new Error('RPC 503'); } };

function acc(execution?: ExecutionCriteria): Acceptance { return { spec: 'exec', execution }; }
function art(payload: string = HASH): Artifact { return { type: 'execution', payload }; }
const ids = (b: { items: { id: string; status: string }[] }) => b.items.map((i) => i.id);
const failing = (b: { items: { id: string; status: string }[] }) => b.items.filter((i) => i.status === 'fail');

describe('execution route — happy path', () => {
  it('all criteria match → every item passes, no routeError', async () => {
    const b = await runExecutionRoute(
      acc({ chainId: ARC, status: 'success', to: ESCROW, from: SENDER, minValueWei: '500', log: { topic0: TRANSFER, address: ESCROW } }),
      art(), reader(okTx),
    );
    expect(b.routeError).toBeUndefined();
    expect(failing(b)).toHaveLength(0);
    expect(ids(b)).toEqual(['exec:tx_found', 'exec:status', 'exec:to', 'exec:from', 'exec:value', 'exec:log']);
  });

  it('chainId-only criteria → verifies the tx simply succeeded', async () => {
    const b = await runExecutionRoute(acc({ chainId: ARC }), art(), reader(okTx));
    expect(b.routeError).toBeUndefined();
    expect(failing(b)).toHaveLength(0);
    expect(ids(b)).toEqual(['exec:tx_found', 'exec:status']);
  });

  it('case-insensitive address matching', async () => {
    const b = await runExecutionRoute(acc({ chainId: ARC, to: ESCROW.toLowerCase(), from: SENDER.toUpperCase() as `0x${string}` }), art(), reader(okTx));
    expect(failing(b)).toHaveLength(0);
  });
});

describe('execution route — never releases on bad evidence', () => {
  it('reverted status → status FAIL', async () => {
    const b = await runExecutionRoute(acc({ chainId: ARC }), art(), reader({ ...okTx, status: 'reverted' }));
    expect(failing(b).map((i) => i.id)).toContain('exec:status');
  });

  it('no receipt (unmined/absent) → single tx_found FAIL', async () => {
    const b = await runExecutionRoute(acc({ chainId: ARC }), art(), reader(null));
    expect(ids(b)).toEqual(['exec:tx_found']);
    expect(b.items[0].status).toBe('fail');
  });

  it('wrong `to` → to FAIL', async () => {
    const b = await runExecutionRoute(acc({ chainId: ARC, to: '0x000000000000000000000000000000000000dead' }), art(), reader(okTx));
    expect(failing(b).map((i) => i.id)).toContain('exec:to');
  });

  it('from mismatch → from FAIL', async () => {
    const b = await runExecutionRoute(acc({ chainId: ARC, from: '0x000000000000000000000000000000000000beef' }), art(), reader(okTx));
    expect(failing(b).map((i) => i.id)).toContain('exec:from');
  });

  it('value below minimum → value FAIL', async () => {
    const b = await runExecutionRoute(acc({ chainId: ARC, minValueWei: '5000' }), art(), reader(okTx));
    expect(failing(b).map((i) => i.id)).toContain('exec:value');
  });

  it('required event absent → log FAIL', async () => {
    const b = await runExecutionRoute(acc({ chainId: ARC, log: { topic0: '0x' + 'ab'.repeat(32) } }), art(), reader(okTx));
    expect(failing(b).map((i) => i.id)).toContain('exec:log');
  });

  it('event present but at the wrong address → log FAIL', async () => {
    const b = await runExecutionRoute(acc({ chainId: ARC, log: { topic0: TRANSFER, address: '0x000000000000000000000000000000000000dead' } }), art(), reader(okTx));
    expect(failing(b).map((i) => i.id)).toContain('exec:log');
  });

  it('malformed tx hash (garbage artifact) → tx_hash FAIL, chain never read', async () => {
    let touched = false;
    const spy: ChainReader = { read: async () => { touched = true; return okTx; } };
    const b = await runExecutionRoute(acc({ chainId: ARC }), art('not-a-hash'), spy);
    expect(ids(b)).toEqual(['exec:tx_hash']);
    expect(b.items[0].status).toBe('fail');
    expect(touched).toBe(false);
  });
});

describe('execution route — abstain (cannot verify), never release', () => {
  it('unconfigured chain → routeError, no items (→ abstain/refund)', async () => {
    const b = await runExecutionRoute(acc({ chainId: 999999 }), art(), reader(okTx));
    expect(b.routeError).toBeTruthy();
    expect(b.items).toHaveLength(0);
  });

  it('no execution criteria → routeError', async () => {
    const b = await runExecutionRoute(acc(undefined), art(), reader(okTx));
    expect(b.routeError).toBeTruthy();
  });

  it('reader throws (RPC failure) → routeError, never a pass', async () => {
    const b = await runExecutionRoute(acc({ chainId: ARC }), art(), throwing);
    expect(b.routeError).toBeTruthy();
    expect(b.items).toHaveLength(0);
  });
});

describe('execution route — determinism', () => {
  it('same artifact + criteria → identical bundle', async () => {
    const c: ExecutionCriteria = { chainId: ARC, status: 'success', to: ESCROW, log: { topic0: TRANSFER } };
    const a = await runExecutionRoute(acc(c), art(), reader(okTx));
    const b = await runExecutionRoute(acc(c), art(), reader(okTx));
    expect(a).toEqual(b);
  });
});
