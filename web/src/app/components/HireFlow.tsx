'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useAccount, useConnect, useDisconnect, useSwitchChain, useSignTypedData, useReadContract } from 'wagmi';
import { formatUnits } from 'viem';
import { arcTestnet, txUrl, addressUrl } from '../../lib/chains';
import { rememberJobId } from '../../lib/job-state';
import { ARC_USDC_ADDRESS, buildAuthorization, fundBody } from '../../lib/relayer-sign';
import { CAPABILITY_CONFIG, CAPABILITY_NAME } from '../../lib/catalog';
import type { Outcome, VerdictLabel } from '../../types';

// SSE goes direct to the Fly worker (dodges Vercel's function-duration cap on a proxied stream).
const WORKER_BASE = process.env.NEXT_PUBLIC_WORKER_URL ?? '';

// Fixed demo economics: the human escrows a small bounty + a verification fee, released only on a
// verified-good verdict. All on Arc, in 6-decimal USDC.
const BOUNTY_USDC = 0.05;
const FEE_USDC = 0.01;
const TOTAL_USDC = BOUNTY_USDC + FEE_USDC;

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

interface Seller {
  sellerId: string; endpoint: string; protocol: string; capability: string;
  wallet: `0x${string}`; payoutDomain: number; acceptanceTemplate: { spec: string; inputLabel: string };
}

interface Step { key: string; text: string; tone: 'neutral' | 'good' | 'bad' | 'warn' | 'floor' }
const TONE: Record<Step['tone'], string> = { neutral: '', good: 'good', bad: 'bad', warn: 'warn', floor: 'floor' };
const SETTLE_SUB: Record<Outcome, string> = {
  release: 'USDC released to the agent — the work passed',
  refund: 'USDC refunded to you — the work failed',
  abstain: 'Could not be judged — your USDC returned in full',
};

function randomWorkId(): `0x${string}` {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return ('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

export function HireFlow({ sellers, escrow }: { sellers: Seller[]; escrow: `0x${string}` }) {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();

  const wrongNetwork = isConnected && chainId !== arcTestnet.id;

  const { data: rawBalance, refetch: refetchBalance } = useReadContract({
    address: ARC_USDC_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf',
    args: address ? [address] : undefined, chainId: arcTestnet.id,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });
  const balance = rawBalance !== undefined ? Number(formatUnits(rawBalance as bigint, 6)) : null;

  const [selected, setSelected] = useState<Seller | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<Step[]>([]);
  const [verdict, setVerdict] = useState<VerdictLabel | null>(null);
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const [settleTx, setSettleTx] = useState<string | null>(null);
  const [fundTx, setFundTx] = useState<string | null>(null);
  const [trackJobId, setTrackJobId] = useState<string | null>(null); // WS8: dashboard return link
  const [status, setStatus] = useState('idle');
  const [busy, setBusy] = useState(false);
  const [flowActive, setFlowActive] = useState(false); // true for the WHOLE flow (funding + SSE wait)
  const [faucetMsg, setFaucetMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const runningRef = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { esRef.current?.close(); if (watchdogRef.current) clearTimeout(watchdogRef.current); }, []);

  const config = selected ? CAPABILITY_CONFIG[selected.capability] : null;

  function pick(s: Seller) {
    setSelected(s);
    const cfg = CAPABILITY_CONFIG[s.capability];
    setInputs(cfg ? { ...cfg.example } : {});
    setSteps([]); setVerdict(null); setOutcome(undefined); setSettleTx(null); setFundTx(null); setTrackJobId(null); setError(null); setStatus('idle');
  }
  const push = (s: Step) => setSteps((cur) => [...cur, s]);
  function stop() { runningRef.current = false; setBusy(false); setFlowActive(false); esRef.current?.close(); if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; } }

  async function faucet() {
    if (!address) return;
    setFaucetMsg('Requesting test USDC…');
    try {
      const res = await fetch('/api/faucet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setFaucetMsg(`Faucet: ${data.error ?? 'failed'}`); return; }
      setFaucetMsg(`Received ${data.amountUsdc} test USDC. Balance updates shortly.`);
      setTimeout(() => refetchBalance(), 3000);
    } catch (e) { setFaucetMsg(`Faucet error: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const onEvent = useCallback((raw: string) => {
    let ev: { type: string; data: Record<string, unknown> };
    try { ev = JSON.parse(raw); } catch { return; }
    if (ev.type === 'artifact_received') push({ key: 'delivered', text: 'Agent delivered its work — verifying against your acceptance…', tone: 'neutral' });
    if (ev.type === 'route_selected') { push({ key: 'route', text: `Arbiter gathering evidence (route: ${ev.data.route})…`, tone: 'neutral' }); setStatus('verifying'); }
    if (ev.type === 'evidence_item') {
      const it = ev.data as { id?: string; label?: string; status?: string; detail?: string };
      const failed = it.status === 'fail' || it.status === 'error';
      push({ key: `ev-${it.id}`, text: `${it.label}${it.detail ? ` — ${it.detail}` : ''} → ${String(it.status).toUpperCase()}`, tone: failed ? 'bad' : it.status === 'pass' ? 'good' : 'neutral' });
    }
    if (ev.type === 'verdict') {
      const v = ev.data.verdict as VerdictLabel; setVerdict(v);
      const reason = ev.data.abstainReason as string | undefined;
      push({ key: 'verdict', text: `Verdict: ${v.toUpperCase()}${reason ? ` · ${reason}` : ''}`, tone: v === 'pass' ? 'good' : v === 'abstain' ? 'warn' : 'bad' });
      setStatus('verdict reached');
    }
    if (ev.type === 'settling') { push({ key: 'settling', text: 'Settling on Arc (no human on the money path)…', tone: 'neutral' }); setStatus('settling'); }
    if (ev.type === 'settled') {
      const oc = ev.data.outcome as Outcome; const tx = ev.data.txHash as string;
      setOutcome(oc); setSettleTx(tx); setStatus('settled');
      push({ key: 'settled', text: `Settled on-chain: ${SETTLE_SUB[oc]}`, tone: oc === 'release' ? 'good' : 'warn' });
      setTimeout(() => refetchBalance(), 2500);
      stop();
    }
    if (ev.type === 'error') { const m = (ev.data as { message?: string }).message ?? 'error'; push({ key: `err-${Date.now()}`, text: `Error: ${m}`, tone: 'bad' }); setStatus(`error`); setError(m); stop(); }
  }, [refetchBalance]);

  async function hire() {
    if (!address || !selected || !config || runningRef.current) return;
    if (wrongNetwork) { setError('Switch to Arc testnet first.'); return; }
    if (balance === null) { setError('Still reading your balance — one moment, then try again.'); refetchBalance(); return; }
    if (balance < TOTAL_USDC) { setError(`You need ${TOTAL_USDC} USDC. Use “Get test USDC”.`); return; }
    const built = config.buildAcceptance(inputs);
    if (!built.ok) { setError(built.error); return; }

    runningRef.current = true; setBusy(true); setFlowActive(true); setError(null); setFaucetMsg(null);
    setSteps([]); setVerdict(null); setOutcome(undefined); setSettleTx(null); setFundTx(null); setTrackJobId(null);
    const workId = randomWorkId();
    const worker = selected.wallet;

    try {
      // 1. Register the task (public; no money moves). amountUsdc = the TOTAL the human will escrow.
      setStatus('registering task'); push({ key: 'reg', text: `Registering task · workId ${workId.slice(0, 10)}…`, tone: 'neutral' });
      const tRes = await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workId, type: config.type, acceptance: built.acceptance, payer: address, seller: worker, amountUsdc: TOTAL_USDC }),
      });
      if (!tRes.ok) throw new Error((await tRes.json().catch(() => ({}))).error ?? 'task registration failed');

      // 2. Open the live SSE stream BEFORE dispatch so nothing is missed.
      esRef.current?.close();
      const es = new EventSource(`${WORKER_BASE}/api/stream/${workId}`);
      esRef.current = es; es.onmessage = (e) => onEvent(e.data);
      es.onerror = () => { /* stream reconnects; terminal states arrive via settled/error */ };

      // 3. Sign the EIP-3009 authorization in-browser (routes folded into the nonce). No gas, no tx.
      setStatus('waiting for your signature'); push({ key: 'sign', text: 'Sign the payment authorization in your wallet (no gas)…', tone: 'neutral' });
      const auth = buildAuthorization({ escrow, payer: address, workId, worker, totalUsdc: TOTAL_USDC, feeUsdc: FEE_USDC });
      // Pass the pre-built EIP-712 payload field-by-field so wagmi infers the shape (no blanket cast).
      // The exact serialization this produces is proven to recover + fund via prove-wallet-sign.ts.
      const signature = await signTypedDataAsync({
        domain: auth.typedData.domain,
        types: auth.typedData.types,
        primaryType: auth.typedData.primaryType,
        message: auth.typedData.message,
      });

      // 4. The relayer submits it — the human pays ZERO gas.
      setStatus('funding escrow (gasless)'); push({ key: 'fund', text: 'Relayer funding your escrow on Arc (you pay no gas)…', tone: 'neutral' });
      const rRes = await fetch('/api/relayer/fund', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fundBody({ payer: address, workId, worker, amount: auth.amount, fee: auth.fee, ttl: auth.ttl, validAfter: auth.validAfter, validBefore: auth.validBefore, signature, routes: auth.routes })),
      });
      const rBody = await rRes.json().catch(() => ({}));
      if (!rRes.ok) throw new Error(rBody.error ?? 'funding failed');
      setFundTx(rBody.fundTx); refetchBalance();
      push({ key: 'funded', text: `Escrow funded (gasless) · ${String(rBody.fundTx).slice(0, 14)}…`, tone: 'good' });

      // 5. Dispatch the job to the chosen agent — the async lifecycle takes over; SSE streams the rest.
      setStatus('dispatching to the agent'); push({ key: 'dispatch', text: `Dispatching to ${CAPABILITY_NAME[selected.capability] ?? selected.capability}…`, tone: 'neutral' });
      const jRes = await fetch('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workId, seller: { url: selected.endpoint, protocol: selected.protocol } }),
      });
      const jBody = await jRes.json().catch(() => ({}));
      if (!jRes.ok) throw new Error(jBody.error ?? 'dispatch failed');
      // WS8: capture the jobId so the buyer can leave and return to the dashboard mid-flight.
      if (jBody.jobId) { setTrackJobId(jBody.jobId); rememberJobId(jBody.jobId); }
      setStatus('agent working…'); push({ key: 'awaiting', text: 'Agent is working — the verdict will settle automatically.', tone: 'neutral' });
      setBusy(false); // funding done; the async verdict/settle streams over SSE
      // Watchdog: if no verdict streams back in time (dead stream / slow or no-show seller), tell the
      // user the truth — the escrow is safe and auto-refunds at its deadline — instead of hanging.
      // A verdict (settled) or error calls stop(), which clears this timer — so if it fires, none arrived.
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = setTimeout(() => {
        push({ key: 'watchdog', text: 'No verdict yet — the agent may be slow or unreachable. Your escrow is safe and auto-refunds at its deadline; refresh to check later.', tone: 'warn' });
        setStatus('no verdict yet'); stop();
      }, 150_000);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      // A rejected signature is a normal user action, not a failure.
      const rejected = /rejected|denied|User rejected/i.test(m);
      push({ key: `flow-err`, text: rejected ? 'Signature rejected — nothing was charged.' : `Error: ${m}`, tone: rejected ? 'warn' : 'bad' });
      setError(rejected ? null : m); setStatus(rejected ? 'idle' : 'error'); stop();
    }
  }

  const settleState: Outcome | null = outcome ?? (verdict ? (verdict === 'pass' ? 'release' : verdict === 'abstain' || verdict === 'partial' ? 'abstain' : 'refund') : null);
  const injected = connectors.find((c) => c.id === 'injected' || c.type === 'injected') ?? connectors[0];
  const coinbase = connectors.find((c) => c.id === 'coinbaseWalletSDK' || c.name.toLowerCase().includes('coinbase'));

  return (
    <>
      {/* ── Wallet bar ─────────────────────────────────────────── */}
      <section className="hire-wallet">
        {!isConnected ? (
          <div className="hw-connect">
            <div>
              <p className="hw-title">Connect a wallet to hire an agent</p>
              <p className="hw-sub">You’ll pay only for verified-good work, and never pay gas — a relayer covers it.</p>
            </div>
            <div className="hw-btns">
              {injected && <button className="btn btn-primary" onClick={() => connect({ connector: injected })} disabled={connecting}>Connect wallet</button>}
              {coinbase && coinbase !== injected && <button className="btn btn-ghost" onClick={() => connect({ connector: coinbase })} disabled={connecting}>Coinbase Wallet</button>}
            </div>
          </div>
        ) : (
          <div className="hw-connected">
            <div className="hw-acct">
              <span className="hw-dot" />
              <a href={addressUrl(address!)} target="_blank" rel="noreferrer" className="mono">{address!.slice(0, 6)}…{address!.slice(-4)}</a>
              <span className="hw-bal mono">{balance === null ? '—' : `${balance.toFixed(2)} USDC`}</span>
            </div>
            <div className="hw-btns">
              {wrongNetwork
                ? <button className="btn btn-primary" onClick={() => switchChain({ chainId: arcTestnet.id })} disabled={switching}>{switching ? 'Switching…' : 'Switch to Arc'}</button>
                : <button className="btn btn-ghost" onClick={faucet}>Get test USDC</button>}
              <button className="btn btn-ghost" onClick={() => disconnect()}>Disconnect</button>
            </div>
          </div>
        )}
        {faucetMsg && <p className="hw-note">{faucetMsg}</p>}
        {wrongNetwork && <p className="hw-note warn">Wrong network — switch to Arc testnet to continue.</p>}
      </section>

      {/* ── Catalog ────────────────────────────────────────────── */}
      <section className="hire-catalog">
        <p className="section-kicker">The catalog</p>
        <h2 className="section-title">Pick an agent. It works, then gets paid — only if the work passes.</h2>
        {sellers.length === 0 ? (
          <p className="hc-empty">No agents are listed right now. The catalog reads live from the registry.</p>
        ) : (
          <div className="hc-grid">
            {sellers.map((s) => (
              <button key={s.sellerId} type="button" className="hc-card" data-active={selected?.sellerId === s.sellerId} onClick={() => pick(s)} disabled={flowActive}>
                <span className="hc-name">{CAPABILITY_NAME[s.capability] ?? s.capability}</span>
                <span className="hc-cap mono">{s.capability}</span>
                <span className="hc-spec">{s.acceptanceTemplate.spec}</span>
                <span className="hc-supply">You supply: {s.acceptanceTemplate.inputLabel}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ── Task form ──────────────────────────────────────────── */}
      {selected && config && (
        <section className="hire-form">
          <p className="section-kicker">Your task for {CAPABILITY_NAME[selected.capability] ?? selected.capability}</p>
          <p className="hf-criterion"><strong>Release criterion:</strong> {selected.acceptanceTemplate.spec}</p>
          <div className="hf-fields">
            {config.fields.map((f) => (
              <label key={f.key} className="try-field">
                <span className="tf-label">{f.label}</span>
                <span className="tf-hint">{f.hint}</span>
                <textarea className={f.mono ? 'mono' : ''} rows={f.rows} spellCheck={false} disabled={flowActive}
                  value={inputs[f.key] ?? ''} onChange={(e) => setInputs((cur) => ({ ...cur, [f.key]: e.target.value }))} />
              </label>
            ))}
          </div>
          <div className="hf-economics">
            You escrow <strong>{TOTAL_USDC} USDC</strong> ({BOUNTY_USDC} bounty + {FEE_USDC} verification). Released to the agent only if the work passes; otherwise refunded to you. You pay <strong>no gas</strong>.
          </div>
          {error && <p className="hf-error">{error}</p>}
          <div className="cta-row">
            <button type="button" className="btn btn-primary" onClick={hire} disabled={flowActive || !isConnected || wrongNetwork || balance === null || balance < TOTAL_USDC}>
              {busy ? status : `Hire · escrow ${TOTAL_USDC} USDC →`}
            </button>
            {!busy && <button type="button" className="btn btn-ghost" onClick={() => setInputs({ ...config.example })}>Reset example</button>}
          </div>
        </section>
      )}

      {/* ── Live courtroom (reuses the verdict rendering) ──────── */}
      {(steps.length > 0 || busy) && (
        <section className="court">
          <div className="court-grid">
            <div className="log-panel">
              <div className="log-head">
                <span className="lh-title">The arbiter, in session</span>
                <span className="lh-meta"><span className="lh-live" />status: {status}</span>
              </div>
              <div className="log-body mono" aria-live="polite">
                <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {steps.map((s, i) => (
                    <li key={s.key + i} className={`log-row ${TONE[s.tone]}`.trim()}>
                      <span className="mk" aria-hidden="true" />
                      <div className="lr-body"><p className="lr-text">{s.text}</p></div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
            <div className="rail-col">
              <div className="verdict-card" data-state={settleState ?? undefined}>
                <p className="vc-label">The verdict</p>
                <p className="vc-word">{settleState ? settleState.toUpperCase() : '—'}</p>
                <p className="vc-sub">{settleState ? SETTLE_SUB[settleState] : 'Awaiting the agent’s work'}</p>
                <div className="triad-legend" aria-hidden="true">
                  <span className="tl-chip release" data-on={settleState === 'release'}>RELEASE</span>
                  <span className="tl-chip refund" data-on={settleState === 'refund'}>REFUND</span>
                  <span className="tl-chip abstain" data-on={settleState === 'abstain'}>ABSTAIN</span>
                </div>
                {fundTx && (
                  <div className="settle-row"><p className="sr-label">Gasless funding</p>
                    <a href={txUrl(fundTx)} target="_blank" rel="noreferrer">{fundTx.slice(0, 18)}… ↗</a></div>
                )}
                {settleTx && (
                  <div className="settle-row" data-state={settleState ?? undefined}><p className="sr-label">On-chain settlement</p>
                    <a href={txUrl(settleTx)} target="_blank" rel="noreferrer">{settleTx.slice(0, 18)}… ↗</a></div>
                )}
                {trackJobId && (
                  <div className="settle-row"><p className="sr-label">Leave &amp; return</p>
                    <Link href={`/jobs/${trackJobId}`}>Track this job →</Link></div>
                )}
              </div>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
