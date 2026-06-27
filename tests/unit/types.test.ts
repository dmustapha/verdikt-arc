// Unit test for the on-chain code maps in worker/src/types.ts.
// These constants are load-bearing: they map verdict labels / outcomes to the
// exact uint8 values the VerdiktEscrow contract reads. A drift here silently
// mis-settles money, so we pin them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERDICT_CODE, OUTCOME_CODE } from '../../worker/src/types.ts';

test('VERDICT_CODE matches on-chain uint8 contract (pass=0 fail=1 partial=2 abstain=3)', () => {
  assert.equal(VERDICT_CODE.pass, 0);
  assert.equal(VERDICT_CODE.fail, 1);
  assert.equal(VERDICT_CODE.partial, 2);
  assert.equal(VERDICT_CODE.abstain, 3);
  assert.deepEqual(Object.keys(VERDICT_CODE).sort(), ['abstain', 'fail', 'partial', 'pass']);
});

test('OUTCOME_CODE matches on-chain uint8 contract (release=0 refund=1 abstain=2)', () => {
  assert.equal(OUTCOME_CODE.release, 0);
  assert.equal(OUTCOME_CODE.refund, 1);
  assert.equal(OUTCOME_CODE.abstain, 2);
  assert.deepEqual(Object.keys(OUTCOME_CODE).sort(), ['abstain', 'refund', 'release']);
});

test('verdict codes are unique', () => {
  const vals = Object.values(VERDICT_CODE);
  assert.equal(new Set(vals).size, vals.length);
});
