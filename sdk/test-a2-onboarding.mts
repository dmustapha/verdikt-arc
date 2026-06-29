// Live A2 proof: SDK Gateway onboarding. Run: tsx --env-file=../.env test-a2-onboarding.mts
import { Verdikt, OnboardingError } from './dist/index.js';
import { generatePrivateKey } from 'viem/accounts';

const endpoint = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const rpcUrl = process.env.ARC_RPC_URL;

function mk(pk: `0x${string}`) {
  return new Verdikt({ endpoint, rpcUrl, signer: { privateKey: pk } });
}

async function main() {
  // ── 1. FRESH key → clear OnboardingError (wallet has no USDC) ──────────────
  console.log('\n[1] fresh seller key → expect clear OnboardingError');
  const fresh = mk(generatePrivateKey());
  const b0 = await fresh.seller.gatewayBalance();
  console.log('    fresh balances:', b0);
  try {
    await fresh.seller.ensureOnboarded({ minUsdc: 0.01, depositUsdc: 0.05 });
    console.log('    ✗ expected OnboardingError but none thrown');
  } catch (e) {
    const ok = e instanceof OnboardingError;
    console.log(`    ${ok ? '✓' : '✗'} ${e instanceof Error ? e.message : e}`);
  }

  // ── 2. FUNDED seller key → read, idempotent no-op, real deposit ────────────
  const sellerKey = (process.env.WORKER_GATEWAY_KEY ?? '').trim() as `0x${string}`;
  if (!sellerKey) { console.log('\n[2] WORKER_GATEWAY_KEY not set — skipping funded path'); return; }
  console.log('\n[2] funded seller key (WORKER_GATEWAY_KEY)');
  const seller = mk(sellerKey);
  const before = await seller.seller.gatewayBalance();
  console.log('    before:', before);

  // idempotent: already has gateway balance → ensureOnboarded is a no-op
  const idem = await seller.seller.ensureOnboarded({ minUsdc: 0.001 });
  console.log('    ensureOnboarded(min 0.001) →', idem, idem.deposited ? '' : '(idempotent no-op ✓)');

  // real deposit ONLY if the wallet can cover it (otherwise prove the clear error instead)
  if (before.walletUsdc >= 0.01) {
    console.log('    depositFee(0.01) → real approve+deposit on Arc…');
    const dep = await seller.seller.depositFee(0.01);
    console.log('    deposit result:', dep);
    const after = await seller.seller.gatewayBalance();
    console.log('    after:', after, after.availableUsdc > before.availableUsdc ? '(available increased ✓)' : '(no increase ✗)');
  } else {
    console.log(`    wallet has ${before.walletUsdc} USDC (<0.01) — skipping real deposit; clear-error path already proven in [1]`);
  }
}

main().then(() => console.log('\n[done]')).catch((e) => { console.error('FATAL', e); process.exit(1); });
