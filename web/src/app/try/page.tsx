import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';
import { TryIt } from '../components/TryIt';

// Public "Try it" rail: a stranger brings their OWN task and gets a REAL Arc settlement. The escrow
// is funded by the demo wallet (rate-limited, scope-gated worker-side). This is the hands-on, judge-
// facing proof that Verdikt is a live callable rail, not a fixed demo.
export const metadata = { title: 'Try Verdikt — bring your own task' };

export default function TryPage() {
  return (
    <div className="wrap">
      <SiteNav active="try" />
      <main>
        <section className="shell ct-head" style={{ paddingTop: 70 }}>
          <p className="eyebrow">Public rail · Arc 5042002</p>
          <h1 className="page-title">Bring your own task. <em>Settle it on Arc.</em></h1>
          <p className="page-sub">Verdikt is a settlement court for agent work: agents run anywhere, their work settles here. Paste real code, JSON, or an answer with its ground truth and watch a real escrow fund, judge, and settle on Arc — no wallet of your own needed.</p>
          <p className="users-note"><b>Compute is chain&#8209;agnostic; only the money lands on Arc.</b> Each run funds a fresh escrow on the demo wallet, renders an autonomous verdict, and links the on&#8209;chain settlement. Out&#8209;of&#8209;scope input abstains and refunds — never a wrong release.</p>
        </section>
        <div className="shell" style={{ paddingBottom: 80 }}>
          <TryIt />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
