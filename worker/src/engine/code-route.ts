import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
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
    // mkdtemp creates the dir 0700 (owner only). The sandbox image runs as a non-root
    // `runner` user, so on native Linux it cannot traverse a root-owned 0700 bind mount and
    // sees no files (empty evidence -> wrong abstain). macOS Docker Desktop masks this by
    // remapping mount perms. 0755 lets the runner read the read-only workspace.
    await chmod(dir, 0o755);

    let stdout: string;
    try {
      stdout = await runDocker(
        // Defense-in-depth on top of the no-net + memory/pid/cpu caps: drop ALL Linux capabilities
        // (the runner needs none — it runs python as a non-root user) and block privilege escalation
        // (setuid). The /work mount stays read-only; tool output is written under the container's
        // /tmp, so these flags don't constrain the runner.
        ['run', '--rm', '--network=none', '--memory=512m', '--cpus=1', '--pids-limit=128',
         '--cap-drop=ALL', '--security-opt=no-new-privileges',
         '-v', `${dir}:/work:ro`, RUNNER_IMAGE],
        35_000, 8 * 1024 * 1024,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { route: 'code', items: [], routeError: `sandbox error: ${msg.slice(0, 200)}` };
    }

    let parsed: {
      semgrep: { status?: string; results?: SemgrepResult[] } | null;
      bandit: { status?: string; results?: BanditResult[] } | null;
      pytest: { tests?: PytestTest[] } | null;
    };
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return { route: 'code', items: [], routeError: 'sandbox produced unparseable output' };
    }

    // H-B fail-CLOSED: a static scanner that did not run cleanly yields NO static evidence — we must
    // not release on its silence. Mirror the pytest-null contract → routeError → reasoner abstains
    // (refund-to-payer), never a false certify. Only status "ok" carries trustworthy findings.
    if (parsed.semgrep?.status !== 'ok') {
      return { route: 'code', items: [], routeError: 'static scan unavailable (semgrep did not run cleanly)' };
    }
    if (parsed.bandit?.status !== 'ok') {
      return { route: 'code', items: [], routeError: 'static scan unavailable (bandit did not run cleanly)' };
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

    // D1: mutation-test the payer's suite (env-gated; OFF by default to protect demo latency). Only
    // meaningful when the base tests pass and there are no static fails — i.e. a release is on the
    // table purely on "tests pass". A weak suite (low mutation score) means that signal is hollow,
    // so we ABSTAIN (set routeError → refund-to-payer) rather than certify on tests that test nothing.
    if (process.env.MUTATION_TEST === 'true') {
      const testsPass = items.some((i) => i.kind === 'test') && items.every((i) => i.kind !== 'test' || i.status === 'pass');
      const noStaticFail = !items.some((i) => i.kind === 'static' && i.status === 'fail');
      if (testsPass && noStaticFail) {
        const mut = await runMutationPass(dir);
        if (mut && typeof mut.score === 'number') {
          const min = Number(process.env.MUTATION_MIN_SCORE ?? '0.5');
          const weak = mut.score < min;
          items.push({
            id: 'mutation:score', kind: 'test', label: 'test-suite mutation score',
            status: weak ? 'info' : 'pass',
            detail: `mutation score ${mut.score} (killed ${mut.killed}/${mut.total}; min ${min})`,
          });
          if (weak) return { route: 'code', items, routeError: `payer test suite too weak to certify (mutation score ${mut.score} < ${min})` };
        }
      }
    }

    return { route: 'code', items };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Run the bounded mutation tester in the sandbox (entrypoint override → python3 /mutate.py over the
// same read-only /work mount). Returns the parsed score object, or null on skip/error (advisory).
async function runMutationPass(dir: string): Promise<{ score: number; killed: number; total: number } | null> {
  let out: string;
  try {
    out = await runDocker(
      ['run', '--rm', '--network=none', '--memory=512m', '--cpus=1', '--pids-limit=128',
       '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint', 'python3',
       '-v', `${dir}:/work:ro`, RUNNER_IMAGE, '/mutate.py'],
      60_000, 1024 * 1024,
    );
  } catch {
    return null; // mutation is advisory; never block a verdict on its failure
  }
  try {
    const j = JSON.parse(out.trim()) as { score?: number; killed?: number; total?: number; skip?: string };
    if (j.skip || typeof j.score !== 'number') return null;
    return { score: j.score, killed: j.killed ?? 0, total: j.total ?? 0 };
  } catch {
    return null;
  }
}
