import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Acceptance, Artifact, EvidenceBundle, EvidenceItem } from '../types.js';

const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? 'verdikt-runner';

// DEV-002: run docker with stdin IGNORED. execFile()'s default stdin pipe makes the docker CLI
// die with SIGPIPE here (empty stdout, KILLED), so we use spawn with stdio[0]='ignore'.
// Behaviour-equivalent to the arch's execFile call (35s timeout, 8MB cap, routeError on failure).
function runDocker(args: string[], timeoutMs: number, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > maxBytes) { killed = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`timeout/oversize (signal ${signal})`));
      // runner.sh always prints JSON and exits 0; a non-zero exit means docker itself failed.
      if (code !== 0 && out.trim() === '') return reject(new Error(`docker exited ${code}: ${err.slice(0, 200)}`));
      resolve(out);
    });
  });
}
// DEV-001: on Linux hosts os.tmpdir()=/tmp (Docker-shared); on macOS Docker Desktop it is
// /var/folders/** which is NOT in the default bind-mount allow-list, so `docker run -v` fails.
// SANDBOX_TMP lets the host pin a Docker-shareable base (e.g. /tmp) without editing arch behavior.
const SANDBOX_TMP = process.env.SANDBOX_TMP ?? tmpdir();

interface SemgrepResult { check_id: string; path: string; start: { line: number }; extra: { message: string; severity: string } }
interface BanditResult { test_id: string; issue_text: string; line_number: number; issue_severity: string }
interface PytestTest { nodeid: string; outcome: string }

export async function runCodeRoute(acceptance: Acceptance, artifact: Artifact): Promise<EvidenceBundle> {
  if (!acceptance.tests || acceptance.tests.trim() === '') {
    return { route: 'code', items: [], routeError: 'payer provided no tests' };
  }

  const dir = await mkdtemp(join(SANDBOX_TMP, 'verdikt-'));
  try {
    // Payer's tests + the worker's solution land in the same workspace; pytest imports the solution.
    await writeFile(join(dir, 'payer_test.py'), acceptance.tests, 'utf8');
    await writeFile(join(dir, 'solution.py'), artifact.payload, 'utf8');

    let stdout: string;
    try {
      stdout = await runDocker(
        ['run', '--rm', '--network=none', '--memory=512m', '--cpus=1', '--pids-limit=128',
         '-v', `${dir}:/work:ro`, RUNNER_IMAGE],
        35_000, 8 * 1024 * 1024,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { route: 'code', items: [], routeError: `sandbox error: ${msg.slice(0, 200)}` };
    }

    let parsed: { semgrep: { results?: SemgrepResult[] } | null; bandit: { results?: BanditResult[] } | null; pytest: { tests?: PytestTest[] } | null };
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return { route: 'code', items: [], routeError: 'sandbox produced unparseable output' };
    }

    const items: EvidenceItem[] = [];

    // Payer tests (compile + behavior). No tests collected = the artifact did not run.
    const tests = parsed.pytest?.tests ?? [];
    if (tests.length === 0) {
      return { route: 'code', items: [], routeError: 'no tests collected (artifact failed to import/compile)' };
    }
    for (const t of tests) {
      const name = t.nodeid.split('::').pop() ?? t.nodeid;
      items.push({
        id: `test:${name}`,
        kind: 'test',
        label: name,
        status: t.outcome === 'passed' ? 'pass' : 'fail',
        detail: `payer test ${t.outcome}`,
        ref: t.nodeid,
      });
    }

    // Semgrep findings (each is a fail signal).
    for (const r of parsed.semgrep?.results ?? []) {
      items.push({
        id: `semgrep:${r.check_id}`,
        kind: 'static',
        label: r.check_id,
        status: 'fail',
        detail: `${r.extra.severity}: ${r.extra.message}`,
        ref: `${r.path}:${r.start.line}`,
      });
    }

    // Bandit findings (B608 = SQL injection).
    for (const r of parsed.bandit?.results ?? []) {
      items.push({
        id: `bandit:${r.test_id}`,
        kind: 'static',
        label: r.test_id,
        status: 'fail',
        detail: `${r.issue_severity}: ${r.issue_text}`,
        ref: `solution.py:${r.line_number}`,
      });
    }

    return { route: 'code', items };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
