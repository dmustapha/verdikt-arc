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
  it('declares exactly the MASTER-PLAN lifecycle states', () => {
    expect([...JOB_STATES].sort()).toEqual(
      [
        'ABSTAINED', 'AWAITING_DELIVERY', 'DELIVERED', 'DISPATCHED',
        'EXPIRED', 'FUNDED', 'SETTLED', 'VERIFYING',
      ].sort(),
    );
  });

  it('marks only SETTLED / ABSTAINED / EXPIRED terminal', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['ABSTAINED', 'EXPIRED', 'SETTLED']);
    expect(isTerminal('SETTLED')).toBe(true);
    expect(isTerminal('ABSTAINED')).toBe(true);
    expect(isTerminal('EXPIRED')).toBe(true);
    expect(isTerminal('FUNDED')).toBe(false);
    expect(isTerminal('VERIFYING')).toBe(false);
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
});

describe('job-machine — expiry from every non-terminal state', () => {
  const nonTerminal: JobState[] = ['FUNDED', 'DISPATCHED', 'AWAITING_DELIVERY', 'DELIVERED', 'VERIFYING'];
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
