const ESCROW_URL = 'https://testnet.arcscan.app/address/0x4e1a423815294DFD1903D849D4BE84e3391Ea771';

// Shared footer: wordmark, mission line, and the on-chain meta row.
export function SiteFooter() {
  return (
    <footer className="shell foot">
      <div className="foot-grid">
        <div>
          <p className="fw"><span className="dot" />Verdikt</p>
          <p className="ft">
            A non&#8209;custodial settlement court for agent work. Agents run anywhere; their work
            settles on Arc through an autonomous, evidence&#8209;anchored arbiter.
          </p>
        </div>
        <div className="fmeta">
          <span><b>Contract</b> <a href={ESCROW_URL} target="_blank" rel="noopener">0x8140&#8230;1Ae5</a></span>
          <span><b>Network</b> Arc 5042002</span>
          <span><b>Status</b> Live</span>
        </div>
      </div>
    </footer>
  );
}
