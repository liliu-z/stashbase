'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createScheduledTaskScheduler,
  createScheduleServer,
  dueOccurrence,
  runTitle,
} = require('../../dist/electron/scheduled-tasks/scheduler.cjs');

test('scheduled HTTP failures keep request correlation through transport and body timeouts without replay', async () => {
  const calls = [];
  const failure = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
  const server = createScheduleServer('http://127.0.0.1:8090', async (url, init) => {
    calls.push({ url, init, id: new Headers(init.headers).get('x-stashbase-request-id') });
    assert.equal(new Headers(init.headers).get('accept'), 'application/json');
    if (init.method === 'POST') return { ok: true, json: async () => { throw failure; } };
    throw failure;
  });
  for (const run of [() => server.listProjects(), () => server.claim({ folderPath: '/private/project', taskId: 'private-task', trigger: 'manual' }),
    () => server.finish({ folderPath: '/private/project', taskId: 'private-task', runId: 'run', status: 'failed', reason: null, title: null, sessionId: null, agent: null })]) {
    const before = calls.length;
    await assert.rejects(run(), (error) => {
      assert.equal(error.cause, failure);
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.request_id, calls.at(-1).id);
      assert.match(error.request_id, /^[0-9a-f-]{36}$/);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(calls.length, before + 1);
  }
  assert.equal(new Set(calls.map(call => call.id)).size, 3);
});

// Local wall-clock instants, so the rules read the same in every time zone.
const at = (day, hours, minutes = 0) => new Date(2026, 9, day, hours, minutes);
const iso = (date) => date.toISOString();

function task(overrides = {}) {
  return {
    agent: null,
    enabled: true,
    enabledAt: iso(at(10, 12)),
    files: [],
    id: 'brief',
    lastDispatchedAt: null,
    lastOccurrence: null,
    name: 'Daily brief',
    problem: null,
    prompt: 'Pull today’s topics.',
    runs: [],
    time: '08:00',
    ...overrides,
  };
}

test('a daily task is due once its time has passed, once per day', () => {
  assert.equal(dueOccurrence(task(), at(16, 7, 59)), null);
  assert.equal(dueOccurrence(task(), at(16, 8))?.getTime(), at(16, 8).getTime());
  const ranToday = task({ lastDispatchedAt: iso(at(16, 8)), lastOccurrence: iso(at(16, 8)) });
  assert.equal(dueOccurrence(ranToday, at(16, 23)), null);
  assert.equal(dueOccurrence(ranToday, at(17, 8))?.getTime(), at(17, 8).getTime());
});

test('a missed run never runs late; one a few minutes past its time still starts', () => {
  // Closed all of the 15th: launching at 07:00 on the 16th runs nothing,
  // and the 08:00 run that day happens at its time.
  const missed = task({ lastDispatchedAt: iso(at(14, 8)), lastOccurrence: iso(at(14, 8)) });
  assert.equal(dueOccurrence(missed, at(16, 7)), null);
  assert.equal(dueOccurrence(missed, at(16, 8))?.getTime(), at(16, 8).getTime());
  // Waking or launching within five minutes of 08:00 still runs it.
  assert.equal(dueOccurrence(missed, at(16, 8, 5))?.getTime(), at(16, 8).getTime());
  // Asleep through 08:00: waking at 08:06 or at 13:00 runs nothing that day.
  assert.equal(dueOccurrence(missed, at(16, 8, 6)), null);
  assert.equal(dueOccurrence(missed, at(16, 13)), null);

  // Switched on at 15:00: 08:00 that day is not a missed run.
  assert.equal(dueOccurrence(task({ enabledAt: iso(at(16, 15)) }), at(16, 16)), null);
  assert.equal(dueOccurrence(task({ enabled: false }), at(16, 9)), null);
  assert.equal(dueOccurrence(task({ problem: 'Set a time like 08:00.' }), at(16, 9)), null);
});

test('a run is titled with its task and its day', () => {
  assert.equal(runTitle(' Daily brief ', at(16, 8)), 'Daily brief · Oct 16');
});

function harness({ claim, dispatch, projects = [{ folderPath: '/p', tasks: [task()] }], now = at(16, 8, 1) } = {}) {
  const calls = [];
  const scheduler = createScheduledTaskScheduler({
    server: {
      listProjects: async () => projects,
      claim: claim ?? (async (request) => {
        calls.push(['claim', request]);
        return { ok: true, runId: 'run-1', task: { agent: null, files: ['brief.md'], id: request.taskId, name: 'Daily brief', prompt: '', time: '08:00' } };
      }),
      finish: async (request) => { calls.push(['finish', request]); },
    },
    dispatch: dispatch ?? (async (run) => {
      calls.push(['dispatch', run]);
      return { agent: 'claude', sessionId: 'native-1', status: 'sent' };
    }),
    now: () => now,
    setTimer: () => null,
    clearTimer: () => {},
  });
  return { calls, scheduler };
}

test('a due task is claimed for its occurrence, dispatched, and its outcome recorded', async () => {
  const { calls, scheduler } = harness();
  await scheduler.check();
  assert.deepEqual(calls.map(([kind]) => kind), ['claim', 'dispatch', 'finish']);
  assert.deepEqual(calls[0][1], { folderPath: '/p', occurrence: iso(at(16, 8)), taskId: 'brief', trigger: 'schedule' });
  assert.equal(calls[1][1].title, 'Daily brief · Oct 16');
  assert.equal(calls[1][1].runId, 'run-1');
  assert.deepEqual(calls[1][1].task.files, ['brief.md']);
  assert.deepEqual(calls[2][1], {
    agent: 'claude', folderPath: '/p', reason: null, runId: 'run-1', sessionId: 'native-1', status: 'sent', taskId: 'brief', title: 'Daily brief · Oct 16',
  });
});

test('a refused claim dispatches nothing, and a failed dispatch is recorded with its reason', async () => {
  const refused = harness({ claim: async () => ({ ok: false, reason: 'This run already started.' }) });
  await refused.scheduler.check();
  assert.deepEqual(refused.calls, []);

  const broken = harness({ dispatch: async () => { throw new Error('A project window could not be created.'); } });
  await broken.scheduler.check();
  const finish = broken.calls.find(([kind]) => kind === 'finish')[1];
  assert.equal(finish.status, 'failed');
  assert.equal(finish.reason, 'A project window could not be created.');
});

test('Run now runs in the asking window without a scheduled occurrence, one at a time', async () => {
  let release;
  const { calls, scheduler } = harness({
    projects: [],
    dispatch: (run) => new Promise((resolve) => {
      calls.push(['dispatch', run]);
      release = () => resolve({ agent: 'stashbase', sessionId: 'native-2', status: 'sent' });
    }),
  });
  const window = { id: 'window' };
  const first = scheduler.runNow('/p', 'brief', window);
  assert.deepEqual(await scheduler.runNow('/p', 'brief', window), { reason: 'This task is already running.', status: 'failed' });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await first, { agent: 'stashbase', sessionId: 'native-2', status: 'sent' });
  assert.deepEqual(calls[0][1], { folderPath: '/p', taskId: 'brief', trigger: 'manual' });
  assert.equal(calls[1][1].window, window);
});
