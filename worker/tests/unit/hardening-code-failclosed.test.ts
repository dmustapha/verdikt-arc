// Hardening (H-B): a static scanner that did not run cleanly must NOT yield zero findings that let
// bad code release. The runner emits {status:"ok"|"error"} per tool; code-route treats any non-ok
// scanner as routeError → the reasoner abstains (refund-to-payer). We mock the docker spawn so we
// can feed crafted runner JSON (a real OOM/crash is impractical to force in CI).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Acceptance, Artifact } from '../../src/types.js';

let dockerStdout = '';
vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(dockerStdout));
      child.emit('close', 0, null);
    });
    return child;
  },
}));

const { runCodeRoute } = await import('../../src/engine/code-route.js');

const acceptance: Acceptance = { spec: 'x', tests: 'def test_x():\n    assert True\n' };
const art: Artifact = { type: 'code', language: 'python', payload: 'print(1)' };
const okTests = { tests: [{ nodeid: 'solution::test_x', outcome: 'passed' }] };

beforeEach(() => { dockerStdout = ''; });

describe('H-B — scanner fail-CLOSED', () => {
  it('semgrep status=error → routeError, zero items (abstain, never release)', async () => {
    dockerStdout = JSON.stringify({ semgrep: { status: 'error', rc: 2 }, bandit: { status: 'ok', results: [] }, pytest: okTests });
    const b = await runCodeRoute(acceptance, art);
    expect(b.items).toHaveLength(0);
    expect(b.routeError).toMatch(/static scan unavailable \(semgrep/);
  });

  it('bandit OOM (rc 137) → routeError, zero items', async () => {
    dockerStdout = JSON.stringify({ semgrep: { status: 'ok', results: [] }, bandit: { status: 'error', rc: 137 }, pytest: okTests });
    const b = await runCodeRoute(acceptance, art);
    expect(b.items).toHaveLength(0);
    expect(b.routeError).toMatch(/static scan unavailable \(bandit/);
  });

  it('both scanners ok with a real bandit finding → static item present, no routeError', async () => {
    dockerStdout = JSON.stringify({
      semgrep: { status: 'ok', results: [] },
      bandit: { status: 'ok', results: [{ test_id: 'B608', issue_text: 'SQLi', line_number: 3, issue_severity: 'HIGH' }] },
      pytest: okTests,
    });
    const b = await runCodeRoute(acceptance, art);
    expect(b.routeError).toBeUndefined();
    expect(b.items.some((i) => i.kind === 'static' && i.id === 'bandit:B608' && i.status === 'fail')).toBe(true);
  });

  it('both scanners ok but no tests collected → existing routeError contract preserved', async () => {
    dockerStdout = JSON.stringify({ semgrep: { status: 'ok', results: [] }, bandit: { status: 'ok', results: [] }, pytest: { tests: [] } });
    const b = await runCodeRoute(acceptance, art);
    expect(b.routeError).toMatch(/no tests collected/);
  });

  it('legacy/unparseable scanner section (no status field) → treated as not-ok → routeError', async () => {
    dockerStdout = JSON.stringify({ semgrep: { results: [] }, bandit: { status: 'ok', results: [] }, pytest: okTests });
    const b = await runCodeRoute(acceptance, art);
    expect(b.routeError).toMatch(/static scan unavailable \(semgrep/);
  });
});
