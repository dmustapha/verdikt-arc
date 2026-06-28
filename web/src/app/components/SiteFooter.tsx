const ESCROW_URL = 'https://testnet.arcscan.app/address/0x8140FD0D07dB598fc04A284Ee5210C835a911Ae5';

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
