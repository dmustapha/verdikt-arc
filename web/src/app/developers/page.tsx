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

        <SiteFooter />
      </main>
    </div>
  );
}
