'use client';

import { useState, useRef, useEffect } from 'react';
import { QualityChecks } from './QualityChecks';
import type { EvidenceItem, VerdictLabel, Outcome } from '../../types';
import { txUrl } from '../../lib/chains';

const ESCROW = '0x4e1a423815294DFD1903D849D4BE84e3391Ea771';

// SSE goes direct to the Fly worker (dodges Vercel's function-duration cap on a proxied stream).
// Falls back to the same-origin proxy if the env var is unset (e.g. local without it).
const WORKER_BASE = process.env.NEXT_PUBLIC_WORKER_URL ?? '';

// The client owns the workId so it can open the SSE BEFORE the run starts (non-secret bytes32).
function randomWorkId(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

type DemoType = 'good' | 'bad' | 'abstain' | 'schema' | 'schema-bad';

// A narrated decision step in the courtroom log. E-3: render the worker's SSE events as
// human-readable, sequential steps so a judge watches the arbiter decide with no human.
interface Step {
  key: string;
  text: string;
  tone: 'neutral' | 'good' | 'bad' | 'warn' | 'floor';
}

// Tone → courtroom log-row class (globals.css owns the palette; no hardcoded hex here).
const TONE_CLASS: Record<Step['tone'], string> = {
  neutral: '', good: 'good', bad: 'bad', warn: 'warn', floor: 'floor',
};

// Presentational metadata for the scenario cards (the run logic is untouched: each card
// still fires run(type) with the same DemoType). Mirrors the approved mockup's cards.
const CARD_META: Record<DemoType, { dot: 'red' | 'green' | 'amber'; label: string; desc: string; out: string; primary?: boolean }> = {
  bad: { dot: 'red', label: 'Run bad (SQLi)', desc: 'Code with a SQL injection. The floor blocks release.', out: '→ refund', primary: true },
  good: { dot: 'green', label: 'Run good', desc: 'Clean code, tests pass, scan clear.', out: '→ release' },
  abstain: { dot: 'amber', label: 'Run unsupported', desc: 'No evaluator can judge this task type.', out: '→ abstain' },
  schema: { dot: 'green', label: 'Run schema', desc: 'Response validates against the contract.', out: '→ release' },
  'schema-bad': { dot: 'red', label: 'Run schema (bad)', desc: 'Response fails the JSON schema contract.', out: '→ refund' },
};

const ROUTE_LABEL: Record<string, string> = { code: 'code (sandbox + static scan)', tool_output: 'schema (structural validation)', answer: 'grounding (claim ↔ sources)' };

// Settlement word/sub for the verdict card. Outcome (settled) is authoritative; before
// settlement we derive a provisional ruling from the reasoner verdict — no fabricated data.
const SETTLE_SUB: Record<Outcome, string> = {
  release: 'USDC released to worker',
  refund: 'USDC refunded to payer',
  abstain: 'Work could not be judged · USDC returned to payer',
};

export function Courtroom({ watchWorkId }: { watchWorkId?: string } = {}) {
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [verdict, setVerdict] = useState<VerdictLabel | null>(null);
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const [txHash, setTxHash] = useState<string | null>(null);
  const [status, setStatus] = useState('idle');
  const [running, setRunning] = useState(false);
  const [activeType, setActiveType] = useState<DemoType | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether a hard static finding (e.g. SQLi) was seen, so we can narrate the
  // deterministic floor blocking a release. Refs avoid stale-closure reads in onmessage.
  const sawStaticFail = useRef(false);
  // Live mirror of `running` for use inside EventSource callbacks, which capture the
  // closure from the render that created them (where `running` is stale).
  const runningRef = useRef(false);
  // True between settled/error/abort, so onerror can tell a real drop apart from the
  // browser's normal close-after-stream-end (which also fires onerror).
  const streamLive = useRef(false);

  // Close any open stream when the component unmounts (e.g. judge navigates to /ledger
  // mid-run). Without this the EventSource leaks an open connection.
  useEffect(() => () => { esRef.current?.close(); }, []);

  function push(step: Step) { setSteps((cur) => [...cur, step]); }

  // Centralized teardown: flip both run flags and close the stream so the buttons
  // re-enable and onerror won't fire a spurious "interrupted" after a clean end.
  function stop() {
    runningRef.current = false; streamLive.current = false; setRunning(false);
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    esRef.current?.close();
  }

  function begin(): boolean {
    // Double-submit guard: a fast second click before React re-renders the disabled
    // buttons would otherwise fire a second POST + stream. The ref flips synchronously.
    if (runningRef.current) return false;
    runningRef.current = true;
    setItems([]); setSteps([]); setVerdict(null); setOutcome(undefined); setTxHash(null);
    setStatus('connecting…'); setRunning(true);
    sawStaticFail.current = false;
    return true;
  }

  // Open the SSE for a workId, arm the watchdog, and run `onOpen` once connected (a demo POST, or
  // nothing in watch mode). The client opens the stream FIRST so steps arrive live; the bus also
  // replays history, so opening AFTER an agent run still shows the full run.
  function openStream(workId: `0x${string}`, onOpen?: () => Promise<void>) {
    esRef.current?.close();
    const es = new EventSource(`${WORKER_BASE}/api/stream/${workId}`);
    esRef.current = es;
    streamLive.current = true;

    // 90s watchdog: if no terminal event lands (worker hung/unreachable), surface a clean failure
    // instead of a forever-spinner on camera.
    watchdogRef.current = setTimeout(() => {
      if (streamLive.current) { setStatus('timed out — retry'); stop(); }
    }, 90000);

    es.onopen = async () => {
      try { if (onOpen) await onOpen(); setStatus('running…'); }
      catch (e) { setStatus(`error: ${e instanceof Error ? e.message : String(e)}`); stop(); }
    };

    es.onmessage = (e) => {
      let ev: { type: string; data: Record<string, unknown> };
      try { ev = JSON.parse(e.data); } catch { return; }

      if (ev.type === 'task_funded') {
        const tx = ev.data.fundTx as string | undefined;
        push({ key: `funded-${tx}`, text: `Escrow funded on-chain (EIP-3009)${tx ? ` · ${tx.slice(0, 12)}…` : ''}`, tone: 'good' });
      }

      if (ev.type === 'route_selected') {
        const route = ev.data.route as string;
        push({ key: 'route', text: `Arbiter selected route: ${ROUTE_LABEL[route] ?? route}`, tone: 'neutral' });
        push({ key: 'gather', text: 'Gathering evidence (no human input)…', tone: 'neutral' });
        setStatus('running evidence…');
      }

      if (ev.type === 'evidence_item') {
        const item = ev.data as unknown as EvidenceItem;
        setItems((cur) => [...cur, item]);
        const failed = item.status === 'fail' || item.status === 'error';
        if (item.kind === 'static' && failed) sawStaticFail.current = true;
        const verb = item.kind === 'test' ? 'Test' : item.kind === 'static' ? 'Static scan' : item.kind === 'schema_check' ? 'Schema check' : 'Source span';
        push({
          key: `ev-${item.id}`,
          text: `${verb}: ${item.label} → ${item.status.toUpperCase()}${item.detail ? ` (${item.detail})` : ''}`,
          tone: failed ? 'bad' : item.status === 'pass' ? 'good' : 'neutral',
        });
      }

      if (ev.type === 'verdict') {
        const v = ev.data.verdict as VerdictLabel;
        setVerdict(v);
        const cited = (ev.data.citedEvidence as string[] | undefined) ?? [];
        const reason = ev.data.abstainReason as string | undefined;
        push({
          key: 'verdict',
          text: `Reasoner verdict: ${v.toUpperCase()}${cited.length ? ` · cites ${cited.join(', ')}` : ''}${reason ? ` · ${reason}` : ''}`,
          tone: v === 'pass' ? 'good' : v === 'abstain' ? 'warn' : 'bad',
        });
        // E-3 deterministic-floor beat: a hard static finding cannot be overridden into a
        // release. Make the override explicit — the arbiter was prevented from deciding wrong.
        if (sawStaticFail.current && v !== 'pass') {
          push({
            key: 'floor',
            text: 'DETERMINISTIC FLOOR: a hard static security finding forces a non-pass. Release is BLOCKED regardless of the reasoner. The AI decided, and the floor guarantees it cannot certify over a security signal.',
            tone: 'floor',
          });
        } else if (v === 'abstain') {
          push({ key: 'floor-abstain', text: 'CONSERVATIVE FLOOR: evidence is insufficient to certify → the arbiter abstains rather than false-certify. Default is refund-to-payer.', tone: 'floor' });
        }
        setStatus('verdict reached');
      }

      if (ev.type === 'settling') {
        const oc = ev.data.outcome as string;
        push({ key: 'settling', text: `Settling on Arc: ${oc} (Circle DCW signs, no human on the money path)…`, tone: 'neutral' });
        setStatus('settling on Arc…');
      }

      if (ev.type === 'settled') {
        const oc = ev.data.outcome as Outcome;
        const tx = ev.data.txHash as string;
        setOutcome(oc); setTxHash(tx); setStatus('settled');
        push({ key: 'settled', text: `Settled on-chain: ${oc === 'release' ? 'USDC released to worker' : 'USDC refunded to payer'}`, tone: oc === 'release' ? 'good' : 'warn' });
        stop();
      }

      if (ev.type === 'error') {
        const msg = (ev.data as { message?: string }).message ?? 'unknown error';
        push({ key: `err-${Date.now()}`, text: `Error: ${msg}`, tone: 'bad' });
        setStatus(`error: ${msg}`); stop();
      }
    };

    es.onerror = () => {
      // EventSource fires onerror both on a real transport drop AND on the normal
      // close after the stream ends. streamLive is true only while we still expect
      // events, so this surfaces a genuine interruption instead of spinning forever
      // (and avoids the stale `running` closure that made this branch never fire).
      if (streamLive.current) { setStatus('stream interrupted — retry'); stop(); }
    };
  }

  // Live demo run: client owns the workId, opens the stream, then POSTs to start the run.
  async function run(type: DemoType) {
    if (!begin()) return;
    const workId = randomWorkId();
    push({ key: 'fund', text: `Payer agent escrowing 1 USDC on Arc · workId ${workId.slice(0, 10)}…`, tone: 'neutral' });
    openStream(workId, async () => {
      const res = await fetch(`/api/demo/${type}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workId }),
      });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error ?? 'failed to start run'); }
    });
  }

  // Read-only watch of an externally-created (agent) run: subscribe to its workId, no POST. The bus
  // replays history, so the full run renders even if the page opens after the agents finished.
  function watch(workId: `0x${string}`) {
    if (!begin()) return;
    push({ key: 'watch', text: `Watching an agent run · workId ${workId.slice(0, 10)}…`, tone: 'neutral' });
    openStream(workId);
  }

  // Auto-subscribe when opened as /courtroom?workId=0x… (an agent run handed off from the SDK).
  useEffect(() => {
    if (watchWorkId && /^0x[0-9a-fA-F]{64}$/.test(watchWorkId)) watch(watchWorkId as `0x${string}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchWorkId]);

  const buttons: { type: DemoType; label: string; primary?: boolean }[] = [
    { type: 'bad', label: 'Run bad (SQLi) → refund', primary: true },
    { type: 'good', label: 'Run good → release' },
    { type: 'abstain', label: 'Run unsupported → abstain' },
    { type: 'schema', label: 'Run schema → release' },
    { type: 'schema-bad', label: 'Run schema (bad) → refund' },
  ];

  // Provisional ruling for the verdict card. Outcome (settled) wins; otherwise map the
  // reasoner verdict to a settlement state. Null while idle → triad shown as possibilities.
  const settleState: Outcome | null =
    outcome ?? (verdict ? (verdict === 'pass' ? 'release' : verdict === 'abstain' || verdict === 'partial' ? 'abstain' : 'refund') : null);

  return (
    <>
      {/* THE PARTIES — always visible */}
      <section className="parties" aria-label="The parties before the court">
        <div className="parties-rail">
          <div className="party payer">
            <p className="p-role">Payer agent</p>
            <p className="p-name"><span className="gd" />Buyer</p>
            <p className="p-desc">Escrows the job fee in USDC on Arc before any work begins. Owns the money path until a verdict lands.</p>
          </div>
          <div className="conn" aria-hidden="true">→</div>
          <div className="party arbiter">
            <span className="diamond" aria-hidden="true" />
            <p className="p-role">Arbiter ◆</p>
            <p className="p-name">Verdikt Escrow</p>
            <p className="p-desc">Holds the fee, picks a route, gathers evidence, and rules. No human, no override.</p>
            <p className="p-addr">Arc · <a href={`https://testnet.arcscan.app/address/${ESCROW}`} target="_blank" rel="noopener noreferrer">{`${ESCROW.slice(0, 6)}…${ESCROW.slice(-4)}`}</a></p>
          </div>
          <div className="conn" aria-hidden="true">←</div>
          <div className="party worker">
            <p className="p-role">Worker agent</p>
            <p className="p-name"><span className="gd" />Seller</p>
            <p className="p-desc">Delivers the work plus evidence. Paid only when the verdict certifies the job as verified.</p>
          </div>
        </div>
      </section>

      {/* RUN A CASE — scenario cards */}
      <section className="run">
        <p className="section-kicker">Run a case</p>
        <h2 className="section-title">Five real jobs. Replay any verdict on Arc.</h2>
        <div className="cases-grid" role="group" aria-label="Run a case">
          {buttons.map((b) => {
            const m = CARD_META[b.type];
            return (
              <button
                key={b.type}
                type="button"
                className={`case${m.primary ? ' primary' : ''}`}
                data-active={activeType === b.type ? 'true' : 'false'}
                onClick={() => { setActiveType(b.type); run(b.type); }}
                disabled={running}
              >
                <span className="c-top"><span className={`c-dot ${m.dot}`} /><span className="c-label">{m.label}</span></span>
                <span className="c-desc">{m.desc}</span>
                <span className="c-out">{m.out}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* COURT: decision log + verdict/evidence */}
      <section className="court">
        <div className="court-grid">

          {/* THE DECISION LOG */}
          <div className="log-panel">
            <div className="log-head">
              <span className="lh-title">The arbiter, in session</span>
              <span className="lh-meta"><span className="lh-live" />status: {status}</span>
            </div>
            <div className="log-body mono" aria-live="polite">
              {steps.length === 0 ? (
                <div className="log-empty">
                  <span className="le-diamond" aria-hidden="true" />
                  <p className="le-text">Select a case above to bring it <em>before the court.</em></p>
                  <p className="le-sub">The arbiter&apos;s findings stream here, step by step, with no human in the loop.</p>
                </div>
              ) : (
                <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {steps.map((s, i) => (
                    <li key={s.key + i} className={`log-row ${TONE_CLASS[s.tone]}`.trim()}>
                      <span className="mk" aria-hidden="true" />
                      <div className="lr-body">
                        {s.tone === 'floor' && <p className="lr-tag">Deterministic floor</p>}
                        <p className="lr-text">{s.text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>

          {/* VERDICT + EVIDENCE */}
          <div className="rail-col">
            <div className="verdict-card" data-state={settleState ?? undefined}>
              <p className="vc-label">The verdict</p>
              <p className="vc-word">{settleState ? settleState.toUpperCase() : '—'}</p>
              <p className="vc-sub">{settleState ? SETTLE_SUB[settleState] : 'Awaiting a case before the court'}</p>
              <div className="triad-legend" aria-hidden="true">
                <span className="tl-chip release" data-on={settleState === 'release' ? 'true' : 'false'}>RELEASE</span>
                <span className="tl-chip refund" data-on={settleState === 'refund' ? 'true' : 'false'}>REFUND</span>
                <span className="tl-chip abstain" data-on={settleState === 'abstain' ? 'true' : 'false'}>ABSTAIN</span>
              </div>
              {txHash && (
                <div className="settle-row" data-state={settleState ?? undefined}>
                  <p className="sr-label">On-chain settlement</p>
                  <a href={txUrl(txHash)} target="_blank" rel="noreferrer">{txHash.slice(0, 18)}… <span aria-hidden="true">↗</span></a>
                </div>
              )}
            </div>

            {items.length > 0
              ? <QualityChecks items={items} />
              : (
                <div className="evidence">
                  <div className="ev-head"><span className="ev-title">Evidence</span><span className="ev-tally">awaiting run</span></div>
                  <p className="ev-empty">Evidence is gathered live during a run — tests, static scans, and schema checks land here as the arbiter works, each one citable in the verdict.</p>
                </div>
              )}
          </div>

        </div>
      </section>
    </>
  );
}
