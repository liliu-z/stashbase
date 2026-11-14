import { restoreHistoryAttachments } from '../agent-history-attachments.ts';
import { attachmentPdf } from '../__tests__/attachment-fixtures.ts';
import '../__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerProjectFolderAsync } from '../folder.ts';
import { prepareAgentAttachments } from '../agent-attachments.ts';
import { attachRoot, cleanupStaleAttachments, mount, transientAttachmentPreviewPath } from './attach.ts';
import { fileSymlink } from '../__tests__/filesystem-links.ts';

test('transient attachment upload preserves ordered UTF-8 filenames across file types', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-upload-project-'));
  await registerProjectFolderAsync(project);
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
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
  body.append('folder', project);
  body.append('files', new Blob(['pdf bytes'], { type: 'application/pdf' }), '研究报告.pdf');
  body.append('files', new Blob(['# notes'], { type: 'text/markdown' }), '中文资料.md');
  body.append('files', new Blob(['accented pdf bytes'], { type: 'application/pdf' }), 'café.pdf');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/attach`, { method: 'POST', body });

  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const payload = JSON.parse(responseText) as { files: { name: string; path: string }[] };
  const uploadedPaths = payload.files.map((file) => file.path);
  assert.ok(uploadedPaths.every((filePath) => typeof filePath === 'string'));
  uploadedBatch = path.dirname(uploadedPaths[0]);
  assert.deepEqual(payload.files.map((file) => file.name), ['研究报告.pdf', '中文资料.md', 'café.pdf']);
  assert.deepEqual(uploadedPaths.map((filePath) => path.basename(filePath)), ['研究报告.pdf', '中文资料.md', 'café.pdf']);
  const staleTime = new Date(Date.now() - 25 * 60 * 60_000);
  fs.utimesSync(uploadedBatch, staleTime, staleTime);
  const abandoned = fs.mkdtempSync(path.join(root, 'abandoned-'));
  fs.utimesSync(abandoned, staleTime, staleTime);
  cleanupStaleAttachments(root);
  assert.equal(fs.existsSync(abandoned), false);
  assert.equal(fs.readFileSync(uploadedPaths[0], 'utf8'), 'pdf bytes', 'live draft bytes survive age cleanup');

});

test('attachment previews reject a transient-tree symlink to an outside file', (t) => {
  fs.mkdirSync(attachRoot(), { recursive: true, mode: 0o700 });
  const batch = fs.mkdtempSync(path.join(attachRoot(), 'preview-test-'));
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-outside-')), 'secret.png');
  const uploaded = path.join(batch, 'uploaded.png');
  const linked = path.join(batch, 'image.png');
  try {
    fs.writeFileSync(uploaded, 'not an image');
    fs.writeFileSync(outside, 'not an image');
    if (!fileSymlink(outside, linked, t)) {
      t.skip('this test is only about a file symlink');
      return;
    }

    assert.equal(transientAttachmentPreviewPath(uploaded), fs.realpathSync(uploaded));
    assert.equal(transientAttachmentPreviewPath(linked), null);
  } finally {
    fs.rmSync(batch, { recursive: true, force: true });
    fs.rmSync(path.dirname(outside), { recursive: true, force: true });
  }
});


test('Default prepares only unchanged uploads in its project, with bounded supported content', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-attachment-project-'));
  await registerProjectFolderAsync(project);
  const batches = new Set<string>();
  const app = express();
  mount(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/api/agent/attach`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const batch of batches) fs.rmSync(batch, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });
  const upload = async (name: string, content: string | Uint8Array) => {
    const form = new FormData();
    form.append('folder', project);
    form.append('files', new Blob([typeof content === 'string' ? content : new Uint8Array(content)]), name);
    const response = await fetch(url, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    const result = await response.json() as { files: { path: string }[] };
    batches.add(path.dirname(result.files[0].path));
    return result.files[0].path;
  };
  const signal = new AbortController().signal;
  const text = await upload('资料.csv', 'name,value\nStashBase,42');
  const imageBytes = fs.readFileSync('build/icons/16x16.png');
  const image = await upload('diagram.png', imageBytes);
  const pdfBytes = attachmentPdf();
  const pdf = await upload('report.pdf', pdfBytes);
  // Minimal OOXML fixture with one paragraph, no external resources.
  const docx = await upload('draft.docx', Buffer.from('UEsDBBQAAAAIAI1xTF1Rl+gEsQAAABQBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QvQ7CMAyEX6XKilpXDAyo7QKswMALWInbRjQ/StxS3p4UUAcGRvu7O59c3Z6eYjabwcZa9Mx+DxBlTwZj4TzZRFoXDHIaQwce5R07gm1Z7kA6y2Q55yVDNNWRWhwHzk5zWkftbC2SXWSHj245VQv0ftASOWFYKDTVZaIQtKLsioHPaJIKHi4oUE6OJjmL/zGTVT9dc9e2WtLqX9J8cJJi1LYzQ7ESg9puvj3g/YzmBVBLAwQUAAAACACNcUxdYXsvQ4kAAADyAAAACwAAAF9yZWxzLy5yZWxzjc87DgIhEAbgqxAOsLNaWBigstnWeAECwyMujwwY9fZSWKzGwnLmn3x/Rpxx1T2W3EKsjT3Smpvkofd6BGgmYNJtKhXzSFyhpPsYyUPV5qo9wn6eD0BbgyuxNdliJafF7ji7PCv+YxfnosFTMbeEuf+o+LoYsiaPXfJ7IQv2vZ4Gy0EJ+HhRvQBQSwMEFAAAAAgAjXFMXVuFtS+FAAAApAAAABEAAAB3b3JkL2RvY3VtZW50LnhtbLMpt0rJTy7NTc0rUajIzckrtiq3VcooKSmw0tcvTs5IzU0s1ssvSM0DyqXlF+UmlgC5Ren65flFKQVF+cmpxcWZeem5OfpGBgZm+rmJmXlKdjblVkn5KZUgugBEFIGIEjsXf+eIeMeQEEdnD19Xv5B4f28bfZA4iCwCkwVgEqJXH+EuOwBQSwECFAMUAAAACACNcUxdUZfoBLEAAAAUAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAI1xTF1hey9DiQAAAPIAAAALAAAAAAAAAAAAAACAAeIAAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAI1xTF1bhbUvhQAAAKQAAAARAAAAAAAAAAAAAACAAZQBAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAABIAgAAAAA=', 'base64'));
  const docxParts = await prepareAgentAttachments([docx], project, signal);
  const extracted = Buffer.from(docxParts[0].url.split(',')[1], 'base64').toString();
  assert.match(extracted, /DOCX_ATTACHMENT_OK/);
  assert.match(extracted, /embedded images and page layout are not included/);
  const parts = await prepareAgentAttachments([text, image, pdf], project, signal);
  assert.deepEqual(parts.map(part => part.mime), ['text/plain', 'image/png', 'application/pdf']);
  assert.equal(Buffer.from(parts[0].url.split(',')[1], 'base64').toString(), 'name,value\nStashBase,42');
  assert.deepEqual(Buffer.from(parts[1].url.split(',')[1], 'base64'), imageBytes);
  assert.deepEqual(Buffer.from(parts[2].url.split(',')[1], 'base64'), pdfBytes);
  await assert.rejects(prepareAgentAttachments([text], project + '-other', signal), /this project/);
  await assert.rejects(prepareAgentAttachments([path.join(project, 'secret')], project, signal), /unavailable/);
  fs.writeFileSync(text, 'changed after attaching');
  await assert.rejects(prepareAgentAttachments([text], project, signal), /changed/);
  fs.rmSync(image);
  if (fileSymlink(path.join(project, 'secret'), image, t)) {
    await assert.rejects(prepareAgentAttachments([image], project, signal), /unavailable/);
  }
  const binary = await upload('archive.zip', new Uint8Array([0, 255, 128]));
  await assert.rejects(prepareAgentAttachments([binary], project, signal), /supports UTF-8/);
  const longText = await upload('long.txt', 'x'.repeat(200_001));
  await assert.rejects(prepareAgentAttachments([longText], project, signal), /200,000/);
  const big = await upload('big.txt', 'x'.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(prepareAgentAttachments([big], project, signal), /8 MiB/);
  await assert.rejects(prepareAgentAttachments(Array(11).fill(pdf), project, signal), /10 attachments/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(prepareAgentAttachments([pdf], project, cancelled.signal), { name: 'AbortError' });
  fs.rmSync(pdf);
  await assert.rejects(prepareAgentAttachments([pdf], project, signal), /unavailable/);
  assert.deepEqual(fs.readdirSync(project), [], 'attachments never become project sources');
});

test('history offers previews only while attachment bytes remain safely available', () => {
  fs.mkdirSync(attachRoot(), { recursive: true, mode: 0o700 });
  const batch = fs.mkdtempSync(path.join(attachRoot(), 'history-preview-'));
  const image = path.join(batch, 'image.png');
  const transcript = `Look at this\n\nAttached files:\n- ${image}`;
  try {
    fs.writeFileSync(image, fs.readFileSync('build/icons/16x16.png'));
    assert.ok(restoreHistoryAttachments(transcript).attachments[0].previewUrl);
    fs.unlinkSync(image);
    assert.deepEqual(restoreHistoryAttachments(transcript), {
      text: 'Look at this', attachments: [{ path: image, name: 'image.png' }],
    });
  } finally {
    fs.rmSync(batch, { recursive: true, force: true });
  }
});
