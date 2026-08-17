import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { attachRoot, mount, transientAttachmentPreviewPath } from './attach.ts';

test('transient attachment upload preserves ordered UTF-8 filenames', async (t) => {
  const root = attachRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let uploadedBatch: string | undefined;
  const app = express();
  mount(app);
  const server: HttpServer = app.listen(0, '127.0.0.1');
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (uploadedBatch) fs.rmSync(uploadedBatch, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const body = new FormData();
  body.append('files', new Blob(['pdf bytes'], { type: 'application/pdf' }), '研究报告.pdf');
  body.append('files', new Blob(['more pdf bytes'], { type: 'application/pdf' }), '中文资料.pdf');
  body.append('files', new Blob(['accented pdf bytes'], { type: 'application/pdf' }), 'café.pdf');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/attach`, { method: 'POST', body });

  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const payload = JSON.parse(responseText) as { files: { name: string; path: string }[] };
  const uploadedPaths = payload.files.map((file) => file.path);
  assert.ok(uploadedPaths.every((filePath) => typeof filePath === 'string'));
  uploadedBatch = path.dirname(uploadedPaths[0]);
  assert.deepEqual(payload.files.map((file) => file.name), ['研究报告.pdf', '中文资料.pdf', 'café.pdf']);
  assert.deepEqual(uploadedPaths.map((filePath) => path.basename(filePath)), ['研究报告.pdf', '中文资料.pdf', 'café.pdf']);
});

test('attachment previews reject a transient-tree symlink to an outside file', () => {
  fs.mkdirSync(attachRoot(), { recursive: true, mode: 0o700 });
  const batch = fs.mkdtempSync(path.join(attachRoot(), 'preview-test-'));
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-outside-')), 'secret.png');
  const uploaded = path.join(batch, 'uploaded.png');
  const linked = path.join(batch, 'image.png');
  try {
    fs.writeFileSync(uploaded, 'not an image');
    fs.writeFileSync(outside, 'not an image');
    fs.symlinkSync(outside, linked);

    assert.equal(transientAttachmentPreviewPath(uploaded), fs.realpathSync(uploaded));
    assert.equal(transientAttachmentPreviewPath(linked), null);
  } finally {
    fs.rmSync(batch, { recursive: true, force: true });
    fs.rmSync(path.dirname(outside), { recursive: true, force: true });
  }
});
