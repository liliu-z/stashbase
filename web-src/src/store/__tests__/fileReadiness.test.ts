import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getFileReadiness,
  getPreparationFailure,
  getPreparationProblem,
  hasAggregatePreparationFailure,
} from '../fileReadiness.ts';

test('cancelled preparation remains retryable without being labelled a failure', () => {
  const state = {
    preparationFailures: [{
      path: 'meeting.wav',
      lastError: '',
      attempts: 0,
      status: 'cancelled' as const,
    }],
  };

  assert.equal(getPreparationProblem(state, 'meeting.wav')?.status, 'cancelled');
  assert.equal(getPreparationFailure(state, 'meeting.wav'), undefined);
  assert.equal(getFileReadiness(state, 'meeting.wav').preparationCancellation?.status, 'cancelled');
});

test('folder readiness does not aggregate user cancellation as failure', () => {
  assert.equal(hasAggregatePreparationFailure([
    { path: 'meeting.wav', lastError: '', attempts: 0, status: 'cancelled' },
  ]), false);
  assert.equal(hasAggregatePreparationFailure([
    { path: 'meeting.wav', lastError: 'decoder failed', attempts: 1, status: 'failed' },
  ]), true);
});
