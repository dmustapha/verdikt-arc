'use client';

import { useState, useRef, useEffect } from 'react';
import { QualityChecks } from './QualityChecks';
import type { EvidenceItem, VerdictLabel, Outcome } from '../../types';
import { txUrl } from '../../lib/chains';

// SSE goes direct to the Fly worker (dodges Vercel's function-duration cap on a proxied stream).
const WORKER_BASE = process.env.NEXT_PUBLIC_WORKER_URL ?? '';

function randomWorkId(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

type Route = 'code' | 'tool_output' | 'answer';

interface Step { key: string; text: string; tone: 'neutral' | 'good' | 'bad' | 'warn' | 'floor'; }
const TONE_CLASS: Record<Step['tone'], string> = { neutral: '', good: 'good', bad: 'bad', warn: 'warn', floor: 'floor' };

// Each route is gated to its payer ground truth: code↔tests, tool_output↔schema, answer↔sources.
// Prefilled examples all PASS — the invitation is to break them and watch the floor refund/abstain.
const PRESETS: Record<Route, {
  label: string; pill: string; verifies: string; criteriaLabel: string; criteriaHint: string;
  criteria: string; payloadLabel: string; payload: string;
}> = {
  code: {
    label: 'Code', pill: 'sandbox + security scan',
    verifies: 'Runs your code against YOUR pytest in a network-isolated sandbox + a static security scan (Bandit/Semgrep). A failing test or a security finding refunds — the deterministic floor cannot be talked out of it.',
    criteriaLabel: 'Your acceptance tests (pytest — imports `solution`)',
    criteriaHint: 'No tests, no verdict. The payer’s tests are the definition of "good".',
    criteria: 'from solution import add\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_add_negative():\n    assert add(-1, 1) == 0\n',
    payloadLabel: 'The delivered code (written to solution.py)',
    payload: 'def add(a, b):\n    return a + b\n',
  },
  tool_output: {
    label: 'Tool output (JSON)', pill: 'schema validation',
    verifies: 'Validates your JSON against YOUR schema contract (types, required fields, bounds, formats). A field that breaks the contract refunds.',
    criteriaLabel: 'Your schema contract (JSON field map)',
    criteriaHint: 'No contract, no verdict. Must be valid JSON.',
    criteria: '{\n  "symbol":     { "type": "string", "required": true },\n  "price":      { "type": "number", "required": true, "min": 0 },\n  "confidence": { "type": "number", "required": true, "min": 0, "max": 1 }\n}\n',
    payloadLabel: 'The delivered JSON output',
    payload: '{ "symbol": "ETH", "price": 3421.55, "confidence": 0.92 }\n',
  },
  answer: {
    label: 'Answer (text)', pill: 'grounding vs. sources',
    verifies: 'Checks every claim in the answer is supported by a verbatim span in YOUR sources. A contradiction refunds; anything unverifiable abstains (and refunds) rather than guessing.',
    criteriaLabel: 'Your sources (the ground truth)',
    criteriaHint: 'No sources, no verdict. Claims are checked against this text only.',
    criteria: 'Arc is an EVM-compatible testnet. Its block time is approximately 0.48 seconds. USDC on Arc is exposed at a predeploy address with 6 decimals.\n',
    payloadLabel: 'The delivered answer',
    payload: 'Arc is an EVM-compatible testnet with a block time of about 0.48 seconds.\n',
  },
};

const ROUTE_LABEL: Record<string, string> = {
  code: 'code (sandbox + static scan)', tool_output: 'schema (structural validation)', answer: 'grounding (claim ↔ sources)',
};
const SETTLE_SUB: Record<Outcome, string> = {
  release: 'USDC released to the seller', refund: 'USDC refunded to the payer',
  abstain: 'Work could not be judged · USDC returned to the payer',
};

export function TryIt() {
  const [route, setRoute] = useState<Route>('code');
  const [criteria, setCriteria] = useState(PRESETS.code.criteria);
  const [payload, setPayload] = useState(PRESETS.code.payload);
  const [language, setLanguage] = useState<'python' | 'typescript'>('python');

  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [verdict, setVerdict] = useState<VerdictLabel | null>(null);
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const [txHash, setTxHash] = useState<string | null>(null);
  const [status, setStatus] = useState('idle');
  const [running, setRunning] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sawStaticFail = useRef(false);
  const runningRef = useRef(false);
  const streamLive = useRef(false);

  useEffect(() => () => { esRef.current?.close(); }, []);

  function loadPreset(r: Route) {
    setRoute(r);
    setCriteria(PRESETS[r].criteria);
    setPayload(PRESETS[r].payload);
  }
  function push(step: Step) { setSteps((cur) => [...cur, step]); }
  function stop() {
    runningRef.current = false; streamLive.current = false; setRunning(false);
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    esRef.current?.close();
  }

  // Build the route-correct request body from the form, mirroring the worker's scope gate.
  function buildBody(workId: `0x${string}`): { ok: true; body: unknown } | { ok: false; error: string } {
    if (route === 'code') {
      if (!criteria.trim()) return { ok: false, error: 'Add acceptance tests — no tests, no verdict.' };
      return { ok: true, body: { workId, route, acceptance: { tests: criteria }, artifact: { payload, language } } };
    }
    if (route === 'tool_output') {
      let schema: unknown;
      try { schema = JSON.parse(criteria); } catch { return { ok: false, error: 'Schema must be valid JSON.' }; }
      return { ok: true, body: { workId, route, acceptance: { schema }, artifact: { payload } } };
    }
    if (!criteria.trim()) return { ok: false, error: 'Add sources — no sources, no verdict.' };
    return { ok: true, body: { workId, route, acceptance: { sources: criteria }, artifact: { payload } } };
  }

  async function run() {
    if (runningRef.current) return;
    if (!payload.trim()) { setStatus('error: add an artifact to judge'); return; }
    runningRef.current = true;
    setItems([]); setSteps([]); setVerdict(null); setOutcome(undefined); setTxHash(null);
    setStatus('connecting…'); setRunning(true); sawStaticFail.current = false;

    const workId = randomWorkId();
    const built = buildBody(workId);
    if (!built.ok) { setStatus(`error: ${built.error}`); stop(); return; }

    push({ key: 'fund', text: `Payer agent escrowing USDC on Arc · workId ${workId.slice(0, 10)}…`, tone: 'neutral' });

    esRef.current?.close();
    const es = new EventSource(`${WORKER_BASE}/api/stream/${workId}`);
    esRef.current = es;
    streamLive.current = true;
    watchdogRef.current = setTimeout(() => { if (streamLive.current) { setStatus('timed out — retry'); stop(); } }, 90000);

    es.onopen = async () => {
      try {
        const res = await fetch('/api/try', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(built.body),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setStatus(`error: ${body.error ?? 'failed to start run'}`); stop();
        } else { setStatus('running…'); }
      } catch (e) {
        setStatus(`error: ${e instanceof Error ? e.message : String(e)}`); stop();
      }
    };

    es.onmessage = (e) => {
      let ev: { type: string; data: Record<string, unknown> };
      try { ev = JSON.parse(e.data); } catch { return; }

      if (ev.type === 'task_funded') {
        const tx = ev.data.fundTx as string | undefined;
        push({ key: `funded-${tx}`, text: `Escrow funded on-chain (EIP-3009)${tx ? ` · ${tx.slice(0, 12)}…` : ''}`, tone: 'good' });
      }
      if (ev.type === 'route_selected') {
        const r = ev.data.route as string;
        push({ key: 'route', text: `Arbiter selected route: ${ROUTE_LABEL[r] ?? r}`, tone: 'neutral' });
        push({ key: 'gather', text: 'Gathering evidence (no human input)…', tone: 'neutral' });
        setStatus('running evidence…');
      }
      if (ev.type === 'evidence_item') {
        const item = ev.data as unknown as EvidenceItem;
        setItems((cur) => [...cur, item]);
        const failed = item.status === 'fail' || item.status === 'error';
        if (item.kind === 'static' && failed) sawStaticFail.current = true;
        const verb = item.kind === 'test' ? 'Test' : item.kind === 'static' ? 'Static scan' : item.kind === 'schema_check' ? 'Schema check' : 'Source span';
        push({ key: `ev-${item.id}`, text: `${verb}: ${item.label} → ${item.status.toUpperCase()}${item.detail ? ` (${item.detail})` : ''}`, tone: failed ? 'bad' : item.status === 'pass' ? 'good' : 'neutral' });
      }
      if (ev.type === 'verdict') {
        const v = ev.data.verdict as VerdictLabel;
        setVerdict(v);
        const cited = (ev.data.citedEvidence as string[] | undefined) ?? [];
        const reason = ev.data.abstainReason as string | undefined;
        push({ key: 'verdict', text: `Reasoner verdict: ${v.toUpperCase()}${cited.length ? ` · cites ${cited.join(', ')}` : ''}${reason ? ` · ${reason}` : ''}`, tone: v === 'pass' ? 'good' : v === 'abstain' ? 'warn' : 'bad' });
        if (sawStaticFail.current && v !== 'pass') {
          push({ key: 'floor', text: 'DETERMINISTIC FLOOR: a hard security finding forces a non-pass. Release is BLOCKED regardless of the reasoner.', tone: 'floor' });
        } else if (v === 'abstain') {
          push({ key: 'floor-abstain', text: 'CONSERVATIVE FLOOR: evidence is insufficient to certify → abstain rather than false-certify. Default is refund-to-payer.', tone: 'floor' });
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
        push({ key: 'settled', text: `Settled on-chain: ${SETTLE_SUB[oc]}`, tone: oc === 'release' ? 'good' : 'warn' });
        stop();
      }
      if (ev.type === 'error') {
        const msg = (ev.data as { message?: string }).message ?? 'unknown error';
        push({ key: `err-${steps.length}`, text: `Error: ${msg}`, tone: 'bad' });
        setStatus(`error: ${msg}`); stop();
      }
    };

    es.onerror = () => { if (streamLive.current) { setStatus('stream interrupted — retry'); stop(); } };
  }

  const settleState: Outcome | null =
    outcome ?? (verdict ? (verdict === 'pass' ? 'release' : verdict === 'abstain' || verdict === 'partial' ? 'abstain' : 'refund') : null);
  const p = PRESETS[route];

  return (
    <>
      <section className="run">
        <p className="section-kicker">Bring your own task</p>
        <h2 className="section-title">Paste real work. Get a real verdict, settled on Arc.</h2>
        <p className="try-boundary">
          Verdikt only judges what is checkable against <em>your</em> ground truth. Pick a route, supply the
          criteria, and a real escrow funds, settles, and links to Arcscan. Out-of-scope or unverifiable input
          fails <strong>safe</strong> — it abstains and refunds, never a wrong release.
        </p>

        <div className="try-routes" role="group" aria-label="Pick a route">
          {(Object.keys(PRESETS) as Route[]).map((r) => (
            <button key={r} type="button" className="case" data-active={route === r ? 'true' : 'false'} onClick={() => loadPreset(r)} disabled={running}>
              <span className="c-top"><span className="c-label">{PRESETS[r].label}</span></span>
              <span className="c-out">{PRESETS[r].pill}</span>
            </button>
          ))}
        </div>

        <p className="try-verifies">{p.verifies}</p>

        <div className="try-grid">
          <label className="try-field">
            <span className="tf-label">{p.criteriaLabel}</span>
            <span className="tf-hint">{p.criteriaHint}</span>
            <textarea className="mono" value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={10} spellCheck={false} disabled={running} />
          </label>
          <label className="try-field">
            <span className="tf-label">{p.payloadLabel}</span>
            {route === 'code' ? (
              <span className="tf-hint">
                Language:{' '}
                <select value={language} onChange={(e) => setLanguage(e.target.value as 'python' | 'typescript')} disabled={running}>
                  <option value="python">python</option>
                  <option value="typescript">typescript</option>
                </select>
              </span>
            ) : <span className="tf-hint">&nbsp;</span>}
            <textarea className="mono" value={payload} onChange={(e) => setPayload(e.target.value)} rows={10} spellCheck={false} disabled={running} />
          </label>
        </div>

        <div className="cta-row">
          <button type="button" className="btn btn-primary" onClick={run} disabled={running}>
            {running ? 'Running…' : 'Run a real verdict →'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => loadPreset(route)} disabled={running}>Reset example</button>
        </div>
      </section>

      <section className="court">
        <div className="court-grid">
          <div className="log-panel">
            <div className="log-head">
              <span className="lh-title">The arbiter, in session</span>
              <span className="lh-meta"><span className="lh-live" />status: {status}</span>
            </div>
            <div className="log-body mono" aria-live="polite">
              {steps.length === 0 ? (
                <div className="log-empty">
                  <span className="le-diamond" aria-hidden="true" />
                  <p className="le-text">Edit the task above and <em>run a real verdict.</em></p>
                  <p className="le-sub">The escrow funds, the arbiter gathers evidence, and the outcome settles on Arc — no human in the loop.</p>
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

          <div className="rail-col">
            <div className="verdict-card" data-state={settleState ?? undefined}>
              <p className="vc-label">The verdict</p>
              <p className="vc-word">{settleState ? settleState.toUpperCase() : '—'}</p>
              <p className="vc-sub">{settleState ? SETTLE_SUB[settleState] : 'Awaiting a task'}</p>
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
                  <p className="ev-empty">Tests, static scans, and schema checks land here live as the arbiter works, each one citable in the verdict.</p>
                </div>
              )}
          </div>
        </div>
      </section>
    </>
  );
}
