'use client';

import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';

// Route error boundary: if the ledger DB query throws (e.g. transient connection
// loss), show a clean recoverable message instead of a white-screen / error overlay.
export default function LedgerError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="wrap">
      <SiteNav active="ledger" />
      <main>
        <section className="shell pg-head">
          <p className="eyebrow">On-chain record</p>
          <h1 className="page-title">The verdict ledger.</h1>
        </section>
        <section className="shell" style={{ paddingBottom: 24 }}>
          <div className="pf-card" style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--text-dim)', fontSize: 14, margin: '0 0 16px' }}>
              Couldn&apos;t load the ledger right now.
            </p>
            <button className="btn btn-primary" onClick={reset}>
              Retry
            </button>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
