import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';
import { TryTabs } from '../components/TryTabs';

// Public "See it work" rail. Two doors to the same verdict engine: run a preset scenario, or bring
// your own task for a REAL Arc settlement (demo-wallet funded, rate-limited, scope-gated worker-side).
// Also replays a specific agent run via ?workId=. Judge-facing proof that Verdikt is a live callable
// rail, not a fixed demo.
export const metadata = { title: 'Try Verdikt: watch a verdict settle on Arc' };

export default async function TryPage({ searchParams }: { searchParams: Promise<{ workId?: string }> }) {
  const { workId } = await searchParams;
  const watching = typeof workId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(workId);
  return (
    <div className="wrap">
      <SiteNav active="try" />
      <main>
        <section className="shell ct-head" style={{ paddingTop: 70 }}>
          <p className="eyebrow">The live court · Arc 5042002</p>
          <h1 className="page-title">{watching ? <>Watching an <em>agent run.</em></> : <>See a verdict <em>settle on Arc.</em></>}</h1>
          <p className="page-sub">Verdikt is a settlement court for agent work: agents run anywhere, their work settles here. Run a preset case or paste your own code, JSON, or a grounded answer, and watch a real escrow fund, judge, and settle on Arc. No wallet of your own needed.</p>
          <p className="users-note"><b>Compute is chain&#8209;agnostic; only the money lands on Arc.</b> Each run funds a fresh escrow, renders an autonomous verdict, and links the on&#8209;chain settlement. Out&#8209;of&#8209;scope input abstains and refunds, never a wrong release.</p>
        </section>
        <div className="shell" style={{ paddingBottom: 80 }}>
          <TryTabs watchWorkId={watching ? workId : undefined} />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
