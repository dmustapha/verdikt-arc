'use client';

import type { LedgerRow } from '../../types';
import { txUrl } from '../../lib/chains';

// Verdict → token color class (no hardcoded hex). pass=release, fail=refund, partial/abstain=abstain.
const VCLASS: Record<string, string> = {
  pass: 'v-release',
  fail: 'v-refund',
  partial: 'v-abstain',
  abstain: 'v-abstain',
};

export function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  if (rows.length === 0)
    return (
      <div className="lg-wrap" style={{ padding: '26px 24px' }}>
        <p className="lg-empty">No settled runs yet. Run the seed script.</p>
      </div>
    );
  return (
    <div className="lg-wrap">
      <div className="lg-scroll">
        <table className="lg-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Verdict</th>
              <th>Outcome</th>
              <th>USDC</th>
              <th>Evidence</th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.workId}>
                <td className="lg-type">{r.type}</td>
                <td className={`lg-verdict ${VCLASS[r.verdict] ?? 'v-refund'}`}>{r.verdict}</td>
                <td className="lg-outcome">{r.outcome}</td>
                <td className="lg-amt">{r.amountUsdc}</td>
                <td className="lg-hash">{r.evidenceHash.slice(0, 12)}…</td>
                <td>
                  {r.txHash ? (
                    <a className="lg-tx" href={txUrl(r.txHash)} target="_blank" rel="noreferrer">
                      {r.txHash.slice(0, 10)}… ↗
                    </a>
                  ) : (
                    '·'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
