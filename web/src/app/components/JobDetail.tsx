'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { txUrl, addressUrl } from '../../lib/chains';
import { LIFECYCLE, reachedStep, isTerminal, stateLabel, stateTone } from '../../lib/job-state';

const WORKER_BASE = process.env.NEXT_PUBLIC_WORKER_URL ?? '';
const STEP_LABEL = ['Escrowed', 'Awaiting delivery', 'Delivered', 'Verifying', 'Settled'];

interface Detail {
  jobId: string; workId: `0x${string}`; state: string; sellerProtocol: string;
  dispatchAttempts: number; outcome: string | null; settleTxHash: string | null;
  fundTxHash: string | null; deadline: string; lastError: string | null;
  artifact: unknown;
  chain: { status: number; statusLabel: string; outcome: number | null; outcomeLabel: string | null;
    amountUsdc: string; feeUsdc: string; deadline: string } | null;
  verdict: { verdict: string; verdictCode: number; confidence: number | null; route: string;
    rationale: string | null; abstainReason: string | null; evidenceHash: string; citedEvidence: unknown } | null;
}

// The returnable job DETAIL (WS8). Fetches the enriched worker view (DB state + independent on-chain
// escrow cross-check + verdict + proof tx hashes), then opens the live SSE stream so an OPEN tab
// updates in real time. Everything shown is a read of a source of truth — the on-chain panel is read
// straight from Arc, so the page can never render an optimistic lie.
export function JobDetail({ jobId, escrow }: { jobId: string; escrow: `0x${string}` }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<string | null>(null); // last SSE job_state, overrides d.state
  const esRef = useRef<EventSource | null>(null);

  const fetchDetail = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'job not found');
      setD(data as Detail); setError(null);
      return data as Detail;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
  }, [jobId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const detail = await fetchDetail();
      if (cancelled || !detail?.workId) return;
      // Live updates for an open tab. job_state advances the chip/timeline; a terminal state or a
      // settled/verdict event triggers a re-fetch so the on-chain panel + result view reconcile.
      const es = new EventSource(`${WORKER_BASE}/api/stream/${detail.workId}`);
      esRef.current = es;
      es.onmessage = (ev) => {
        let msg: { type: string; data?: Record<string, unknown> };
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'job_state' && typeof msg.data?.state === 'string') {
          const s = msg.data.state as string;
          setLiveState(s);
          if (isTerminal(s)) void fetchDetail(); // pull the settled outcome + verdict from truth
        }
        if (msg.type === 'settled' || msg.type === 'verdict') void fetchDetail();
      };
      es.onerror = () => { /* SSE auto-reconnects; the fetched detail remains authoritative */ };
    })();
    return () => { cancelled = true; esRef.current?.close(); };
  }, [fetchDetail]);

  if (error) return (
    <div className="jd-empty">
      <p className="hf-error">{error}</p>
      <Link className="btn btn-ghost" href="/jobs">← All jobs</Link>
    </div>
  );
  if (!d) return <div className="jd-empty"><p className="hc-empty">Loading job…</p></div>;

  // The live SSE state takes precedence over the fetched state, but the fetched detail carries the
  // authoritative outcome (from the settle tx). Never let a stale liveState hide a terminal outcome.
  const state = isTerminal(d.state) ? d.state : (liveState ?? d.state);
  const outcome = d.outcome ?? d.chain?.outcomeLabel ?? null;
  // The furthest step the job TRULY reached (0..3) — evidence-gated so a no-show EXPIRED job never
  // shows Delivered/Verifying as completed. The terminal outcome still renders at step 4.
  const reached = reachedStep(state, !!d.artifact, !!d.verdict);
  const settleTx = d.settleTxHash;

  return (
    <>
      <div className="jd-top">
        <Link className="jd-back" href="/jobs">← All jobs</Link>
        <span className={`chip chip-${stateTone(state, outcome)}`}>{stateLabel(state, outcome)}</span>
      </div>

      <p className="jd-id mono">job {d.jobId}</p>
      <p className="jd-work mono jt-dim">workId {d.workId.slice(0, 18)}…</p>

      {/* Truthful lifecycle timeline. */}
      <ol className="jd-timeline" aria-label="Job lifecycle">
        {LIFECYCLE.map((_, i) => {
          const isTermStep = i === 4 && isTerminal(state);
          // Steps 0..3: "done" once the job reached past them. Step 4 is the terminal marker: it counts
          // as done (fully-connected line) ONLY when the job truly progressed all the way (reached===4,
          // e.g. SETTLED/ABSTAINED); for a no-show (reached<4) its connector stays grey, honestly showing
          // the skipped middle, while data-tone still colours the terminal dot.
          const done = i < reached || (isTermStep && reached >= 4);
          const here = i === reached && !isTermStep;
          const tone = isTermStep ? stateTone(state, outcome) : undefined;
          return (
            <li key={i} className={`jd-step${done ? ' done' : ''}${here ? ' here' : ''}${isTermStep ? ' term' : ''}`} data-tone={tone}>
              <span className="jd-dot" aria-hidden="true" />
              <span className="jd-step-label">{isTermStep ? stateLabel(state, outcome) : STEP_LABEL[i]}</span>
            </li>
          );
        })}
      </ol>

      <div className="jd-grid">
        {/* On-chain escrow — read straight from Arc (the independent truth). */}
        <div className="jd-panel">
          <p className="jd-panel-h">On-chain escrow <span className="jt-dim">· read from Arc</span></p>
          {d.chain ? (
            <dl className="jd-dl">
              <div><dt>Status</dt><dd className="mono">{d.chain.statusLabel}</dd></div>
              {d.chain.outcomeLabel && <div><dt>Outcome</dt><dd className="mono">{d.chain.outcomeLabel}</dd></div>}
              <div><dt>Escrowed</dt><dd className="mono">{d.chain.amountUsdc} USDC</dd></div>
              <div><dt>Verify fee</dt><dd className="mono">{d.chain.feeUsdc} USDC</dd></div>
              <div><dt>Deadline</dt><dd className="mono jt-dim">{new Date(d.chain.deadline).toLocaleString()}</dd></div>
              <div><dt>Escrow</dt><dd><a href={addressUrl(escrow)} target="_blank" rel="noreferrer" className="mono">{escrow.slice(0, 10)}… ↗</a></dd></div>
            </dl>
          ) : <p className="jt-dim">Chain read unavailable right now — DB state shown above.</p>}
        </div>

        {/* Result view — the recorded verdict + the seller's delivered artifact. */}
        <div className="jd-panel">
          <p className="jd-panel-h">The verdict</p>
          {d.verdict ? (
            <>
              <p className="jd-verdict" data-v={d.verdict.verdict}>{d.verdict.verdict.toUpperCase()}
                {d.verdict.confidence !== null && <span className="jt-dim"> · {Math.round(d.verdict.confidence * 100)}% confidence</span>}</p>
              {d.verdict.rationale && <p className="jd-rationale">{d.verdict.rationale}</p>}
              {d.verdict.abstainReason && <p className="jd-rationale jt-dim">Abstain: {d.verdict.abstainReason}</p>}
              <p className="jt-dim mono jd-route">route: {d.verdict.route} · evidence {d.verdict.evidenceHash.slice(0, 14)}…</p>
            </>
          ) : <p className="jt-dim">{isTerminal(state) ? 'No verdict recorded.' : 'Awaiting the agent’s work…'}</p>}
        </div>
      </div>

      {/* Per-job proof links. */}
      <div className="jd-panel">
        <p className="jd-panel-h">Proof</p>
        <ul className="jd-proof">
          {d.fundTxHash && <li><span className="jt-dim">Gasless funding</span> <a href={txUrl(d.fundTxHash)} target="_blank" rel="noreferrer" className="mono">{d.fundTxHash.slice(0, 18)}… ↗</a></li>}
          {settleTx && <li><span className="jt-dim">Settlement</span> <a href={txUrl(settleTx)} target="_blank" rel="noreferrer" className="mono">{settleTx.slice(0, 18)}… ↗</a></li>}
          <li><span className="jt-dim">Escrow contract</span> <a href={addressUrl(escrow)} target="_blank" rel="noreferrer" className="mono">{escrow.slice(0, 18)}… ↗</a></li>
          {!d.fundTxHash && !settleTx && <li className="jt-dim">Proof links appear as the job funds and settles on-chain.</li>}
        </ul>
      </div>

      {d.lastError && !isTerminal(state) && <p className="hf-error jd-note">{d.lastError}</p>}
    </>
  );
}
