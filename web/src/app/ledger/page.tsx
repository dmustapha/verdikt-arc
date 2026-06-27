import { getLedger } from '../../lib/db';
import { LedgerTable } from '../components/LedgerTable';
import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';

export const dynamic = 'force-dynamic';

export default async function LedgerPage() {
  const rows = await getLedger();
  return (
    <div className="wrap">
      <SiteNav active="ledger" />
      <main>
        <section className="shell pg-head">
          <p className="eyebrow">On-chain record</p>
          <h1 className="page-title">The verdict ledger.</h1>
          <p className="page-sub">
            Every row is a real settlement on Arc with the verdict and evidence hash anchored on-chain.
          </p>
        </section>
        <section className="shell" style={{ paddingTop: 26, paddingBottom: 24 }}>
          <LedgerTable rows={rows} />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
