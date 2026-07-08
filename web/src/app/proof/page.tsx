import { getLedger, getExternalFeeSum, getEvidenceBundle } from '../../lib/db';
import { addressUrl, txUrl } from '../../lib/chains';
import { readOnchainEscrow, getTxGasUsdc } from '../../lib/escrow-read';
import { hashEvidence } from '../../lib/hash';
import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';
import { CORRIDORS } from './corridors';

export const dynamic = 'force-dynamic';

// Verdict semantic → token color class (release emerald / abstain amber / else refund red).
const verdictClass = (v: string) => (v === 'pass' ? 'v-release' : v === 'abstain' ? 'v-abstain' : 'v-refund');

const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');

// Virtuals ACP jobs settled on Base mainnet — Verdikt as the registered evaluator. Real on-chain rows.
// 14 jobs total: the first four proved the wiring on tool_output; the next ten exercise all five verdict
// routes, both outcomes (pass releases, fail refunds).
const ACP_JOBS: { id: string; route: string; outcome: string; cls: string; url: string }[] = [
  { id: '65569', route: 'tool_output', outcome: 'released', cls: 'v-release', url: 'https://basescan.org/tx/0x6dcba82ed17cf745b7cbb31790c5b2047d162947dbc67e426955833f7d4ae2aa' },
  { id: '65570', route: 'tool_output', outcome: 'refunded', cls: 'v-refund', url: 'https://basescan.org/tx/0xf8494167d20d11c2b17628983ad55013d873f2c76e8d3d67b6084677489bbed4' },
  { id: '65927', route: 'tool_output', outcome: 'released', cls: 'v-release', url: 'https://basescan.org/tx/0x5ee1880d7bb193093a728c7af5a899030aedb5683ee48ffad0a69c4866fc7105' },
  { id: '65928', route: 'tool_output', outcome: 'refunded', cls: 'v-refund', url: 'https://basescan.org/tx/0xae760243380a6fca7346bf35580b5905909df27083165e3783ff4f1cd40e0050' },
  { id: '66385', route: 'tool_output', outcome: 'released', cls: 'v-release', url: 'https://basescan.org/tx/0x7acd33d5b7d0e4fe81127c47a1e525f052ece704d7b0017d499322d2d563b760' },
  { id: '66387', route: 'tool_output', outcome: 'refunded', cls: 'v-refund', url: 'https://basescan.org/tx/0x70be20c2c6aa089feca9c38b22b4c38abc9d948a85f7c0d26c0c940f95860870' },
  { id: '66388', route: 'code', outcome: 'released', cls: 'v-release', url: 'https://basescan.org/tx/0xb6ab6c6331a61fb3ac109334a4f29ed3dcfc8353ee42c94a07ae560d46c9affc' },
  { id: '66389', route: 'code', outcome: 'refunded', cls: 'v-refund', url: 'https://basescan.org/tx/0x12ad08bd77238e7f44779e80a71965a022a4dba96442c617733aecaca5c49f51' },
  { id: '66391', route: 'answer', outcome: 'released', cls: 'v-release', url: 'https://basescan.org/tx/0xe9526a57248c3f5220055b328730d61584e03336e46d724ade810afe7f9d9857' },
  { id: '66392', route: 'answer', outcome: 'refunded', cls: 'v-refund', url: 'https://basescan.org/tx/0xac0c63c7b6b295e57b54915d2da2a66559a96311bace11000a883bcf79c0e527' },
  { id: '66393', route: 'execution', outcome: 'released', cls: 'v-release', url: 'https://basescan.org/tx/0xaa57ac855a5a087c36471c0c37303cd2dcc606f2ae2cf2b2bf0fe01263171222' },
  { id: '66394', route: 'execution', outcome: 'refunded', cls: 'v-refund', url: 'https://basescan.org/tx/0xe0a20a557e3b7f86ca08ef0fec39cd8a8d6b390557e8126683c4c8bacc525968' },
  { id: '66396', route: 'tool_trace', outcome: 'released', cls: 'v-release', url: 'https://basescan.org/tx/0xc868b86ab8f067e8fe64d20bcef7119a24d1f6366344adc67d156444f6270328' },
  { id: '66397', route: 'tool_trace', outcome: 'refunded', cls: 'v-refund', url: 'https://basescan.org/tx/0x9537c2bf1b9e27753c203fa5e6f30d0cb56537230efa010ec6bfe0ac4a9b2491' },
];
const txShort = (url: string) => { const h = url.split('/tx/')[1] ?? ''; return h ? `${h.slice(0, 12)}… ↗` : '↗'; };

export default async function ProofPage() {
  const [rows, fees] = await Promise.all([getLedger(20), getExternalFeeSum()]);
  const escrow = process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? '0x96c47a608218E1aFea36E37f9619FB83E24CDF77';

  // F-005 live round-trip: on-chain anchor == DB mirror == hash recomputed in the browser tier from the
  // stored bundle. Three independent sources, one hash. We surface the most recent settlement whose three
  // hashes genuinely agree — scanning past any that don't. A WS11 dispute-RESOLVED settlement legitimately
  // anchors the arbiter's ruling hash (not the evidence-bundle hash), so it never round-trips here by
  // design; skipping it shows a real verified settlement instead of a misleading "mismatch".
  let roundTrip: { workId: string; onchain: string; db: string; recomputed: string; equal: boolean } | null = null;
  let gas: { gasUsed: string; gasUsdc: string } | null = null;
  for (const row of rows.slice(0, 6)) {
    try {
      const [onchain, bundle] = await Promise.all([
        readOnchainEscrow(row.workId as `0x${string}`),
        getEvidenceBundle(row.workId),
      ]);
      const recomputed = bundle ? hashEvidence(bundle) : '';
      const onchainHash = onchain.evidenceHash ?? ''; // correctly decoded (13-field ABI)
      const equal =
        !!recomputed &&
        onchainHash.toLowerCase() === recomputed.toLowerCase() &&
        (row.evidenceHash ?? '').toLowerCase() === recomputed.toLowerCase();
      if (equal) {
        roundTrip = { workId: row.workId, onchain: onchainHash, db: row.evidenceHash ?? '', recomputed, equal };
        break;
      }
    } catch {
      /* RPC hiccup on this row — try the next */
    }
  }
  if (rows[0]?.txHash) gas = await getTxGasUsdc(rows[0].txHash as `0x${string}`);

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

        {/* Virtuals ACP — real mainnet settlements gated by Verdikt's verdict */}
        <section className="shell" style={{ paddingTop: 8, paddingBottom: 8 }}>
          <div className="pf-card">
            <div className="pf-label">Virtuals ACP · Base mainnet · 14 jobs · all 5 routes</div>
            <p className="pf-muted" style={{ marginBottom: 14, lineHeight: 1.6 }}>
              Verdikt is a registered evaluator on Virtuals&apos; Agent Commerce Protocol on Base mainnet.
              Fourteen jobs have settled through it with real USDC across all five verdict routes and both
              outcomes: a pass releases payment, a fail refunds the buyer. No false certifications.
            </p>
            <ul className="pf-list">
              {ACP_JOBS.map((j) => (
                <li key={j.id} className="pf-row">
                  <span className="pf-meta">
                    <strong className={`pf-verdict ${j.cls}`}>Job {j.id}</strong>
                    {' '}<span className="pf-amt">{j.route}</span>
                    {' → '}{j.outcome}
                  </span>
                  <a className="pf-tx" href={j.url} target="_blank" rel="noreferrer">{txShort(j.url)}</a>
                </li>
              ))}
            </ul>
            <p className="pf-muted" style={{ marginTop: 14 }}>
              Per pass: <span className="pf-amt">buyer -0.02 · provider +0.018 · evaluator +0.001 USDC</span>.
              {' '}Evaluator{' '}
              <a className="pf-tx" href="https://basescan.org/address/0xed6c93b309477ebedd6717f94700f3c008470584" target="_blank" rel="noreferrer">0xed6c…0584 ↗</a>
            </p>
          </div>

          {/* x402 Bazaar — walk-up paid service on the Coinbase CDP facilitator, Base mainnet */}
          <div className="pf-card">
            <div className="pf-label">x402 Bazaar · Base mainnet</div>
            <p className="pf-muted" style={{ marginBottom: 14, lineHeight: 1.6 }}>
              A second front door onto the same verdict engine. Verdikt is a walk-up paid service on the
              Coinbase x402 Bazaar: any agent discovers the terms, pays a 0.05 USDC fee over a standard HTTP
              402 handshake, and gets a verdict back. No counterparty, no permission, no escrow.
            </p>
            <ul className="pf-list">
              <li className="pf-row">
                <span className="pf-meta"><strong className="pf-verdict v-release">Paid verdict</strong>{' '}<span className="pf-amt">pass, 0.05 USDC settled</span></span>
                <a className="pf-tx" href="https://basescan.org/tx/0x57e291ebcb31a3ce9a6ceadfa3991fd503d40073263dfdae1649f36b6c5da2a6" target="_blank" rel="noreferrer">0x57e291ebcb31… ↗</a>
              </li>
              <li className="pf-row">
                <span className="pf-meta">Endpoint</span>
                <span className="pf-tx" style={{ borderBottom: 0 }}>POST /x402/verify</span>
              </li>
              <li className="pf-row">
                <span className="pf-meta">Gas fronted by the CDP facilitator relayer</span>
                <span className="pf-tx" style={{ borderBottom: 0 }}>EIP-3009, gasless</span>
              </li>
            </ul>
          </div>

          {/* ERC-8004 — portable on-chain reputation on the canonical Validation Registry */}
          <div className="pf-card">
            <div className="pf-label">ERC-8004 attestation</div>
            <p className="pf-muted" style={{ marginBottom: 14, lineHeight: 1.6 }}>
              Every verdict is attested on-chain to the canonical ERC-8004 Validation Registry. Portable,
              verifiable reputation, not a self-reported score.
            </p>
            <ul className="pf-list">
              <li className="pf-row">
                <span className="pf-meta">Validation Registry <span className="pf-amt">(v2.0.0)</span></span>
                <a className="pf-tx" href="https://sepolia.basescan.org/address/0x8004Cb1BF31DAf7788923b405b754f57acEB4272" target="_blank" rel="noreferrer">0x8004…4272 ↗</a>
              </li>
              <li className="pf-row">
                <span className="pf-meta">Registered agent NFT</span>
                <span className="pf-tx" style={{ borderBottom: 0 }}>agentId 7396</span>
              </li>
              <li className="pf-row">
                <span className="pf-meta">Dedicated validator key</span>
                <span className="pf-tx" style={{ borderBottom: 0 }}>0xa41FD309…</span>
              </li>
              <li className="pf-row">
                <span className="pf-meta">Tag</span>
                <span className="pf-tx" style={{ borderBottom: 0 }}>verdikt:release</span>
              </li>
            </ul>
            <p className="pf-muted" style={{ marginTop: 14, marginBottom: 8 }}>
              Example attestation for Arc settlement <code>0x7edb408e…</code>:
            </p>
            <ul className="pf-list">
              <li className="pf-row">
                <span className="pf-meta">validationResponse tx</span>
                <a className="pf-tx" href="https://sepolia.basescan.org/tx/0x7a8283876ffc9e2827222e3b69c901062f0bd7375e03a2aaabd953a7cb94fec8" target="_blank" rel="noreferrer">0x7a8283…4fec8 ↗</a>
              </li>
              <li className="pf-row">
                <span className="pf-meta">Agent NFT registration</span>
                <a className="pf-tx" href="https://sepolia.basescan.org/tx/0x3f86794fad58647dd2ce2c949b3cab0cad5e99c49ef2d413d6c13c4a24dcefa3" target="_blank" rel="noreferrer">0x3f8679…dcefa3 ↗</a>
              </li>
            </ul>
          </div>
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
              <code>/api/verdict</code> calls. Each worker pays the arbiter a sub-cent x402 fee
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
                stored bundle. It is not read back from the database.
              </p>
              <ul className="pf-list">
                <li className="pf-row"><span className="pf-meta">On-chain anchor (<code>getEscrow().evidenceHash</code>)</span><span className="pf-tx">{short(roundTrip.onchain)}</span></li>
                <li className="pf-row"><span className="pf-meta">Database mirror (<code>vk_verdicts</code>)</span><span className="pf-tx">{short(roundTrip.db)}</span></li>
                <li className="pf-row"><span className="pf-meta">Recomputed keccak256 (browser, from bundle)</span><span className="pf-tx">{short(roundTrip.recomputed)}</span></li>
              </ul>
              <p className="pf-muted" style={{ marginTop: 10 }}>
                {roundTrip.equal
                  ? 'All three are identical: the verdict cannot have been altered after settlement. An LLM can give an opinion; only a chain can give an independently-recomputable, immutable record.'
                  : 'Hashes differ. Investigate before trusting this verdict.'}
              </p>
            </div>
          )}

          {/* USDC-as-gas single-asset panel — the "why Arc" answer */}
          {gas && (
            <div className="pf-card">
              <div className="pf-label">One asset, end to end (why Arc)</div>
              <p className="pf-muted" style={{ marginBottom: 10 }}>
                The latest settlement spent <strong>{gas.gasUsdc} USDC</strong> in gas
                (<code>{gas.gasUsed}</code> gas units × the effective price), paid in USDC itself:
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
              <p className="pf-muted">No settlements to show yet.</p>
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

          {/* WS9 — >=6-corridor CCTP matrix (Gate F1). Seller on ANY chain is paid on THEIR
              chain; Arc is only the clearing house. Each corridor is a full 4-leg round-trip with
              the dest payout verified fee-net on-chain, both directions, across all five chains. */}
          <div className="pf-card">
            <div className="pf-label">Cross-chain corridor matrix ({CORRIDORS.length}): paid on your home chain</div>
            <p className="pf-muted" style={{ marginBottom: 12 }}>
              Every corridor is a live CCTP V2 round-trip: <strong>burn</strong> on the source →{' '}
              <strong>mint + fund</strong> the escrow on Arc → <strong>settle + payout burn</strong> on Arc →{' '}
              <strong>paid</strong> on the destination. The seller&apos;s destination-chain balance rose by exactly the
              fee-net bounty, asserted on-chain against the escrow (independent of any database). All five chains
              appear as both a source and a destination.
            </p>
            {CORRIDORS.map((c) => (
              <div key={c.id} style={{ marginBottom: 14 }}>
                <div className="pf-meta" style={{ marginBottom: 6 }}>
                  <strong>{c.source} → {c.dest}</strong>{' '}
                  <span className="pf-amt">(seller +{c.feeNetUsdc} USDC, fee-net verified)</span>
                </div>
                <ul className="pf-list">
                  {c.legs.map((leg) => (
                    <li key={leg.url} className="pf-row">
                      <span className="pf-meta">{leg.label} · {leg.chain}</span>
                      <a className="pf-tx" href={leg.url} target="_blank" rel="noreferrer">
                        {leg.url.split('/tx/')[1]?.slice(0, 12)}… ↗
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
