'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { addressUrl } from '../../lib/chains';
import { stateLabel, stateTone, readJobIds } from '../../lib/job-state';

// The returnable job LIST (WS8). A buyer connects their wallet and sees every job they funded, read
// live from the DB via the worker (joined on the on-chain payer). Also accepts a pasted jobId for a
// wallet-free return, and surfaces recently-dispatched jobIds from localStorage as a convenience — the
// authoritative list is always the payer query, never the cache.
interface JobRow {
  jobId: string; workId: string; state: string; outcome: string | null;
  sellerProtocol: string; settleTxHash: string | null; deadline: string;
}

export function JobsList() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();

  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localIds, setLocalIds] = useState<string[]>([]);
  const [lookup, setLookup] = useState('');

  useEffect(() => { setLocalIds(readJobIds()); }, []);

  const load = useCallback(async (payer: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/jobs?payer=${encodeURIComponent(payer)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'could not load jobs');
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setJobs(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (isConnected && address) void load(address); else setJobs(null); }, [isConnected, address, load]);

  const injected = connectors.find((c) => c.id === 'injected' || c.type === 'injected') ?? connectors[0];

  return (
    <>
      <section className="hire-wallet">
        {!isConnected ? (
          <div className="hw-connect">
            <div>
              <p className="hw-title">Connect the wallet you paid with</p>
              <p className="hw-sub">Your jobs are looked up by the address that funded them, read live from Arc + the ledger.</p>
            </div>
            <div className="hw-btns">
              {injected && <button className="btn btn-primary" onClick={() => connect({ connector: injected })} disabled={connecting}>Connect wallet</button>}
            </div>
          </div>
        ) : (
          <div className="hw-connected">
            <div className="hw-acct">
              <span className="hw-dot" />
              <a href={addressUrl(address!)} target="_blank" rel="noreferrer" className="mono">{address!.slice(0, 6)}…{address!.slice(-4)}</a>
              <span className="hw-bal mono">{jobs === null ? '—' : `${jobs.length} job${jobs.length === 1 ? '' : 's'}`}</span>
            </div>
            <div className="hw-btns">
              <button className="btn btn-ghost" onClick={() => address && load(address)} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
              <button className="btn btn-ghost" onClick={() => disconnect()}>Disconnect</button>
            </div>
          </div>
        )}
      </section>

      {/* Wallet-free return: open any job directly by its id (the link HireFlow hands you). */}
      <section className="jobs-lookup">
        <p className="section-kicker">Have a job link?</p>
        <div className="jl-row">
          <input className="mono" placeholder="paste a jobId (UUID)" value={lookup} spellCheck={false}
            onChange={(e) => setLookup(e.target.value.trim())} />
          <Link className="btn btn-ghost" href={lookup ? `/jobs/${encodeURIComponent(lookup)}` : '#'} aria-disabled={!lookup}
            onClick={(e) => { if (!lookup) e.preventDefault(); }}>Open →</Link>
        </div>
      </section>

      {error && <p className="hf-error">{error}</p>}

      {/* Payer-scoped list (source of truth). */}
      {jobs !== null && (
        <section className="jobs-table-wrap">
          <p className="section-kicker">Your jobs</p>
          {jobs.length === 0 ? (
            <p className="hc-empty">No jobs for this wallet yet. Hire an agent to start one.</p>
          ) : (
            <table className="jobs-table">
              <thead><tr><th>Job</th><th>Agent</th><th>State</th><th>Deadline</th><th /></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.jobId}>
                    <td className="mono">{j.jobId.slice(0, 8)}…</td>
                    <td className="mono">{j.sellerProtocol}</td>
                    <td><span className={`chip chip-${stateTone(j.state, j.outcome)}`}>{stateLabel(j.state, j.outcome)}</span></td>
                    <td className="mono jt-dim">{new Date(j.deadline).toLocaleString()}</td>
                    <td><Link className="jt-link" href={`/jobs/${j.jobId}`}>Track →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* localStorage convenience: recently-dispatched jobs from THIS browser, even before connecting. */}
      {!isConnected && localIds.length > 0 && (
        <section className="jobs-table-wrap">
          <p className="section-kicker">Recent on this device</p>
          <ul className="jobs-recent">
            {localIds.slice(0, 8).map((id) => (
              <li key={id}><Link className="mono jt-link" href={`/jobs/${id}`}>{id.slice(0, 12)}… →</Link></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
