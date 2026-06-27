const ESCROW_URL = 'https://testnet.arcscan.app/address/0xa66D1470f8203559Ad1299a13D8a3E5cE989055e';

// Shared footer: wordmark, mission line, and the on-chain meta row.
export function SiteFooter() {
  return (
    <footer className="shell foot">
      <div className="foot-grid">
        <div>
          <p className="fw"><span className="dot" />Verdikt</p>
          <p className="ft">
            The clearing house where code is judged. On&#8209;chain escrow and an autonomous
            evidence&#8209;anchored arbiter, settling USDC between agents on Arc.
          </p>
        </div>
        <div className="fmeta">
          <span><b>Contract</b> <a href={ESCROW_URL} target="_blank" rel="noopener">0xa66D&#8230;055e</a></span>
          <span><b>Network</b> Arc 5042002</span>
          <span><b>Status</b> Live</span>
        </div>
      </div>
    </footer>
  );
}
