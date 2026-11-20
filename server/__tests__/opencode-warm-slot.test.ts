import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeWarmSlot } from '../opencode-warm-slot.ts';

function spare(key: string, windowId = 'window', directory = '/project') {
  let closes = 0;
  return { key, windowId, directory, close: async () => { closes++; }, closes: () => closes };
}

test('a spare can be claimed once, only for its matching configuration', async () => {
  const slot = new OpenCodeWarmSlot();
  const entry = spare('first');
  slot.put(entry);
  assert.equal(slot.take('other-project'), undefined);
  assert.equal(slot.take('first'), entry);
  assert.equal(slot.take('first'), undefined, 'concurrent chats must not share a process');
  await slot.clear();
  slot.discard(entry);
  assert.equal(entry.closes(), 0, 'the chat now owns the claimed process');
});

test('a replaced or failed spare cannot retire its successor; scope retirement is bounded', async () => {
  const slot = new OpenCodeWarmSlot();
  const first = spare('first');
  const second = spare('second', 'second-window', '/second-project');
  slot.put(first);
  slot.put(second);
  assert.equal(first.closes(), 1);
  slot.discard(first);
  await slot.clear(entry => entry.windowId === 'window');
  assert.equal(second.closes(), 0);
  await slot.clear(entry => entry.directory === '/second-project');
  assert.equal(second.closes(), 1);
  assert.equal(slot.take('second'), undefined);
});

test('idle expiry retires the spare without closing a claimed chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slot = new OpenCodeWarmSlot(100);
  const unused = spare('unused');
  slot.put(unused);
  t.mock.timers.tick(100);
  assert.equal(unused.closes(), 1);
  assert.equal(slot.take('unused'), undefined);
  const claimed = spare('claimed');
  slot.put(claimed);
  assert.equal(slot.take('claimed'), claimed);
  t.mock.timers.tick(100);
  assert.equal(claimed.closes(), 0);
});

test('retirement waits for native exit', async () => {
  const slot = new OpenCodeWarmSlot();
  let exit!: () => void;
  let retired = false;
  slot.put({ ...spare('slow'), close: () => new Promise<void>(resolve => { exit = resolve; }) });
  const closing = slot.clear().then(() => { retired = true; });
  await Promise.resolve();
  assert.equal(retired, false);
  assert.equal(slot.take('slow'), undefined);
  exit();
  await closing;
  assert.equal(retired, true);
});

for (const trigger of ['expiry', 'replacement', 'discard'] as const) {
  test(`failed spare retirement during ${trigger} stays contained and leaves the next spare usable`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const slot = new OpenCodeWarmSlot(100);
    let fail!: (error: Error) => void;
    const closing = new Promise<void>((_resolve, reject) => { fail = reject; });
    const entry = { ...spare('stalled'), close: () => closing };
    const next = spare('next');
    slot.put(entry);
    if (trigger === 'expiry') t.mock.timers.tick(100);
    else if (trigger === 'replacement') slot.put(next);
    else slot.discard(entry);
    if (trigger !== 'replacement') slot.put(next);
    fail(new Error('Agent process 123 did not finish closing after termination.'));
    // The test runner fails on an unhandled rejection at the detached boundary.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(slot.take('stalled'), undefined);
    assert.equal(slot.take('next'), next);
    assert.equal(next.closes(), 0);
  });
}

test('awaited spare retirement still rejects when native cleanup fails', async () => {
  const slot = new OpenCodeWarmSlot();
  const error = new Error('Agent process 123 did not finish closing after termination.');
  slot.put({ ...spare('stalled'), close: async () => { throw error; } });
  await assert.rejects(slot.clear(), error);
  assert.equal(slot.take('stalled'), undefined);
});

test('another matching turn extends idle expiry without replacing the spare', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slot = new OpenCodeWarmSlot(100);
  const entry = spare('active');
  slot.put(entry);
  t.mock.timers.tick(75);
  assert.equal(slot.refresh('active'), true);
  t.mock.timers.tick(75);
  assert.equal(entry.closes(), 0);
  assert.equal(slot.refresh('another-project'), false);
  t.mock.timers.tick(25);
  assert.equal(entry.closes(), 1);
  assert.equal(slot.refresh('active'), false, 'the next turn must prepare a new spare after expiry');
});
