import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfigFile } from './app-config.ts';
import {
  createScheduledTaskStore,
  parseScheduleFile,
  withTask,
  withoutTask,
} from './scheduled-tasks.ts';
import { dueOccurrence, missedRuns, nextRun } from '../shared/scheduled-task-timing.ts';

// Local wall-clock instants, so the rules read the same in every time zone.
const local = (day: number, hours: number, minutes = 0) => new Date(2026, 9, day, hours, minutes);
const timing = (overrides: Partial<Parameters<typeof missedRuns>[0]> = {}) => ({
  enabled: true,
  enabledAt: local(10, 12).toISOString(),
  lastDispatchedAt: null,
  lastOccurrence: null,
  problem: null,
  time: '08:00',
  ...overrides,
});

test('a task file is read leniently: each bad task says why it cannot run, the rest still run', () => {
  const parsed = parseScheduleFile(JSON.stringify({
    tasks: [
      { name: 'Daily brief', time: '8:00', prompt: 'Pull today\'s topics.', files: ['./workflows/brief.md'], agent: 'Default' },
      { id: 'weekly', name: 'Weekly', time: '25:00', prompt: 'x' },
      { id: 'weekly', name: 'Copy', time: '09:00', prompt: 'x' },
      { name: 'No request', time: '09:00' },
      { name: 'Outside', time: '09:00', files: ['../secrets.md'] },
      { name: 'Robot', time: '09:00', prompt: 'x', agent: 'gpt' },
      'not a task',
    ],
  }));
  assert.equal(parsed.problem, null);
  assert.deepEqual(parsed.tasks[0], {
    agent: 'stashbase',
    files: ['workflows/brief.md'],
    id: 'daily-brief',
    name: 'Daily brief',
    problem: null,
    prompt: 'Pull today\'s topics.',
    time: '08:00',
  });
  assert.deepEqual(parsed.tasks.slice(1).map((task) => [task.id, task.problem]), [
    ['weekly', 'Set a time like 08:00.'],
    ['copy', 'Another task in this project uses the same id.'],
    ['no-request', 'Say what to do, or add a file to follow.'],
    ['outside', 'List each file by its path inside this project.'],
    ['robot', 'Choose Default, Claude or Codex to run this task.'],
    ['task-7', 'This entry is not a task.'],
  ]);
  assert.match(parseScheduleFile('{ tasks: [').problem ?? '', /not valid JSON/);
  assert.match(parseScheduleFile('{"tasks": {}}').problem ?? '', /under "tasks"/);
  assert.deepEqual(parseScheduleFile(null), parseScheduleFile('  '));
});

test('a form edit rewrites only its own task and keeps every field the form does not know', () => {
  const previous = parseScheduleFile(JSON.stringify({
    note: 'shipped with the template',
    tasks: [
      { id: 'brief', name: 'Brief', time: '08:00', prompt: 'old', notes: 'keep me' },
      { name: 'Broken', time: 'soon', extra: [1, 2] },
    ],
  }));
  const edited = withTask(previous, { agent: 'claude', files: [], id: 'brief', name: ' Morning brief ', prompt: 'new', time: '07:30' });
  assert.equal(edited.task.name, 'Morning brief');
  const added = withTask(parseScheduleFile(edited.content), { agent: null, files: ['plan.md'], name: 'Morning brief', prompt: '', time: '18:00' });
  assert.deepEqual(JSON.parse(added.content), {
    note: 'shipped with the template',
    tasks: [
      { id: 'brief', name: 'Morning brief', time: '07:30', prompt: 'new', agent: 'claude', notes: 'keep me' },
      // A task the file states badly is left exactly as it was.
      { name: 'Broken', time: 'soon', extra: [1, 2] },
      // A new task takes its id from its name, unique in the file.
      { id: 'morning-brief', name: 'Morning brief', time: '18:00', prompt: '', files: ['plan.md'] },
    ],
  });
  assert.equal(parseScheduleFile(added.content).tasks[0]?.agent, 'claude');
  assert.deepEqual(JSON.parse(withoutTask(parseScheduleFile(added.content), 'brief')).tasks.map((task: { name: string }) => task.name), ['Broken', 'Morning brief']);
  assert.throws(() => withTask(previous, { agent: null, files: [], id: 'gone', name: 'Gone', prompt: 'x', time: '08:00' }), /no longer in the task file/);
});

function memoryStore(start = '2026-10-16T09:00:00.000Z') {
  let config: AppConfigFile = {};
  let now = new Date(start);
  let ids = 0;
  const io = {
    createId: () => `run-${(ids += 1)}`,
    now: () => now,
    read: () => structuredClone(config),
    readFallback: () => structuredClone(config),
    write: (next: AppConfigFile) => { config = structuredClone(next); },
  };
  return {
    io,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    config: () => config,
    store: createScheduledTaskStore(io),
  };
}

test('one occurrence is claimed at most once, and never one from before the switch was turned on', () => {
  const { store, advance } = memoryStore();
  const root = '/projects/brief';
  const claim = (occurrence: string) => store.claim(root, 'brief', { occurrence, time: '08:00', trigger: 'schedule' });

  assert.deepEqual(claim('2026-10-16T08:00:00.000Z'), { ok: false, refusal: 'disabled' });
  store.setEnabled(root, 'brief', true);
  assert.equal(store.states(root)('brief').enabledAt, '2026-10-16T09:00:00.000Z');
  assert.deepEqual(claim('2026-10-16T08:00:00.000Z'), { ok: false, refusal: 'not-due' });

  const first = claim('2026-10-17T08:00:00.000Z');
  assert.deepEqual(first, { ok: true, runId: 'run-1' });
  assert.deepEqual(claim('2026-10-17T08:00:00.000Z'), { ok: false, refusal: 'running' });
  assert.equal(store.finish(root, 'brief', 'run-1', { agent: 'claude', reason: null, sessionId: 'native-1', status: 'sent', title: 'Brief · Oct 17' }), true);
  assert.deepEqual(claim('2026-10-17T08:00:00.000Z'), { ok: false, refusal: 'already-claimed' });

  const state = store.states(root)('brief');
  assert.equal(state.lastOccurrence, '2026-10-17T08:00:00.000Z');
  assert.equal(state.runs[0]?.status, 'sent');
  assert.equal(state.runs[0]?.sessionId, 'native-1');

  // A manual run does not move the schedule, and a run that already reported
  // cannot report again.
  advance(60_000);
  assert.deepEqual(store.claim(root, 'brief', { trigger: 'manual' }), { ok: true, runId: 'run-2' });
  assert.equal(store.finish(root, 'brief', 'run-1', { agent: null, reason: 'late', sessionId: null, status: 'failed', title: null }), false);
  assert.equal(store.states(root)('brief').lastOccurrence, '2026-10-17T08:00:00.000Z');
  // Switching off and on again starts the schedule from the new moment.
  store.setEnabled(root, 'brief', false);
  advance(60_000);
  store.setEnabled(root, 'brief', true);
  assert.equal(store.states(root)('brief').enabledAt, '2026-10-16T09:02:00.000Z');
});

test('a run missed on an earlier day is listed as missed and never run late', () => {
  // Ran on the 14th, closed all of the 15th, opened at 07:00 on the 16th:
  // nothing runs now, the 15th is missed, and the 16th runs at its time.
  const task = timing({ lastDispatchedAt: local(14, 8).toISOString(), lastOccurrence: local(14, 8).toISOString() });
  assert.equal(dueOccurrence(task, local(16, 7)), null);
  assert.equal(nextRun(task, local(16, 7))?.getTime(), local(16, 8).getTime());
  assert.deepEqual(missedRuns(task, local(16, 7)), { count: 1, first: local(15, 8), last: local(15, 8) });
  // Today's run is due at its time, even late in the day, and is never missed itself.
  assert.equal(dueOccurrence(task, local(16, 23))?.getTime(), local(16, 8).getTime());
  assert.equal(missedRuns(task, local(16, 23))?.count, 1);

  // Never run: every day from the first time after the switch went on.
  assert.deepEqual(missedRuns(timing(), local(16, 7)), { count: 5, first: local(11, 8), last: local(15, 8) });
  assert.equal(missedRuns(timing({ enabledAt: local(10, 7).toISOString() }), local(16, 7))?.count, 6);
  // A day that had a run is never missed, even after the time changed.
  assert.equal(missedRuns(timing({ lastOccurrence: local(15, 9).toISOString(), time: '17:00' }), local(16, 10)), null);
  assert.equal(missedRuns(timing({ lastOccurrence: local(16, 8).toISOString() }), local(16, 9)), null);
  // Days are counted on the calendar, so a 25-hour clock-change day is one.
  assert.equal(missedRuns(timing({ lastOccurrence: local(24, 8).toISOString() }), local(27, 7))?.count, 2);
  assert.equal(missedRuns(timing({ enabled: false }), local(16, 7)), null);
  assert.equal(missedRuns(timing({ problem: 'Set a time like 08:00.' }), local(16, 7)), null);
});

test('a scheduled run keeps the days it missed in history as one entry', () => {
  const { store } = memoryStore(local(10, 12).toISOString());
  const root = '/projects/brief';
  const sent = { agent: 'claude' as const, reason: null, sessionId: 'native', status: 'sent' as const, title: 'Brief' };
  const claim = (day: number) => store.claim(root, 'brief', { occurrence: local(day, 8).toISOString(), time: '08:00', trigger: 'schedule' });
  store.setEnabled(root, 'brief', true);

  assert.deepEqual(claim(11), { ok: true, runId: 'run-1' });
  store.finish(root, 'brief', 'run-1', sent);
  // Closed from the 12th through the 14th.
  assert.deepEqual(claim(15), { ok: true, runId: 'run-3' });
  let runs = store.states(root)('brief').runs;
  assert.deepEqual(runs.map((run) => [run.status, run.missedCount]), [['running', null], ['missed', 3], ['sent', null]]);
  assert.equal(runs[1]?.startedAt, local(12, 8).toISOString());
  assert.equal(runs[1]?.occurrence, local(14, 8).toISOString());

  // The next day's run follows with nothing missed between them.
  store.finish(root, 'brief', 'run-3', sent);
  assert.deepEqual(claim(16), { ok: true, runId: 'run-4' });
  runs = store.states(root)('brief').runs;
  assert.deepEqual(runs.map((run) => run.status), ['running', 'sent', 'missed', 'sent']);
});

test('a spring-forward day records the missed days the list showed, at the task\'s own time', () => {
  // 02:30 does not exist in New York on 2026-03-08; Date moves it to 03:30.
  // The zone is set here, so the clock change happens on every host.
  const zone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const at = (month: number, day: number, hours: number, minutes = 0) => new Date(2026, month - 1, day, hours, minutes);
    // Switched on at 03:00 on the 6th, after that day's 02:30; closed until 04:00 on the 8th.
    const { store } = memoryStore(at(3, 6, 3).toISOString());
    const root = '/projects/brief';
    store.setEnabled(root, 'brief', true);
    const task = timing({ enabledAt: at(3, 6, 3).toISOString(), time: '02:30' });
    const now = at(3, 8, 4);
    const due = dueOccurrence(task, now);
    assert.ok(due);
    assert.equal(due.getHours(), 3);

    // What the list shows before today's run starts.
    const pending = missedRuns(task, now);
    assert.deepEqual(pending, { count: 1, first: at(3, 7, 2, 30), last: at(3, 7, 2, 30) });

    // What the server records when it claims today's moved run.
    assert.equal(store.claim(root, 'brief', { occurrence: due.toISOString(), time: task.time, trigger: 'schedule' }).ok, true);
    const recorded = store.states(root)('brief').runs.find((run) => run.status === 'missed');
    assert.deepEqual(
      [recorded?.missedCount, recorded?.startedAt, recorded?.occurrence],
      [pending.count, pending.first.toISOString(), pending.last.toISOString()],
    );
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test('a sent run takes its first turn\'s outcome once, and history keeps the newest runs', () => {
  const { store, advance } = memoryStore();
  const root = '/projects/brief';
  store.setEnabled(root, 'brief', true);
  for (let day = 0; day < 32; day += 1) {
    advance(60_000);
    const claimed = store.claim(root, 'brief', { trigger: 'manual' });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    store.finish(root, 'brief', claimed.runId, { agent: 'claude', reason: null, sessionId: `native-${day}`, status: 'sent', title: `Brief ${day}` });
  }
  const runs = store.states(root)('brief').runs;
  assert.equal(runs.length, 30);
  assert.equal(runs[0]?.title, 'Brief 31');

  const newest = runs[0]?.runId ?? '';
  assert.equal(runs[0]?.summary, null);
  assert.equal(store.settle(root, 'brief', newest, { reason: 'Rate limited.', status: 'failed', summary: null }), true);
  // Only a sent run takes an outcome: a second report changes nothing.
  assert.equal(store.settle(root, 'brief', newest, { reason: null, status: 'completed', summary: 'Late.' }), false);
  assert.equal(store.settle(root, 'brief', runs[1]?.runId ?? '', {
    reason: null,
    status: 'completed',
    summary: `I couldn't save the brief. ${'x'.repeat(400)}`,
  }), true);
  const after = store.states(root)('brief').runs;
  assert.deepEqual([after[0]?.status, after[0]?.reason, after[0]?.summary, after[1]?.status], ['failed', 'Rate limited.', null, 'completed']);
  // The reply's start is kept within the list's bound.
  assert.match(after[1]?.summary ?? '', /^I couldn't save the brief\. x+$/);
  assert.equal(after[1]?.summary?.length, 300);
});

test('a run left running by an earlier process reads as failed and does not block the next one', () => {
  const first = memoryStore();
  first.store.setEnabled('/p', 'brief', true);
  assert.equal(first.store.claim('/p', 'brief', { trigger: 'manual' }).ok, true);
  assert.equal(first.store.states('/p')('brief').runs[0]?.status, 'running');

  // The next launch reads the same config with no memory of that run.
  const restarted = createScheduledTaskStore({ ...first.io });
  const stale = restarted.states('/p')('brief').runs[0];
  assert.equal(stale?.status, 'failed');
  assert.match(stale?.reason ?? '', /closed before/);
  assert.equal(restarted.claim('/p', 'brief', { trigger: 'manual' }).ok, true);

  // A live run that never reports back stops blocking after its deadline.
  const silent = memoryStore();
  assert.equal(silent.store.claim('/p', 'brief', { trigger: 'manual' }).ok, true);
  silent.advance(11 * 60_000);
  assert.match(silent.store.states('/p')('brief').runs[0]?.reason ?? '', /did not report/);
  assert.equal(silent.store.claim('/p', 'brief', { trigger: 'manual' }).ok, true);
});

test('the routes read, save, switch, claim and finish one registered project, and removal forgets its switches', () => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-scheduled-tasks-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      import express from 'express';
      const config = await import('./server/app-config.ts');
      const { mount } = await import('./server/routes/scheduled-tasks.ts');
      const { removeRecentAsync } = await import('./server/folder.ts');
      const { filesystemPath } = await import('./server/filesystem-path.ts');
      const project = path.join(os.homedir(), 'project');
      // The routes answer with the server's own spelling (C:/... on Windows).
      const root = filesystemPath.absolute(project);
      fs.mkdirSync(project, { recursive: true });
      config.writeAppConfigStrict({ recentFolders: [{ path: project, openedAt: new Date().toISOString() }] });
      const app = express(); app.use(express.json()); mount(app);
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const base = 'http://127.0.0.1:' + server.address().port + '/api/scheduled-tasks';
      const send = (suffix, method, body) => fetch(base + suffix, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const read = async () => (await fetch(base + '?folder=' + encodeURIComponent(project))).json();

      let schedule = await read();
      assert.deepEqual(schedule, { folderPath: root, problem: null, tasks: [], version: null });
      assert.equal((await fetch(base + '?folder=/unregistered')).status, 404);

      const draft = { agent: 'claude', files: ['brief.md'], name: 'Daily brief', prompt: '', time: '08:00' };
      let response = await send('/task', 'PUT', { baseVersion: null, folderPath: project, task: draft });
      assert.equal(response.status, 200);
      const saved = await response.json();
      assert.equal(saved.taskId, 'daily-brief');
      schedule = saved.schedule;
      assert.equal(schedule.tasks[0].id, 'daily-brief');
      assert.equal(schedule.tasks[0].enabled, false);
      const file = path.join(project, '.schedules.json');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].agent, 'claude');

      // The form saw no file, or an older one: either way the newer file wins.
      assert.equal((await send('/task', 'PUT', { baseVersion: null, folderPath: project, task: draft })).status, 409);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.tasks[0].owner = 'template';
      fs.writeFileSync(file, JSON.stringify(raw));
      assert.equal((await send('/task', 'PUT', { baseVersion: schedule.version, folderPath: project, task: draft })).status, 409);
      schedule = await read();
      response = await send('/task', 'PUT', { baseVersion: schedule.version, folderPath: project, task: { ...draft, id: 'daily-brief', name: 'Brief' } });
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].owner, 'template');

      // A file the form could not show is never overwritten from it.
      fs.writeFileSync(file, '{ broken');
      schedule = await read();
      assert.match(schedule.problem, /not valid JSON/);
      assert.equal((await send('/task', 'PUT', { baseVersion: schedule.version, folderPath: project, task: draft })).status, 409);
      assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
      fs.writeFileSync(file, JSON.stringify(raw));

      response = await send('/enabled', 'PUT', { enabled: true, folderPath: project, taskId: 'daily-brief' });
      assert.equal((await response.json()).tasks[0].enabled, true);
      const listed = await (await fetch(base + '/projects')).json();
      assert.deepEqual(listed.projects.map(entry => entry.folderPath), [root]);

      const claim = { folderPath: project, occurrence: new Date(Date.now() - 86_400_000).toISOString(), taskId: 'daily-brief', trigger: 'schedule' };
      assert.equal((await send('/runs', 'POST', claim)).status, 409);
      response = await send('/runs', 'POST', { ...claim, occurrence: new Date(Date.now() + 1000).toISOString() });
      assert.equal(response.status, 200);
      const claimed = await response.json();
      assert.deepEqual(claimed.task.files, ['brief.md']);
      assert.equal((await send('/runs', 'POST', { ...claim, occurrence: undefined, trigger: 'manual' })).status, 409);
      response = await send('/runs', 'PUT', { agent: 'claude', folderPath: project, reason: null, runId: claimed.runId, sessionId: 'native-1', status: 'sent', taskId: 'daily-brief', title: 'Brief · Oct 16' });
      assert.deepEqual(await response.json(), { recorded: true });
      assert.equal((await read()).tasks[0].runs[0].sessionId, 'native-1');
      response = await send('/runs/settled', 'PUT', { folderPath: project, reason: null, runId: claimed.runId, status: 'completed', summary: 'Saved briefs/oct-16.md.', taskId: 'daily-brief' });
      assert.deepEqual(await response.json(), { recorded: true });
      assert.equal((await read()).tasks[0].runs[0].status, 'completed');
      assert.equal((await read()).tasks[0].runs[0].summary, 'Saved briefs/oct-16.md.');
      // The excerpt has a bound the list relies on.
      assert.equal((await send('/runs/settled', 'PUT', { folderPath: project, reason: null, runId: claimed.runId, status: 'completed', summary: 'x'.repeat(301), taskId: 'daily-brief' })).status, 400);
      assert.equal((await send('/runs', 'POST', { ...claim, taskId: 'missing' })).status, 409);

      // Deleting a task forgets its switch, so a new task that takes its id
      // later starts switched off.
      schedule = await read();
      response = await send('/task', 'DELETE', { baseVersion: schedule.version, folderPath: project, taskId: 'daily-brief' });
      assert.deepEqual((await response.json()).tasks, []);
      response = await send('/task', 'PUT', { baseVersion: (await read()).version, folderPath: project, task: { ...draft, name: 'Daily brief' } });
      assert.equal((await response.json()).schedule.tasks[0].enabled, false);
      await send('/enabled', 'PUT', { enabled: true, folderPath: project, taskId: 'daily-brief' });

      await removeRecentAsync(project);
      assert.deepEqual(config.readAppConfigStrict().scheduledTasks, []);
      assert.ok(fs.existsSync(file));
      await new Promise(resolve => server.close(resolve));
    `], { encoding: 'utf8', env: { ...process.env, HOME: temporaryHome, USERPROFILE: temporaryHome }, timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(temporaryHome, { recursive: true, force: true }); }
});
