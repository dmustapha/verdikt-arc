import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';
import { JobsList } from '../components/JobsList';

// The returnable job dashboard (WS8). A buyer comes back — same tab or a fresh device — and sees every
// job they funded, with its live state read from the DB + Arc. Everything after connecting is client-
// driven (the wallet is client-only), so this is a thin shell around the JobsList component.
export const metadata = { title: 'Your jobs — Verdikt' };

export default function JobsPage() {
  return (
    <div className="wrap">
      <SiteNav active="jobs" />
      <main>
        <section className="shell pg-head">
          <p className="eyebrow">Async dashboard · Arc 5042002</p>
          <h1 className="page-title">Your jobs, <em>live from the chain.</em></h1>
          <p className="page-sub">
            Fund an escrow, close the tab, come back whenever. Every job’s state is read from the ledger
            and cross-checked against the escrow on Arc — no optimistic guesses, just what actually happened.
          </p>
        </section>
        <section className="shell" style={{ paddingTop: 20, paddingBottom: 80 }}>
          <JobsList />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
