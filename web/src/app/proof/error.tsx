'use client';

import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';

// Route error boundary: if a proof DB query throws (ledger or external-call count),
// degrade to a clean recoverable message instead of a white-screen / error overlay.
export default function ProofError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="wrap">
      <SiteNav active="proof" />
      <main>
        <section className="shell pg-head">
          <p className="eyebrow">Everything resolves on-chain</p>
          <h1 className="page-title">Proof.</h1>
        </section>
        <section className="shell" style={{ paddingBottom: 24 }}>
          <div className="pf-card" style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--text-dim)', fontSize: 14, margin: '0 0 16px' }}>
              Couldn&apos;t load on-chain proof right now.
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
