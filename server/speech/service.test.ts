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
  const backend: SpeechEngine = {
    async load() {}, async begin() {}, async feed(pcm) { samples += pcm.length / 2; },
    async finish() { return `Segment ${++segments}.`; }, async close() {}, ...overrides,
  };
  return { backend, samples: () => samples, segments: () => segments };
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
  assert.equal(engine.samples(), 3600 * 16000);
  assert.equal(engine.segments(), 90);
  assert.equal(service.status('one', job.id).text.split('.').filter((part) => part.trim()).length, 90);
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
