'use client';

import { useState } from 'react';

interface Probe {
  status: number;
  network: string | null;
  amount: string | null;
  feeUsdc: string | number | null;
  payTo: string | null;
}

// Calls the server-side proxy /api/x402-probe (which pokes the live verdict endpoint with no payment).
// The worker answers 402 with an x402 challenge; we render the real network / amount / payTo it returns.
export function X402Probe() {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [data, setData] = useState<Probe | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function probe() {
    setState('loading');
    setError(null);
    try {
      const res = await fetch('/api/x402-probe', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (body.error) {
        setError(String(body.error));
        setState('error');
        return;
      }
      setData(body as Probe);
      setState('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }

  return (
    <div className="dev-probe">
      <button type="button" className="btn btn-primary" onClick={probe} disabled={state === 'loading'}>
        {state === 'loading' ? 'Probing the live rail…' : 'Probe the live 402'}
      </button>

      {state === 'error' && (
        <p className="dev-probe-err" role="status" aria-live="polite">
          Could not reach the rail right now: {error}
        </p>
      )}

      {state === 'done' && data && (
        <div className="pf-card dev-probe-out" role="status" aria-live="polite">
          <div className="pf-label">HTTP {data.status} · payment required</div>
          <ul className="pf-list">
            <li className="pf-row">
              <span className="pf-meta">network</span>
              <span className="pf-tx" style={{ borderBottom: 0 }}>{data.network ?? 'eip155:5042002'}</span>
            </li>
            <li className="pf-row">
              <span className="pf-meta">amount</span>
              <span className="pf-tx" style={{ borderBottom: 0 }}>
                {data.amount ?? '1000'} <span className="pf-amt">(0.001 USDC)</span>
              </span>
            </li>
            {data.payTo && (
              <li className="pf-row">
                <span className="pf-meta">payTo</span>
                <span className="pf-tx" style={{ borderBottom: 0, wordBreak: 'break-all' }}>{data.payTo}</span>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
