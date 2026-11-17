import { expect, it } from 'vite-plus/test';

import environment from './environment';

it('retires DOM timers before removing their environment and restores the caller timers', async () => {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const scope = { ...original };
  const fixture = await environment.setup(scope, {});
  let calls = 0;
  const timeout = scope.setTimeout(() => calls++, 0);
  const interval = scope.setInterval(() => calls++, 0);
  try {
    await fixture.teardown(scope);
    // Earlier zero-delay callbacks have queue priority on the next timer turn.
    await nextTimerTurn(0);
    expect(calls).toBe(0);
    expect(scope).toMatchObject(original);
  } finally {
    original.clearTimeout(timeout);
    original.clearInterval(interval);
  }
});
import { setTimeout as nextTimerTurn } from 'node:timers/promises';
