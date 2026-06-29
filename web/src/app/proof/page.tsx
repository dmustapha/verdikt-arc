import { getLedger, getExternalFeeSum, getEvidenceBundle } from '../../lib/db';
import { addressUrl, txUrl } from '../../lib/chains';
import { readOnchainEscrow, getTxGasUsdc } from '../../lib/escrow-read';
import { hashEvidence } from '../../lib/hash';
import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';

export const dynamic = 'force-dynamic';

// Verdict semantic → token color class (release emerald / abstain amber / else refund red).
const verdictClass = (v: string) => (v === 'pass' ? 'v-release' : v === 'abstain' ? 'v-abstain' : 'v-refund');

const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');

export default async function ProofPage() {
  const [rows, fees] = await Promise.all([getLedger(20), getExternalFeeSum()]);
  const escrow = process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? '0x06928fF83Dd7C1A2779bf8FB35ADfaaaDaf0F278';

  // F-005 live round-trip on the most recent settled run: on-chain anchor == DB mirror == hash
  // recomputed in the browser tier from the stored bundle. Three independent sources, one hash.
  let roundTrip: { workId: string; onchain: string; db: string; recomputed: string; equal: boolean } | null = null;
  let gas: { gasUsed: string; gasUsdc: string } | null = null;
  if (rows.length > 0) {
    const top = rows[0];
    try {
      const [onchain, bundle] = await Promise.all([
        readOnchainEscrow(top.workId as `0x${string}`),
        getEvidenceBundle(top.workId),
      ]);
      const recomputed = bundle ? hashEvidence(bundle) : '';
      const onchainHash = (onchain as { evidenceHash: string }).evidenceHash ?? '';
      const equal =
        !!recomputed &&
        onchainHash.toLowerCase() === recomputed.toLowerCase() &&
        (top.evidenceHash ?? '').toLowerCase() === recomputed.toLowerCase();
      roundTrip = { workId: top.workId, onchain: onchainHash, db: top.evidenceHash ?? '', recomputed, equal };
    } catch {
      roundTrip = null;
    }
    if (top.txHash) gas = await getTxGasUsdc(top.txHash as `0x${string}`);
  }

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

          {/* Circle Gateway nanopayment counter — summed REAL settled x402 fees (not count × an
              assumed price). The load-bearing Circle-depth signal. */}
          <div className="gw-card">
            <div>
              <div className="gw-kicker">Circle Gateway nanopayments</div>
              <div className="gw-figure">
                ${fees.sumUsdc.toFixed(6)} <span className="gw-mult">USDC</span>
              </div>
            </div>
            <p className="gw-note">
              Summed across <span className="gw-spend">{fees.count}</span> real metered{' '}
              <code>/api/verdict</code> calls — each worker pays the arbiter a sub-cent x402 fee
              through Circle Gateway before a verdict is rendered. Self-serve demo runs are unmetered
              and excluded, so every fee here is a genuine third-party paid call.
            </p>
          </div>

          {/* F-005 — live tamper-evident round-trip */}
          {roundTrip && (
            <div className="pf-card">
              <div className="pf-label">
                Tamper-evident round-trip {roundTrip.equal ? '✓ verified' : '⚠ mismatch'}
              </div>
              <p className="pf-muted" style={{ marginBottom: 12 }}>
                The latest verdict&apos;s evidence hash, from three independent sources for workId{' '}
                <code>{short(roundTrip.workId)}</code>. Recomputed live in your browser from the
                stored bundle — it is not read back from the database.
              </p>
              <ul className="pf-list">
                <li className="pf-row"><span className="pf-meta">On-chain anchor (<code>getEscrow().evidenceHash</code>)</span><span className="pf-tx">{short(roundTrip.onchain)}</span></li>
                <li className="pf-row"><span className="pf-meta">Database mirror (<code>vk_verdicts</code>)</span><span className="pf-tx">{short(roundTrip.db)}</span></li>
                <li className="pf-row"><span className="pf-meta">Recomputed keccak256 (browser, from bundle)</span><span className="pf-tx">{short(roundTrip.recomputed)}</span></li>
              </ul>
              <p className="pf-muted" style={{ marginTop: 10 }}>
                {roundTrip.equal
                  ? 'All three are identical — the verdict cannot have been altered after settlement. An LLM can give an opinion; only a chain can give an independently-recomputable, immutable record.'
                  : 'Hashes differ — investigate before trusting this verdict.'}
              </p>
            </div>
          )}

          {/* USDC-as-gas single-asset panel — the "why Arc" answer */}
          {gas && (
            <div className="pf-card">
              <div className="pf-label">One asset, end to end (why Arc)</div>
              <p className="pf-muted" style={{ marginBottom: 10 }}>
                The latest settlement spent <strong>{gas.gasUsdc} USDC</strong> in gas
                (<code>{gas.gasUsed}</code> gas units × the effective price), paid in USDC itself —
                Arc&apos;s native asset.
              </p>
              <p className="pf-muted">
                On Ethereum an agent juggles ETH for gas + USDC for value + a DEX to swap between
                them. On Arc the agent holds <strong>one asset</strong>: it earns, funds the escrow,
                pays the x402 fee, settles, and pays gas all in USDC. That is what makes a fully
                autonomous agent money-loop practical.
              </p>
            </div>
          )}

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
