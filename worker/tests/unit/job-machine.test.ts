import { describe, it, expect } from 'vitest';
import {
  JOB_STATES,
  TERMINAL_STATES,
  isTerminal,
  canTransition,
  assertTransition,
  outcomeToState,
} from '../../src/lib/job-machine.js';
import type { JobState } from '../../src/lib/job-machine.js';
import type { Outcome } from '../../src/types.js';

describe('job-machine — state set', () => {
  it('declares exactly the MASTER-PLAN lifecycle states (incl. the WS11 dispute branch)', () => {
    expect([...JOB_STATES].sort()).toEqual(
      [
        'ABSTAINED', 'AWAITING_DELIVERY', 'DELIVERED', 'DISPATCHED',
        'DISPUTED', 'ESCALATED', 'EXPIRED', 'FUNDED', 'PROPOSED',
        'RESOLVED', 'SETTLED', 'VERIFYING',
      ].sort(),
    );
  });

  it('marks only SETTLED / ABSTAINED / EXPIRED / RESOLVED terminal', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['ABSTAINED', 'EXPIRED', 'RESOLVED', 'SETTLED']);
    expect(isTerminal('SETTLED')).toBe(true);
    expect(isTerminal('ABSTAINED')).toBe(true);
    expect(isTerminal('EXPIRED')).toBe(true);
    expect(isTerminal('RESOLVED')).toBe(true);
    expect(isTerminal('FUNDED')).toBe(false);
    expect(isTerminal('VERIFYING')).toBe(false);
    // The three dispute-branch waypoints are NON-terminal — funds are still FUNDED, so the no-show
    // clock must still be able to expire them.
    expect(isTerminal('PROPOSED')).toBe(false);
    expect(isTerminal('DISPUTED')).toBe(false);
    expect(isTerminal('ESCALATED')).toBe(false);
  });
});

describe('job-machine — WS11 dispute/escalation branch', () => {
  const legal: [JobState, JobState][] = [
    ['VERIFYING', 'PROPOSED'],   // a disputable job holds settlement after verifying
    ['PROPOSED', 'SETTLED'],     // window elapsed undisputed → finalize the proposed verdict
    ['PROPOSED', 'ABSTAINED'],   // ditto, when the proposed verdict was an abstain
    ['PROPOSED', 'DISPUTED'],    // a party contests it in-window
    ['DISPUTED', 'ESCALATED'],   // handed to the arbiter
    ['ESCALATED', 'RESOLVED'],   // arbiter ruling settled on-chain
  ];
  it.each(legal)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  const illegal: [JobState, JobState][] = [
    ['VERIFYING', 'DISPUTED'],   // cannot dispute before a verdict is proposed
    ['VERIFYING', 'RESOLVED'],   // cannot skip the whole dispute path
    ['PROPOSED', 'ESCALATED'],   // must pass through DISPUTED first
    ['DISPUTED', 'RESOLVED'],    // must pass through ESCALATED first
    ['DISPUTED', 'SETTLED'],     // a contested verdict cannot self-finalize
    ['ESCALATED', 'DISPUTED'],   // no going back
  ];
  it.each(illegal)('forbids %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('forbids leaving RESOLVED (arbiter ruling is final)', () => {
    expect(canTransition('RESOLVED', 'DISPUTED')).toBe(false);
    expect(canTransition('RESOLVED', 'EXPIRED')).toBe(false);
  });
});

describe('job-machine — happy-path transitions', () => {
  const forward: [JobState, JobState][] = [
    ['FUNDED', 'DISPATCHED'],
    ['DISPATCHED', 'AWAITING_DELIVERY'],
    ['AWAITING_DELIVERY', 'DELIVERED'],
    ['DELIVERED', 'VERIFYING'],
    ['VERIFYING', 'SETTLED'],
    ['VERIFYING', 'ABSTAINED'],
  ];
  it.each(forward)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('allows a fast webhook to jump DISPATCHED → DELIVERED', () => {
    expect(canTransition('DISPATCHED', 'DELIVERED')).toBe(true);
  });

  it('allows a very fast callback to deliver straight from FUNDED (beat the DISPATCHED write)', () => {
    // A valid token-authed callback proves the seller WAS dispatched to, even if we have not yet
    // persisted the DISPATCHED transition — so a delivery may land while the job is still FUNDED.
    expect(canTransition('FUNDED', 'DELIVERED')).toBe(true);
  });
});

describe('job-machine — expiry from every non-terminal state', () => {
  const nonTerminal: JobState[] = [
    'FUNDED', 'DISPATCHED', 'AWAITING_DELIVERY', 'DELIVERED', 'VERIFYING',
    'PROPOSED', 'DISPUTED', 'ESCALATED', // held-but-still-FUNDED dispute states are expirable too
  ];
  it.each(nonTerminal)('allows %s → EXPIRED', (from) => {
    expect(canTransition(from, 'EXPIRED')).toBe(true);
  });
});

describe('job-machine — illegal transitions', () => {
  it('forbids leaving a terminal state', () => {
    for (const t of TERMINAL_STATES) {
      expect(canTransition(t, 'DISPATCHED')).toBe(false);
      expect(canTransition(t, 'EXPIRED')).toBe(false);
    }
  });

  it('forbids skipping verification (DELIVERED → SETTLED)', () => {
    expect(canTransition('DELIVERED', 'SETTLED')).toBe(false);
  });

  it('forbids going backwards (VERIFYING → FUNDED)', () => {
    expect(canTransition('VERIFYING', 'FUNDED')).toBe(false);
  });

  it('assertTransition throws on an illegal move', () => {
    expect(() => assertTransition('SETTLED', 'VERIFYING')).toThrow(/illegal job transition/i);
  });

  it('assertTransition is silent on a legal move', () => {
    expect(() => assertTransition('FUNDED', 'DISPATCHED')).not.toThrow();
  });
});

describe('job-machine — outcomeToState', () => {
  const cases: [Outcome, JobState][] = [
    ['release', 'SETTLED'],
    ['refund', 'SETTLED'],
    ['partial', 'SETTLED'],
    ['abstain', 'ABSTAINED'],
  ];
  it.each(cases)('maps verdict outcome %s → %s', (outcome, state) => {
    expect(outcomeToState(outcome)).toBe(state);
  });
});
