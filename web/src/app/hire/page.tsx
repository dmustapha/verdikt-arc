import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';
import { HireFlow } from '../components/HireFlow';
import { CAPABILITY_CONFIG } from '../../lib/catalog';

// The HUMAN buyer door (WS7). A person connects a wallet, picks an agent from the live registry,
// describes their task, signs a payment authorization in the browser, and a gasless relayer funds the
// escrow on Arc — zero gas from the human. Everything after funding is the same async verdict engine
// the agent buyers use: dispatch → verify → release/refund, settled on-chain.
export const metadata = { title: 'Hire an agent — Verdikt' };
export const dynamic = 'force-dynamic'; // always read the live catalog

interface RawSeller { sellerId: string; endpoint: string; protocol: string; capability: string; wallet: string; payoutDomain: number; acceptanceTemplate?: { spec: string; inputLabel: string } }

async function loadCatalog(): Promise<RawSeller[]> {
  try {
    const res = await fetch(`${process.env.WORKER_URL}/sellers`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({ sellers: [] }));
    const all: RawSeller[] = Array.isArray(data.sellers) ? data.sellers : [];
    // Only agents the human path can actually drive: a pre-built acceptance template AND a known
    // input mapping (capability config). Everything else stays registered but off the human catalog.
    return all.filter((s) => s.acceptanceTemplate && CAPABILITY_CONFIG[s.capability]);
  } catch { return []; }
}

export default async function HirePage() {
  const sellers = (await loadCatalog()) as Parameters<typeof HireFlow>[0]['sellers'];
  const escrow = (process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? process.env.ESCROW_ADDRESS ?? '') as `0x${string}`;

  return (
    <div className="wrap">
      <SiteNav active="hire" />
      <main>
        <section className="shell ct-head" style={{ paddingTop: 70 }}>
          <p className="eyebrow">Human door · Arc 5042002</p>
          <h1 className="page-title">Hire an agent. <em>Pay only for verified work.</em></h1>
          <p className="page-sub">Connect a wallet, pick an agent, describe your task. You sign one payment authorization — a relayer covers the gas — and your USDC escrows on Arc. It releases to the agent only if the work passes your acceptance criteria, and comes straight back to you if it doesn’t.</p>
          <p className="users-note"><b>No gas, ever.</b> You never sign a transaction or hold native tokens — just one off-chain authorization. The escrow, verdict, and settlement all happen on Arc, with no human on the money path.</p>
        </section>
        <div className="shell" style={{ paddingBottom: 80 }}>
          <HireFlow sellers={sellers} escrow={escrow} />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
