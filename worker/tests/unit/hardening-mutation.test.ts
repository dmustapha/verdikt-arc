// D1: when MUTATION_TEST is on, a passing code bundle gets a mutation-score evidence item, and a
// WEAK suite (low score) sets routeError → the reasoner abstains (refund-to-payer) rather than
// certifying a release on tests that test nothing. Docker is mocked to feed runner + mutate output.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Acceptance, Artifact } from '../../src/types.js';

// The mock returns runner JSON on the first docker run and mutate JSON on the second (entrypoint
// override). We detect the mutate call by the presence of '/mutate.py' in argv.
let runnerOut = '';
let mutateOut = '';
vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    const isMutate = args.includes('/mutate.py');
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', Buffer.from(isMutate ? mutateOut : runnerOut)); child.emit('close', 0, null); });
    return child;
  },
}));

const { runCodeRoute } = await import('../../src/engine/code-route.js');

const acceptance: Acceptance = { spec: 'x', tests: 'def test_x():\n    assert True\n' };
const art: Artifact = { type: 'code', language: 'python', payload: 'print(1)' };
const okPass = JSON.stringify({
  semgrep: { status: 'ok', results: [] }, bandit: { status: 'ok', results: [] },
  pytest: { tests: [{ nodeid: 'solution::test_x', outcome: 'passed' }] },
});

beforeEach(() => { process.env.MUTATION_TEST = 'true'; runnerOut = okPass; });
afterEach(() => { delete process.env.MUTATION_TEST; delete process.env.MUTATION_MIN_SCORE; });

describe('D1 — mutation testing gate', () => {
  it('strong suite (score 1.0) → mutation item passes, no routeError', async () => {
    mutateOut = JSON.stringify({ total: 4, killed: 4, survived: 0, score: 1.0 });
    const b = await runCodeRoute(acceptance, art);
    const m = b.items.find((i) => i.id === 'mutation:score');
    expect(m?.status).toBe('pass');
    expect(b.routeError).toBeUndefined();
  });

  it('weak suite (score 0.0) → abstain (routeError set), never a confident release', async () => {
    mutateOut = JSON.stringify({ total: 4, killed: 0, survived: 4, score: 0.0 });
    const b = await runCodeRoute(acceptance, art);
    expect(b.items.find((i) => i.id === 'mutation:score')?.status).toBe('info');
    expect(b.routeError).toMatch(/too weak to certify/);
  });

  it('skip result → no mutation item, no routeError (advisory, never blocks)', async () => {
    mutateOut = JSON.stringify({ skip: 'baseline tests not passing' });
    const b = await runCodeRoute(acceptance, art);
    expect(b.items.find((i) => i.id === 'mutation:score')).toBeUndefined();
    expect(b.routeError).toBeUndefined();
  });

  it('MUTATION_TEST off → mutation never runs', async () => {
    delete process.env.MUTATION_TEST;
    mutateOut = JSON.stringify({ total: 4, killed: 0, survived: 4, score: 0.0 });
    const b = await runCodeRoute(acceptance, art);
    expect(b.items.find((i) => i.id === 'mutation:score')).toBeUndefined();
    expect(b.routeError).toBeUndefined();
  });

  it('respects MUTATION_MIN_SCORE threshold (0.8): score 0.6 → weak', async () => {
    process.env.MUTATION_MIN_SCORE = '0.8';
    mutateOut = JSON.stringify({ total: 5, killed: 3, survived: 2, score: 0.6 });
    const b = await runCodeRoute(acceptance, art);
    expect(b.routeError).toMatch(/too weak/);
  });
});
