import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { runAuxiliaryConversion } from './conversion.ts';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('simultaneous cancellation by all coalesced auxiliary waiters aborts native work', async () => {
  const key = path.resolve('/tmp/stashbase-shared-preview-test.webm');
  const source = path.resolve('/tmp/stashbase-shared-preview-test.aiff');
  const first = new AbortController();
  const second = new AbortController();
  let started = 0;
  let aborted = false;
  const run = (signal: AbortSignal) => new Promise<void>((resolve) => {
    started += 1;
    signal.addEventListener('abort', () => {
      aborted = true;
      resolve();
    }, { once: true });
  });
  const options = {
    taskKey: key,
    sourcePath: source,
    lane: 'heavy' as const,
    urgency: 'interactive' as const,
    cost: 1,
    run,
  };

  const left = runAuxiliaryConversion({ ...options, signal: first.signal });
  const right = runAuxiliaryConversion({ ...options, signal: second.signal });
  await tick();
  first.abort(new Error('first client left'));
  second.abort(new Error('second client left'));

  const results = await Promise.allSettled([left, right]);
  await tick();
  assert.equal(started, 1);
  assert.equal(aborted, true);
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
});
