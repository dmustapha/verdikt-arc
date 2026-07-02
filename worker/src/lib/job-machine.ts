import type { Outcome } from '../types.js';

// The async job lifecycle (MASTER-PLAN §WS3 PART 1). A job is the orchestration record above a
// funded escrow: it is dispatched to a seller, awaits async delivery, then verifies and settles.
// This module is PURE (no DB, no chain) — the single source of truth for which state moves are legal,
// so the store, callbacks, and keeper can never persist an impossible transition.
export const JOB_STATES = [
  'FUNDED',             // escrow funded on-chain; not yet dispatched
  'DISPATCHED',         // task handed to the seller transport
  'AWAITING_DELIVERY',  // dispatch acked; waiting for the seller's artifact (poll or callback)
  'DELIVERED',          // authoritative artifact received
  'VERIFYING',          // running the verdict engine over the artifact
  'SETTLED',            // terminal: release / refund / partial split executed on-chain
  'ABSTAINED',          // terminal: could not verify → buyer refunded in full (bounty + fee)
  'EXPIRED',            // terminal: deadline passed / no-show → refundExpired paid the buyer
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES = ['SETTLED', 'ABSTAINED', 'EXPIRED'] as const satisfies readonly JobState[];

export function isTerminal(state: JobState): boolean {
  return (TERMINAL_STATES as readonly JobState[]).includes(state);
}

// Adjacency list of legal forward moves. EXPIRED is reachable from EVERY non-terminal state (the
// keeper can no-show a job at any point before it settles); it is added programmatically below so it
// can never fall out of sync with the state set.
const FORWARD: Record<JobState, JobState[]> = {
  FUNDED: ['DISPATCHED'],
  DISPATCHED: ['AWAITING_DELIVERY', 'DELIVERED'], // a fast webhook may deliver before we mark awaiting
  AWAITING_DELIVERY: ['DELIVERED'],
  DELIVERED: ['VERIFYING'],
  VERIFYING: ['SETTLED', 'ABSTAINED'],
  SETTLED: [],
  ABSTAINED: [],
  EXPIRED: [],
};

const TRANSITIONS = {} as Record<JobState, ReadonlySet<JobState>>;
for (const s of JOB_STATES) {
  const next = new Set<JobState>(FORWARD[s]);
  if (!isTerminal(s)) next.add('EXPIRED');
  TRANSITIONS[s] = next;
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].has(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal job transition: ${from} → ${to}`);
  }
}

// The terminal state a settled verdict lands in. The LABEL/outcome decides: a definitive verdict
// (release/refund/partial) is SETTLED; an abstain is ABSTAINED (buyer refunded, no fee taken).
export function outcomeToState(outcome: Outcome): Extract<JobState, 'SETTLED' | 'ABSTAINED'> {
  return outcome === 'abstain' ? 'ABSTAINED' : 'SETTLED';
}
