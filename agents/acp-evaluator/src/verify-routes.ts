// Phase 0.5 — LOCAL verification of the route-flexible ACP evaluator BEFORE any live mainnet run.
//
// It exercises the exact path a live job takes, minus ACP settlement:
//   SERVICE_SPECS[route] → buildJobDescription() (what rides on-chain) → JSON.parse + extract (what the
//   evaluator reads back off job.description) → evaluateSubmitted() → live worker /api/evaluate → mock
//   session.complete()/reject(). No escrow, no USDC, no gas.
//
// For every route it asserts BOTH directions: the `valid` deliverable → pass → complete, the `invalid`
// deliverable → fail → reject. If all 5 routes settle both ways here, the on-chain live-job run is safe.
//
// Run: WORKER_URL=https://verdikt-worker.fly.dev npx tsx agents/acp-evaluator/src/verify-routes.ts
import { evaluateSubmitted } from './judge.js';
import type { EvalSession, VerdictRoute } from './judge.js';
import { SERVICE_SPECS, ROUTES, buildJobDescription } from './service-spec.js';

const WORKER = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';

function mockSession(): EvalSession & { action: 'complete' | 'reject' | null } {
  const s = {
    action: null as 'complete' | 'reject' | null,
    async complete() { s.action = 'complete'; },
    async reject() { s.action = 'reject'; },
  };
  return s;
}

// Mirror of acp-client.ts extractSpec: read the route + acceptance back off the on-chain job description.
function extractSpec(description: string): { route: VerdictRoute; acceptance: Record<string, unknown>; artifactExtra: Record<string, unknown> } {
  const obj = JSON.parse(description) as Record<string, unknown>;
  if (typeof obj.route !== 'string' || !ROUTES.includes(obj.route as VerdictRoute) || !obj.acceptance) {
    throw new Error(`description did not round-trip a valid route: ${description.slice(0, 80)}`);
  }
  return {
    route: obj.route as VerdictRoute,
    acceptance: obj.acceptance as Record<string, unknown>,
    artifactExtra: (obj.artifactExtra as Record<string, unknown>) ?? {},
  };
}

async function main(): Promise<void> {
  console.log(`\nPhase 0.5 route-flexible verification — live engine at ${WORKER}/api/evaluate`);
  console.log('Each route: on-chain description → extract → judge → mock settle, both valid + invalid.\n');

  let ok = 0;
  let total = 0;
  const rows: string[] = [];

  for (const route of ROUTES) {
    const spec = SERVICE_SPECS[route];
    const parsed = extractSpec(buildJobDescription(spec)); // round-trip the on-chain contract
    if (parsed.route !== route) throw new Error(`route mismatch: ${route} → ${parsed.route}`);

    for (const [kind, deliverable, wantApprove] of [
      ['valid', spec.valid, true] as const,
      ['invalid', spec.invalid, false] as const,
    ]) {
      total++;
      const session = mockSession();
      let verdict = '?', approve = false, err = '';
      try {
        const r = await evaluateSubmitted(
          { deliverable, route: parsed.route, acceptance: parsed.acceptance, artifactExtra: parsed.artifactExtra },
          session,
        );
        verdict = r.verdict; approve = r.approve;
      } catch (e) { err = e instanceof Error ? e.message : String(e); }

      const wantAction = wantApprove ? 'complete' : 'reject';
      const pass = !err && approve === wantApprove && session.action === wantAction;
      if (pass) ok++;
      console.log(
        `▸ ${route.padEnd(12)} ${kind.padEnd(8)} → ${(err ? 'ERROR' : verdict.toUpperCase()).padEnd(8)} approve=${approve} session.${session.action ?? 'none'}  ${pass ? '✅' : `❌ ${err || `expected ${wantAction}`}`}`,
      );
      rows.push(`| ${route} | ${kind} | ${wantAction} | ${err ? 'ERROR' : verdict} | ${pass ? '✓' : '✗'} |`);
    }
  }

  // Missing-deliverable safety: must reject, never false-approve.
  total++;
  const empty = mockSession();
  const rEmpty = await evaluateSubmitted({ deliverable: null, route: 'tool_output', acceptance: SERVICE_SPECS.tool_output.acceptance }, empty);
  const emptyPass = !rEmpty.approve && empty.action === 'reject';
  if (emptyPass) ok++;
  console.log(`▸ ${'(missing)'.padEnd(12)} ${'none'.padEnd(8)} → ${'—'.padEnd(8)} approve=${rEmpty.approve} session.${empty.action ?? 'none'}  ${emptyPass ? '✅' : '❌ expected reject'}`);
  rows.push(`| (missing) | none | reject | ${rEmpty.verdict} | ${emptyPass ? '✓' : '✗'} |`);

  console.log('\n── Markdown summary ───────────────────────────────────────────────────');
  console.log('| Route | Deliverable | Expected | Verdikt | Match |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) console.log(r);
  console.log(`\n${ok}/${total} cases settled as expected via the route-flexible path.`);
  process.exit(ok === total ? 0 : 1);
}

main().catch((e) => { console.error('[verify-routes] fatal:', e instanceof Error ? e.message : e); process.exit(1); });
