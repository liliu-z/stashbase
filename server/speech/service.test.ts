import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createSpeechService } from './service.ts';
import type { SpeechEngine } from './worker-client.ts';

const frame = Buffer.alloc(32000, 10).toString('base64');
const other = Buffer.alloc(32000, 20).toString('base64');
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { if (await predicate()) return; await delay(5); }
  assert.fail('Recording did not settle');
}
function fakeEngine(overrides: Partial<SpeechEngine> = {}) {
  let samples = 0;
  let segments = 0;
  let segmentSamples = 0;
  let ownedSamples = 0;
  const backend: SpeechEngine = {
    async load() {}, async begin() { segmentSamples = 0; }, async feed(pcm) { samples += pcm.length / 2; segmentSamples += pcm.length / 2; },
    async finish(range = {}) { ownedSamples += (range.endSample ?? segmentSamples) - (range.startSample ?? 0); return `Segment ${++segments}.`; }, async close() {}, ...overrides,
  };
  return { backend, samples: () => samples, ownedSamples: () => ownedSamples, segments: () => segments };
}

test('audio acknowledgements are idempotent, conflicting/out-of-order frames and foreign windows are rejected', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-job-'));
  const engine = fakeEngine();
  const service = createSpeechService({ root, modelPath: () => '/verified.gguf', engine: engine.backend });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const job = await service.start('one', '/project/a', 'chat');
  await assert.rejects(service.start('two', '/project/b', 'other'), /already in use/u);
  assert.throws(() => service.status('two', job.id), /no longer available/u);
  await service.push('one', job.id, 0, frame);
  await service.push('one', job.id, 0, frame);
  await assert.rejects(service.push('one', job.id, 0, other), /cannot be replayed/u);
  await assert.rejects(service.push('one', job.id, 2, frame), /missing an audio sequence/u);
  assert.equal(service.status('one', job.id).text, '', 'partial transcription stays hidden');
  await service.finish('one', job.id, 1);
  await until(() => service.status('one', job.id).phase === 'ready');
  assert.equal(engine.samples(), 16000, 'a lost acknowledgement must not run audio twice');
  assert.equal(service.status('one', job.id).text, 'Segment 1.');
  assert.deepEqual(await fs.readdir(path.join(root, job.id)), []);
  await service.cancel('one', job.id);
  assert.deepEqual(await fs.readdir(root), []);
});

test('long recordings commit bounded segments and release processed audio before Stop', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-long-'));
  const engine = fakeEngine();
  const service = createSpeechService({ root, modelPath: () => '/verified.gguf', engine: engine.backend });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const job = await service.start('one', '/project', 'chat');
  for (let sequence = 0; sequence < 3600; sequence++) await service.push('one', job.id, sequence, frame);
  await until(() => engine.segments() >= 89, 30_000);
  assert.equal(service.status('one', job.id).phase, 'recording');
  assert.equal(service.status('one', job.id).text, '');
  await until(async () => (await fs.readdir(path.join(root, job.id))).length <= 40, 30_000);
  await service.finish('one', job.id, 3600);
  await until(() => service.status('one', job.id).phase === 'ready', 30_000);
  assert.equal(engine.ownedSamples(), 3600 * 16000, 'overlap is decoded again but each sample has one transcript owner');
  assert.ok(engine.samples() > engine.ownedSamples(), 'rollover reuses retained acoustic context');
  assert.equal(service.status('one', job.id).text.split('.').filter((part) => part.trim()).length, engine.segments());
});

test('accelerator failure replays only the retained segment on CPU', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-fallback-'));
  let failed = false;
  let consumed = 0;
  const backends: boolean[] = [];
  const engine = fakeEngine({
    async load(_path, cpu) { backends.push(cpu); },
    async feed() { if (!failed) { failed = true; throw new Error('GPU failure'); } consumed++; },
  });
  const service = createSpeechService({ root, modelPath: () => '/verified.gguf', engine: engine.backend, cpu: false });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const job = await service.start('one', '/project', 'chat');
  await service.push('one', job.id, 0, frame);
  await service.push('one', job.id, 1, frame);
  await service.finish('one', job.id, 2);
  await until(() => service.status('one', job.id).phase === 'ready');
  assert.ok(backends.includes(false) && backends.includes(true));
  assert.equal(consumed, 2);
  assert.equal(service.status('one', job.id).text, 'Segment 1.');
});

test('concurrent result acknowledgements cannot unload the model during a later recording', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-idle-'));
  let closes = 0;
  const engine = fakeEngine({ async close() { closes++; } });
  const service = createSpeechService({ root, modelPath: () => '/verified.gguf', engine: engine.backend });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const first = await service.start('one', '/project', 'chat');
  await service.push('one', first.id, 0, frame);
  await service.finish('one', first.id, 1);
  await until(() => service.status('one', first.id).phase === 'ready');
  const remove = fs.rm;
  let cleanups = 0;
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    const [file] = args;
    if (file === path.join(root, first.id)) {
      // Windows can reject overlapping directory removals. Model that error
      // here as well so Linux cannot hide a duplicate-cleanup race.
      if (++cleanups > 1) throw Object.assign(new Error('Concurrent removal'), { code: 'EPERM' });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return remove(...args);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await Promise.all([service.cancel('one', first.id), service.cancel('one', first.id)]);
  assert.equal(cleanups, 1);
  const next = await service.start('one', '/project', 'chat');
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(closes, 0);
  assert.equal(service.status('one', next.id).phase, 'recording');
});

test('late start cannot resurrect a cancelled recording', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-cancel-'));
  const engine = fakeEngine();
  const service = createSpeechService({ root, modelPath: () => '/verified.gguf', engine: engine.backend });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const id = randomUUID();
  await service.cancel('one', id);
  await assert.rejects(service.start('one', '/project', 'chat', id), /cancelled/u);
  const next = await service.start('one', '/project', 'chat');
  await service.push('one', next.id, 0, frame);
  await service.cancel('one', next.id);
  assert.deepEqual(await fs.readdir(root), []);
});


test('CPU recovery after a committed overlap retains its ownership boundary without duplicating text', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-overlap-retry-'));
  let finishes = 0;
  const ranges: Array<{ startSample?: number; endSample?: number }> = [];
  const backends: boolean[] = [];
  const engine = fakeEngine({
    async load(_path, cpu) { backends.push(cpu); },
    async finish(range = {}) {
      ranges.push(range);
      if (++finishes === 2) throw new Error('Metal finalization failed');
      return finishes === 1 ? 'First.' : 'Second.';
    },
  });
  const service = createSpeechService({ root, modelPath: () => '/verified.gguf', engine: engine.backend, cpu: false });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const job = await service.start('one', '/project', 'chat');
  for (let sequence = 0; sequence < 50; sequence++) await service.push('one', job.id, sequence, frame);
  await service.finish('one', job.id, 50);
  await until(() => service.status('one', job.id).phase === 'ready');
  assert.equal(service.status('one', job.id).text, 'First. Second.');
  assert.ok(backends.includes(true));
  assert.deepEqual(ranges, [{ startSample: 0, endSample: 38 * 16000 }, { startSample: 6 * 16000 }, { startSample: 6 * 16000 }]);
  assert.deepEqual(await fs.readdir(path.join(root, job.id)), []);
});

test('cancellation during retry retirement cannot launch another native worker', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-retry-cancel-'));
  let loads = 0;
  let failFeed = true;
  let closeCalls = 0;
  let holdClose = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const engine = fakeEngine({
    async load() { loads++; },
    async feed() { if (failFeed) { failFeed = false; throw new Error('native failure'); } },
    async close() { closeCalls++; if (holdClose) await gate; },
  });
  const service = createSpeechService({ root, modelPath: () => '/verified.gguf', engine: engine.backend, cpu: true });
  t.after(async () => { release(); await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const job = await service.start('one', '/project', 'chat');
  await service.push('one', job.id, 0, frame);
  await until(() => service.status('one', job.id).phase === 'failed');
  const before = loads;
  holdClose = true;
  const retry = service.retry('one', job.id);
  await until(() => closeCalls === 1);
  const cancel = service.cancel('one', job.id);
  release();
  await Promise.allSettled([retry, cancel]);
  assert.equal(loads, before, 'a cancelled retry must not reload the native model');
  assert.throws(() => service.status('one', job.id), /no longer available/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('overlapping retries share retirement instead of closing a newly restarted worker', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-shared-retry-'));
  let failFeed = true;
  let closeCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const engine = fakeEngine({
    async feed() { if (failFeed) { failFeed = false; throw new Error('native failure'); } },
    async close() { closeCalls++; await gate; },
  });
  const service = createSpeechService({ root, modelPath: () => '/verified.gguf', engine: engine.backend, cpu: true });
  t.after(async () => { release(); await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const job = await service.start('one', '/project', 'chat');
  await service.push('one', job.id, 0, frame);
  await until(() => service.status('one', job.id).phase === 'failed');
  const first = service.retry('one', job.id);
  const second = service.retry('one', job.id);
  await until(() => closeCalls >= 1);
  release();
  await Promise.all([first, second]);
  assert.equal(closeCalls, 1, 'one failed recording has one retry retirement');
  await service.finish('one', job.id, 1);
  await until(() => service.status('one', job.id).phase === 'ready');
  assert.equal(service.status('one', job.id).text, 'Segment 1.');
});
