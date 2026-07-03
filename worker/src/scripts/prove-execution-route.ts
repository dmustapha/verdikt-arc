// WS2 Gate B1 — prove the EXECUTION route against a REAL on-chain receipt (Arc), using the default
// viem reader (no injection). Read-only: no funds, no gas. Proves three things end-to-end:
//   1. correct criteria over a real successful tx  → all evidence items pass (no fail)
//   2. wrong `to` over the SAME real tx            → to FAILS (it truly read + compared chain data)
//   3. a non-existent tx hash                      → tx_found FAILS (real "no receipt")
//
// Run:  set -a; . ./.env; set +a;  npx tsx worker/src/scripts/prove-execution-route.ts
import { runExecutionRoute } from '../engine/execution-route.js';
import type { Acceptance, Artifact } from '../types.js';

const ARC = 5042002;
const ESCROW = (process.env.ESCROW_ADDRESS ?? '0x96c47a608218E1aFea36E37f9619FB83E24CDF77') as `0x${string}`;
// The real settlePartial tx from the tier proof — to = escrow, status success.
const REAL_TX = '0x6da4a716383dbbf081fc2d529c02e607bede4a2050a81f3f76fff27a867bdd19';
const FAKE_TX = '0x' + 'de'.repeat(32);

function acc(execution: Acceptance['execution']): Acceptance { return { spec: 'exec proof', execution }; }
function art(payload: string): Artifact { return { type: 'execution', payload }; }
const fails = (b: { items: { id: string; status: string }[] }) => b.items.filter((i) => i.status === 'fail').map((i) => i.id);

async function main() {
  console.log(`\nWS2 execution-route live proof — chain ${ARC}, escrow ${ESCROW}\n`);

  // 1. Correct criteria over the real tx → PASS (no fail items, no routeError).
  const good = await runExecutionRoute(acc({ chainId: ARC, status: 'success', to: ESCROW }), art(REAL_TX));
  console.log(`  [good]  items=${good.items.map((i) => `${i.id}:${i.status}`).join(' ')} routeError=${good.routeError ?? 'none'}`);
  if (good.routeError) throw new Error(`unexpected routeError: ${good.routeError}`);
  if (fails(good).length) throw new Error(`expected all-pass, got fails: ${fails(good).join(', ')}`);

  // 2. Wrong `to` over the SAME real tx → `to` FAILS (proves a genuine on-chain comparison).
  const wrongTo = await runExecutionRoute(acc({ chainId: ARC, to: '0x000000000000000000000000000000000000dEaD' }), art(REAL_TX));
  console.log(`  [wrong-to] fails=${fails(wrongTo).join(', ') || 'NONE'}`);
  if (!fails(wrongTo).includes('exec:to')) throw new Error('expected exec:to to fail on wrong `to`');

  // 3. Non-existent tx → tx_found FAILS (real "no receipt", never a release).
  const absent = await runExecutionRoute(acc({ chainId: ARC }), art(FAKE_TX));
  console.log(`  [absent] items=${absent.items.map((i) => `${i.id}:${i.status}`).join(' ') || 'none'} routeError=${absent.routeError ?? 'none'}`);
  if (absent.routeError) throw new Error(`absent tx should FAIL (unsubstantiated), not abstain: ${absent.routeError}`);
  if (!fails(absent).includes('exec:tx_found')) throw new Error('expected exec:tx_found to fail on a non-existent tx');

  console.log(`\n  ✅ execution route verified against LIVE Arc chain data`);
  console.log(`    real tx read: https://testnet.arcscan.app/tx/${REAL_TX}`);
}

main().catch((e) => { console.error('EXECUTION PROOF FAILED:', e); process.exit(1); });
