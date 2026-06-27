import { getLedger, getExternalCallCount } from '../../lib/db';
import { addressUrl, txUrl } from '../../lib/chains';
import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';

export const dynamic = 'force-dynamic';

const FEE_USDC = 0.001;

// Verdict semantic → token color class (release emerald / abstain amber / else refund red).
const verdictClass = (v: string) => (v === 'pass' ? 'v-release' : v === 'abstain' ? 'v-abstain' : 'v-refund');

export default async function ProofPage() {
  const [rows, externalCalls] = await Promise.all([getLedger(20), getExternalCallCount()]);
  const escrow = process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? '0xa66D1470f8203559Ad1299a13D8a3E5cE989055e';
  const gatewaySpend = (externalCalls * FEE_USDC).toFixed(3);

  return (
    <div className="wrap">
      <SiteNav active="proof" />
      <main>
        <section className="shell pg-head">
          <p className="eyebrow">Everything resolves on-chain</p>
          <h1 className="page-title">Proof.</h1>
          <p className="page-sub">
            VerdiktEscrow on Arc testnet (chainId 5042002). Nothing below is a screenshot. Every
            link opens on the public explorer.
          </p>
        </section>

        <section className="shell" style={{ paddingBottom: 24 }}>
          {/* Escrow contract */}
          <div className="pf-card">
            <div className="pf-label">Escrow contract</div>
            <a className="pf-addr" href={addressUrl(escrow)} target="_blank" rel="noreferrer">
              {escrow} ↗
            </a>
          </div>

          {/* Circle Gateway nanopayment counter — the load-bearing Circle-depth signal,
              given the gold-glow hero treatment so it reads as the focal stat of /proof. */}
          <div className="gw-card">
            <div>
              <div className="gw-kicker">Circle Gateway nanopayments</div>
              <div className="gw-figure">
                {externalCalls} <span className="gw-mult">× ${FEE_USDC.toFixed(3)}</span>
              </div>
            </div>
            <p className="gw-note">
              ≈ <span className="gw-spend">${gatewaySpend} USDC</span> in real sub-cent x402 verdict
              fees. Every worker pays the arbiter through Circle Gateway before a verdict is rendered.
            </p>
          </div>

          {/* Real settlements */}
          <div className="pf-card">
            <div className="pf-label">Real settlements ({rows.length})</div>
            {rows.length === 0 ? (
              <p className="pf-muted">No settled runs yet. Run the seed script.</p>
            ) : (
              <ul className="pf-list">
                {rows.map((r) => (
                  <li key={r.workId} className="pf-row">
                    <span className="pf-meta">
                      <strong className={`pf-verdict ${verdictClass(r.verdict)}`}>{r.verdict}</strong>
                      {' → '}
                      {r.outcome} <span className="pf-amt">({r.amountUsdc} USDC)</span>
                    </span>
                    {r.txHash ? (
                      <a className="pf-tx" href={txUrl(r.txHash)} target="_blank" rel="noreferrer">
                        {r.txHash.slice(0, 16)}… ↗
                      </a>
                    ) : (
                      <span className="pf-muted">pending</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
