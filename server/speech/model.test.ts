import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createSpeechModel } from './model.ts';

const bytes = Buffer.from('GGUF voice model fixture');
const manifest = { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://model.example/pinned.gguf' };
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(5); }
  assert.fail('Model operation did not settle');
}

test('silent preparation shares one transfer; Stop persists, Resume ranges, and verified models are reused offline', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-model-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let paused = false;
  const ranges: (string | null)[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const range = new Headers(init?.headers).get('range');
    ranges.push(range);
    if (range) {
      assert.equal(range, 'bytes=4-');
      return new Response(bytes.subarray(4), { status: 206, headers: { 'Content-Range': `bytes 4-${bytes.length - 1}/${bytes.length}` } });
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 4));
        init?.signal?.addEventListener('abort', () => controller.error(new Error('paused')), { once: true });
      },
    }));
  };
  const options = { root, paused: () => paused, setPaused: (value: boolean) => { paused = value; }, manifest, fetch, supported: true };
  const first = createSpeechModel(options);
  t.after(() => first.close());
  await first.initialize();
  assert.equal(first.status().phase, 'missing');
  assert.equal(ranges.length, 0, 'status reads must not download');
  await Promise.all([first.start(), first.start()]);
  await until(() => first.status().downloadedBytes === 4);
  assert.equal(ranges.length, 1);
  await first.command('stop');
  assert.equal(first.status().phase, 'paused');
  assert.equal(paused, true);
  await assert.rejects(fs.stat(path.join(root, `${manifest.sha256}.gguf`)), { code: 'ENOENT' });
  await first.close();
  const second = createSpeechModel(options);
  t.after(() => second.close());
  await second.start();
  assert.equal(second.status().phase, 'paused');
  assert.equal(ranges.length, 1, 'launch cannot undo an explicit Stop');
  await second.command('resume');
  await until(() => second.status().phase === 'ready');
  assert.deepEqual(await fs.readFile(second.path()!), bytes);
  const offline = createSpeechModel({ ...options, fetch: async () => { throw new Error('Offline'); } });
  t.after(() => offline.close());
  await offline.start();
  assert.equal(offline.status().phase, 'ready');
  assert.equal(offline.path(), second.path());
});

test('corrupt model bytes never publish and explicit retry downloads a fresh verified file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-corrupt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let good = false;
  const model = createSpeechModel({ root, manifest, paused: () => false, setPaused() {}, supported: true,
    fetch: async () => new Response(good ? bytes : Buffer.alloc(bytes.length)),
  });
  t.after(() => model.close());
  await model.start();
  await until(() => model.status().phase === 'failed');
  assert.equal(model.path(), null);
  assert.deepEqual(await fs.readdir(root), []);
  good = true;
  await model.command('retry');
  await until(() => model.status().phase === 'ready');
  assert.deepEqual(await fs.readFile(model.path()!), bytes);
});

test('a resumed response with an incorrect range cannot append or publish bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-range-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, `${manifest.sha256}.gguf.partial`), bytes.subarray(0, 4));
  const model = createSpeechModel({ root, manifest, paused: () => false, setPaused() {}, supported: true,
    fetch: async () => new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` } }),
  });
  t.after(() => model.close());
  await model.start();
  await until(() => model.status().phase === 'failed');
  assert.equal(model.path(), null);
  assert.deepEqual(await fs.readFile(path.join(root, `${manifest.sha256}.gguf.partial`)), bytes.subarray(0, 4));
});
