import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';
import { X402Probe } from './X402Probe';

// For-developers page: the three doors into the same settlement engine (SDK, MCP tool, plain HTTP 402).
// Static content under the shared chrome; only the live-402 probe is interactive (its own client island).
export const metadata = { title: 'Verdikt for developers: call it from your agent' };

const SDK_SNIPPET = `const vk = new Verdikt({ endpoint, rpcUrl, signer })
const { offer } = await vk.payer.createTask({ type, acceptance, amountUsdc, seller })
const verdict  = await vk.seller.submit({ offer, artifact })
// verdict.status → released | refunded | abstained`;

const MCP_TOOLS: { name: string; desc: string }[] = [
  { name: 'verdikt_create_task', desc: 'Payer side: register criteria, escrow USDC on Arc, return a signed offer.' },
  { name: 'verdikt_submit_artifact', desc: 'Seller side: submit work, pay the sub-cent fee, get the verdict (released / refunded / abstained).' },
  { name: 'verdikt_check_escrow', desc: 'Read the on-chain escrow state for a workId. No wallet needed.' },
];

const BAZAAR_SNIPPET = `const client = new x402Client(select)
  .register('eip155:8453', new ExactEvmScheme(signer))
const pay = wrapFetchWithPayment(fetch, client)
const res = await pay('https://verdikt-worker.fly.dev/x402/verify', {
  method: 'POST', body: JSON.stringify({ route, acceptance, artifact }),
})
// 402 -> sign 0.05 USDC (EIP-3009) -> 200 verdict + on-chain settlement tx`;

export default function DevelopersPage() {
  return (
    <div className="wrap">
      <SiteNav active="developers" />
      <main>
        {/* ============ HERO ============ */}
        <section className="shell ct-head" style={{ paddingTop: 70 }}>
          <p className="eyebrow">For developers</p>
          <h1 className="page-title">Call Verdikt from your <em>agent.</em></h1>
          <p className="page-sub">
            Verified escrow in two calls, an MCP tool, or a plain HTTP 402. The engine is the same; pick your door.
          </p>
        </section>

        {/* ============ SDK ============ */}
        <section className="shell dev-sec">
          <p className="section-kicker">The SDK</p>
          <h2 className="section-title">Two calls, one verdict.</h2>
          <pre className="dev-install mono">npm i @verdikt/sdk</pre>
          <pre className="dev-pre mono">{SDK_SNIPPET}</pre>
          <p className="dev-caption">
            createTask escrows USDC on Arc and returns a signed offer. submit verifies the escrow, pays the
            sub-cent fee, and settles.
          </p>
        </section>

        {/* ============ MCP ============ */}
        <section className="shell dev-sec">
          <p className="section-kicker">Model Context Protocol</p>
          <h2 className="section-title">Or add it as an MCP tool</h2>
          <ul className="pf-list dev-mcp">
            {MCP_TOOLS.map((t) => (
              <li key={t.name} className="pf-row">
                <span className="pf-tx mono" style={{ borderBottom: 0 }}>{t.name}</span>
                <span className="pf-meta dev-mcp-desc">{t.desc}</span>
              </li>
            ))}
          </ul>
          <p className="dev-caption">Drop-in for Claude, LangGraph, or any MCP host.</p>
        </section>

        {/* ============ LIVE 402 ============ */}
        <section className="shell dev-sec">
          <p className="section-kicker">The raw rail</p>
          <h2 className="section-title">A real paid rail</h2>
          <p className="dev-caption" style={{ marginTop: 0, marginBottom: 20 }}>
            Call the verdict endpoint with no payment and it answers 402. Pay a fraction of a cent in USDC and
            the verdict settles on-chain. Verdikt runs its own x402 facilitator on Arc, because none existed.
          </p>
          <X402Probe />
        </section>

        {/* ============ x402 BAZAAR (Base mainnet) ============ */}
        <section className="shell dev-sec">
          <p className="section-kicker">x402 Bazaar</p>
          <h2 className="section-title">Or discover and pay on Base mainnet</h2>
          <p className="dev-caption" style={{ marginTop: 0, marginBottom: 20 }}>
            Verdikt is a walk-up paid service on the Coinbase x402 Bazaar. Any agent discovers the terms, pays
            a 0.05 USDC fee over a standard HTTP 402 handshake on Base mainnet, and gets a verdict back. No
            counterparty, no permission, no escrow. Same engine as the SDK and MCP paths.
          </p>
          <pre className="dev-pre mono">{BAZAAR_SNIPPET}</pre>
          <p className="dev-caption">
            Proven live: a paying client settled 0.05 USDC on Base and received a pass verdict.{' '}
            <a href="https://basescan.org/tx/0x57e291ebcb31a3ce9a6ceadfa3991fd503d40073263dfdae1649f36b6c5da2a6" target="_blank" rel="noreferrer">
              Settlement on Basescan
            </a>
            .
          </p>
        </section>

        <SiteFooter />
      </main>
    </div>
  );
}
