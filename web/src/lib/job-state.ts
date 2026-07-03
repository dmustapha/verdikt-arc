// WS8 dashboard — the single mapping from an internal job-machine state (+ on-chain outcome) to the
// human-facing label and chip tone. Kept in one place so the list, detail, and timeline never drift.
// States mirror worker/src/lib/job-machine.ts; outcomes mirror the VerdiktEscrow OUTCOME_* constants.

export const LIFECYCLE = ['FUNDED', 'AWAITING_DELIVERY', 'DELIVERED', 'VERIFYING', 'SETTLED'] as const;

// localStorage pointer to recently-dispatched jobs from THIS browser — a convenience so the dashboard
// can offer a return link even before a wallet reconnects. NEVER the source of truth (the payer query
// is); just a hint. Called only inside client effects/handlers, never at import time.
export const JOBS_LS_KEY = 'verdikt.jobIds';
export function rememberJobId(id: string): void {
  try {
    const cur = readJobIds();
    const next = [id, ...cur.filter((x) => x !== id)].slice(0, 20);
    localStorage.setItem(JOBS_LS_KEY, JSON.stringify(next));
  } catch { /* storage disabled / private mode — the payer query still works */ }
}
export function readJobIds(): string[] {
  try { const v = JSON.parse(localStorage.getItem(JOBS_LS_KEY) ?? '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

// The step index a state occupies on the linear timeline (DISPATCHED collapses into "awaiting";
// the three terminal states all land on the final step).
export function lifecycleIndex(state: string): number {
  switch (state) {
    case 'FUNDED': return 0;
    case 'DISPATCHED':
    case 'AWAITING_DELIVERY': return 1;
    case 'DELIVERED': return 2;
    case 'VERIFYING': return 3;
    case 'SETTLED':
    case 'ABSTAINED':
    case 'EXPIRED': return 4;
    default: return 0;
  }
}

export function isTerminal(state: string): boolean {
  return state === 'SETTLED' || state === 'ABSTAINED' || state === 'EXPIRED';
}

// How far the job ACTUALLY progressed along the linear timeline (0..3), used to mark completed steps.
// For most states this is just lifecycleIndex. The exception is EXPIRED (no-show): a job that expired
// before the seller delivered never reached DELIVERED/VERIFYING, so claiming those steps as done would
// be an optimistic lie. We infer the true furthest step from the evidence that survives on the job —
// a recorded verdict ⇒ it was verified; a stored artifact ⇒ it was delivered; neither ⇒ only awaited.
export function reachedStep(state: string, hasArtifact: boolean, hasVerdict: boolean): number {
  if (state === 'EXPIRED') {
    if (hasVerdict) return 3;   // reached VERIFYING (rare: verified but the settle never confirmed)
    if (hasArtifact) return 2;  // reached DELIVERED (delivered, but expired before settling)
    return 1;                   // true no-show: got no further than awaiting delivery
  }
  return lifecycleIndex(state);
}

export function stateLabel(state: string, outcome: string | null): string {
  switch (state) {
    case 'FUNDED': return 'Escrowed';
    case 'DISPATCHED':
    case 'AWAITING_DELIVERY': return 'Awaiting delivery';
    case 'DELIVERED': return 'Delivered';
    case 'VERIFYING': return 'Verifying';
    case 'ABSTAINED': return 'Refunded (abstain)';
    case 'EXPIRED': return 'Refunded (expired)';
    case 'SETTLED':
      if (outcome === 'release') return 'Released';
      if (outcome === 'refund') return 'Refunded';
      if (outcome === 'partial') return 'Partial';
      return 'Settled';
    default: return state;
  }
}

export type ChipTone = 'good' | 'warn' | 'bad' | 'live' | 'idle';

export function stateTone(state: string, outcome: string | null): ChipTone {
  if (state === 'SETTLED') {
    if (outcome === 'release') return 'good';
    if (outcome === 'partial') return 'warn';
    return 'warn'; // refund
  }
  if (state === 'ABSTAINED' || state === 'EXPIRED') return 'warn';
  if (state === 'VERIFYING' || state === 'DELIVERED') return 'live';
  return 'idle'; // FUNDED / DISPATCHED / AWAITING_DELIVERY
}
