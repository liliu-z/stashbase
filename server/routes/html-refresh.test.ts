import '../__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { clearCurrentFolder, openProjectFolder, removeRecentAsync } from '../folder.ts';
import { mount } from './files.ts';
import { fileSymlink } from '../__tests__/filesystem-links.ts';

async function harness(t: { after(fn: () => unknown): void }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-html-refresh-'));
  const root = path.join(scratch, 'project');
  const peer = path.join(scratch, 'peer');
  for (const folder of [root, peer]) {
    fs.mkdirSync(path.join(folder, 'seo_geo'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'styles'));
    fs.writeFileSync(path.join(folder, 'seo_geo/data.js'), 'window.DATA = "one";');
    fs.writeFileSync(path.join(folder, 'styles/shell.css'), 'body { color: red; }');
    fs.writeFileSync(path.join(folder, 'seo_geo/board.html'),
      '<link rel="stylesheet" href="../styles/shell.css"><script src="data.js"></script>');
    await openProjectFolder(folder);
  }
  const app = express();
  mount(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearCurrentFolder();
    await removeRecentAsync(root);
    await removeRecentAsync(peer);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const asset = (name: string) => `${origin}/asset/__folder/${encodeURIComponent(encodeURIComponent(root))}/${name}`;
  const version = async () => {
    const response = await fetch(`${origin}/api/files/seo_geo/board.html?folder=${encodeURIComponent(root)}`, { method: 'HEAD' });
    assert.equal(response.status, 204);
    const result = response.headers.get('x-stashbase-file-version');
    assert.ok(result);
    return result;
  };
  return { root, peer, scratch, asset, version };
}

test('HTML preview follows local script and stylesheet edits in its own project', async (t) => {
  const { root, peer, asset, version } = await harness(t);
  const html = fs.readFileSync(path.join(root, 'seo_geo/board.html'), 'utf8');
  const before = await version();
  assert.equal(await version(), before, 'unchanged files must retain the live frame');
  fs.writeFileSync(path.join(peer, 'seo_geo/data.js'), 'window.DATA = "peer";');
  assert.equal(await version(), before, 'the active peer folder cannot invalidate this preview');

  const script = await fetch(asset('seo_geo/data.js'));
  const etag = script.headers.get('etag');
  assert.ok(etag);
  await script.text();
  const data = path.join(root, 'seo_geo/data.js');
  const originalStat = fs.statSync(data);
  fs.writeFileSync(data, 'window.DATA = "two";');
  fs.utimesSync(data, originalStat.atime, originalStat.mtime);
  const afterScript = await version();
  assert.notEqual(afterScript, before, 'same-size data-only edit must invalidate the HTML');
  const updated = await fetch(asset('seo_geo/data.js'), { headers: { 'if-none-match': etag } });
  assert.equal(updated.status, 200, 'reload must not reuse the old script through an imprecise validator');
  assert.equal(await updated.text(), 'window.DATA = "two";');
  assert.match(updated.headers.get('cache-control') ?? '', /no-cache/);

  fs.writeFileSync(path.join(root, 'styles/shell.css'), 'body { color: blue; }');
  assert.notEqual(await version(), afterScript);
  const beforeMissing = await version();
  fs.unlinkSync(data);
  assert.notEqual(await version(), beforeMissing);
  const missing = await version();
  fs.writeFileSync(data, 'window.DATA = "restored";');
  assert.notEqual(await version(), missing);
  assert.equal(fs.readFileSync(path.join(root, 'seo_geo/board.html'), 'utf8'), html);
});

test('HTML dependency checks honor base URLs, entities, and project containment', async (t) => {
  const { root, scratch, version } = await harness(t);
  const outside = path.join(scratch, 'outside.js');
  fs.writeFileSync(outside, 'outside one');
  // Without the link, escape.js is simply missing and the other checks still hold.
  fileSymlink(outside, path.join(root, 'escape.js'), t);
  fs.writeFileSync(path.join(root, 'data&more.js'), 'one');
  fs.writeFileSync(path.join(root, 'seo_geo/board.html'), `
    <base href="../">
    <script src="data&amp;more.js?cache=1#part"></script>
    <script src="escape.js"></script>
    <script src="../outside.js"></script>
    <script src="https://example.test/remote.js"></script>
    <!-- <script src="ignored.js"></script> -->
    <script>const markup = '<script src="ignored.js">';</script>
    <a href="ignored.js">Open another document</a>
  `);
  const before = await version();
  fs.writeFileSync(outside, 'outside two');
  fs.writeFileSync(path.join(root, 'ignored.js'), 'unrelated');
  assert.equal(await version(), before, 'outside files and navigation targets are not preview dependencies');
  fs.writeFileSync(path.join(root, 'data&more.js'), 'two');
  assert.notEqual(await version(), before);
});
