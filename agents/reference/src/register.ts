import { buildSkills } from './server.js';

// Register every reference seller with the worker's curated catalog (POST /sellers/register). Each is
// registered as a `webhook` seller pointing at its dispatch endpoint, accepting deliver-then-settle
// terms. The worker health-probes each before listing it. Idempotency is by re-run: registering the
// same endpoint again creates a fresh catalog row (the registry has no dedup — WS4 minor note), so run
// once per deploy.
//
// Env: WORKER_URL, SELLER_PUBLIC_URL (this service's HTTPS base), SELLER_PAYOUT_ADDRESS, SELLER_PAYOUT_DOMAIN.

const WORKER_URL = need('WORKER_URL');
const SELLER_PUBLIC_URL = need('SELLER_PUBLIC_URL').replace(/\/$/, '');
const WALLET = need('SELLER_PAYOUT_ADDRESS');
const PAYOUT_DOMAIN = Number(process.env.SELLER_PAYOUT_DOMAIN ?? '6'); // CCTP: Base = 6 (default payout chain)

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main() {
  const skills = buildSkills();
  console.log(`Registering ${skills.length} reference seller(s) with ${WORKER_URL}\n`);

  for (const skill of skills) {
    const registration = {
      endpoint: `${SELLER_PUBLIC_URL}/${skill.id}/dispatch`,
      protocol: 'webhook' as const,
      capability: skill.capability,
      wallet: WALLET,
      payoutDomain: PAYOUT_DOMAIN,
      termsAccepted: true,
      // WS7: carry the pre-built acceptance into the catalog so the human supplies only their input.
      acceptanceTemplate: skill.acceptanceTemplate,
    };
    const res = await fetch(`${WORKER_URL}/sellers/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registration),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) { console.error(`  ✗ ${skill.id}: ${res.status} ${JSON.stringify(body)}`); continue; }
    console.log(`  ✓ ${skill.id} → sellerId=${body.sellerId} status=${body.status} listed=${body.listed}`);
    console.log(`    endpoint ${registration.endpoint}`);
  }

  const list = await fetch(`${WORKER_URL}/sellers`).then((r) => r.json()).catch(() => null) as { sellers?: unknown[] } | null;
  console.log(`\nCatalog now lists ${list?.sellers?.length ?? '?'} healthy seller(s).`);
}

main().catch((e) => { console.error('registration failed:', e); process.exit(1); });
