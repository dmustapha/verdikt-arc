// GATE 4 silent-failure guard: the web tier recomputes the evidence hash to prove the F-005
// tamper-evident round-trip. If web/src/lib/hash.ts ever drifts from worker/src/lib/hash.ts, the
// round-trip would silently show a mismatch on every run. This pins the two functions byte-for-byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashEvidence as workerHash } from '../../worker/src/lib/hash.js';
import { hashEvidence as webHash } from '../../web/src/lib/hash.js';

const fixtures: unknown[] = [
  {
    route: 'code',
    items: [
      { id: 'test:a', kind: 'test', label: 'a', status: 'pass', detail: 'ok' },
      { id: 'bandit:B608', kind: 'static', label: 'B608', status: 'fail', detail: 'HIGH: SQLi', ref: 'solution.py:3' },
    ],
  },
  {
    route: 'tool_output',
    items: [{ id: 'schema:has_body', kind: 'schema_check', label: 'b', status: 'pass', detail: '2 bytes' }],
  },
  { route: 'answer', items: [], routeError: 'claim not verifiably supported' },
];

for (const [i, fx] of fixtures.entries()) {
  test(`hash parity fixture ${i}: web hashEvidence === worker hashEvidence`, () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(webHash(fx), workerHash(fx as any));
  });
}
