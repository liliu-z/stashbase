import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { openProjectFolder, clearCurrentFolder } from '../folder.ts';
import { withWindowContext } from '../http.ts';
import { mount } from '../routes/speech.ts';
import { createSpeechModel } from './model.ts';
import { createSpeechService } from './service.ts';

test('HTTP start requires the current explicit project and later calls remain bound to the original window', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-routes-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await fs.mkdir(first);
  await fs.mkdir(second);
  const bytes = Buffer.from('verified model fixture');
  const manifest = { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://model.invalid/model' };
  const model = createSpeechModel({ root, manifest, paused: () => false, setPaused() {}, supported: true });
  await fs.writeFile(path.join(root, `${manifest.sha256}.gguf`), bytes);
  const service = createSpeechService({ root: path.join(root, 'audio'), modelPath: model.path,
    engine: { async load() {}, async begin() {}, async feed() {}, async finish() { return ''; }, async close() {} },
  });
  const app = express();
  app.use(express.json());
  app.use(withWindowContext);
  app.post('/open', async (req, res) => { await openProjectFolder(req.body.path); res.json({ ok: true }); });
  mount(app, model, service);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    await model.close();
    clearCurrentFolder('speech-one');
    clearCurrentFolder('speech-two');
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const call = (endpoint: string, window = 'speech-one', body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(`http://127.0.0.1:${address.port}${endpoint}`, {
    method, headers: { 'content-type': 'application/json', 'x-stashbase-window-id': window },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await call('/open', 'speech-one', { path: first });
  await call('/api/speech/model');
  const input = { id: randomUUID(), conversation: 'original-chat' };
  assert.equal((await call('/api/speech/jobs', 'speech-one', input)).status, 400);
  assert.equal((await call(`/api/speech/jobs?folder=${encodeURIComponent(second)}`, 'speech-one', input)).status, 409);
  assert.equal((await call(`/api/speech/jobs?folder=${encodeURIComponent(first)}`, 'speech-one', { ...input, model: '/arbitrary.gguf' })).status, 400);
  const started = await call(`/api/speech/jobs?folder=${encodeURIComponent(first)}`, 'speech-one', input);
  assert.equal(started.status, 200);
  const endpoint = `/api/speech/jobs/${input.id}`;
  assert.equal((await call(endpoint, 'speech-two')).status, 404);
  await call('/open', 'speech-one', { path: second });
  assert.equal((await call(endpoint)).status, 200, 'navigation may finish into the original conversation');
  assert.equal((await call(endpoint, 'speech-one', undefined, 'DELETE')).status, 200);
  assert.deepEqual(await fs.readdir(path.join(root, 'audio')), []);
});
