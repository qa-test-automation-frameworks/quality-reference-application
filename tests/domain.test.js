import test from 'node:test';
import assert from 'node:assert/strict';
import { assertClaimAmount, assertTransition, canTransition } from '../src/domain.js';

test('claim lifecycle permits only the declared forward transitions', () => {
  assert.equal(canTransition('submitted', 'under_review'), true);
  assert.equal(canTransition('under_review', 'approved'), true);
  assert.equal(canTransition('under_review', 'rejected'), true);
  assert.equal(canTransition('approved', 'submitted'), false);
  assert.equal(canTransition('rejected', 'under_review'), false);
  assert.equal(canTransition('unknown', 'approved'), false);
  assert.doesNotThrow(() => assertTransition('submitted', 'under_review'));
  assert.throws(() => assertTransition('approved', 'submitted'), { code: 'INVALID_TRANSITION', status: 409 });
});

test('claim amounts use bounded integer USD minor units', () => {
  assert.doesNotThrow(() => assertClaimAmount(1));
  assert.doesNotThrow(() => assertClaimAmount(1_000_000));
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1_000_001, NaN]) {
    assert.throws(() => assertClaimAmount(value), { code: 'INVALID_AMOUNT', status: 422 });
  }
});
