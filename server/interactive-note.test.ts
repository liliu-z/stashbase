import './__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { registerProjectFolderAsync, runWithFolderRoot } from './folder.ts';
import { createInteractiveNote } from './interactive-note.ts';
import { mount } from './routes/files.ts';
import { mountFileOperationReceipts } from './routes/file-operations.ts';
import { mount as mountProjectFiles } from './routes/project-files.ts';
import { mount as mountMcp } from './routes/mcp-http.ts';
import { registerAttributedAgentSession, unregisterAttributedAgentSession } from './agent-session-registry.ts';
import { DIRECTORY_LINK } from './__tests__/filesystem-links.ts';

test('creates independent notes under concurrent requests and preserves named collisions and project boundaries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-interactive-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  await runWithFolderRoot(root, async () => {
    const notes = await Promise.all(Array.from({ length: 3 }, () => createInteractiveNote({ parentPath: '' })));
    assert.equal(new Set(notes.map((note) => note.path)).size, 3);
    for (const note of notes) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, note.path, 'assets/note.json'), 'utf8')), { title: '', body: '' });
      assert.match(fs.readFileSync(path.join(root, note.entryPath), 'utf8'), /load\('\.\/assets\/note\.json'\)/);
    }
    fs.writeFileSync(path.join(root, notes[0]!.path, 'assets/note.json'), 'user content');
    await assert.rejects(createInteractiveNote({ parentPath: '', name: notes[0]!.path }), /already uses/);
    assert.equal(fs.readFileSync(path.join(root, notes[0]!.path, 'assets/note.json'), 'utf8'), 'user content');
    await assert.rejects(createInteractiveNote({ parentPath: '../outside' }));
    fs.symlinkSync(outside, path.join(root, 'escape'), DIRECTORY_LINK);
    await assert.rejects(createInteractiveNote({ parentPath: 'escape' }));
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

test('cleans up a failed creation without removing content added by another writer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-interactive-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = fs.promises.writeFile;
  t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof write>) => {
    if (String(args[0]).endsWith('index.html')) {
      fs.writeFileSync(path.join(root, 'Untitled', 'keep.txt'), 'other work');
      throw new Error('disk write failed');
    }
    return write(...args);
  });
  await runWithFolderRoot(root, async () => {
    await assert.rejects(createInteractiveNote({ parentPath: '' }), /disk write failed/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'Untitled')), ['keep.txt']);
  });
});

test('HTTP creation returns a usable entry and a receipt prevents duplicate creation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-interactive-http-'));
  await registerProjectFolderAsync(root);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    void runWithFolderRoot(root, () => new Promise<void>((resolve) => { res.once('close', resolve); next(); })).catch(next);
  });
  mountFileOperationReceipts(app);
  mount(app);
  mountProjectFiles(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const token = 'c'.repeat(64);
  mountMcp(app, { webBase: origin, getToken: () => token });
  const create = () => fetch(`${origin}/api/interactive-notes?operationId=one-note`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentPath: '' }),
  });
  const first = await create();
  assert.equal(first.status, 200);
  const created = await first.json() as { path: string; entryPath: string };
  assert.deepEqual(await (await create()).json(), created);
  assert.deepEqual(fs.readdirSync(root), ['Untitled']);
  const html = await (await fetch(`${origin}/asset/${created.entryPath}`)).text();
  assert.match(html, /stashbase-data-request/);
  assert.match(html, /aria-label="Note content"/);
  assert.deepEqual(await (await fetch(`${origin}/asset/${created.path}/assets/note.json`)).json(), { title: '', body: '' });
  const fromAgent = await fetch(`${origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_interactive_note', arguments: { path: root, name: 'Agent note' } } }),
  });
  assert.equal(fromAgent.status, 200);
  const agentResult = await fromAgent.json() as { result: { content: Array<{ text: string }> } };
  const agentNote = JSON.parse(agentResult.result.content[0]!.text) as { entryPath: string };
  assert.equal(path.normalize(agentNote.entryPath), path.join(root, 'Agent note/index.html'));
  assert.equal(fs.readFileSync(agentNote.entryPath, 'utf8'), fs.readFileSync(path.join(root, created.entryPath), 'utf8'));
  registerAttributedAgentSession('interactive-note-other-project', {
    agentId: 'claude', windowId: 'note-test', boundFolder: () => path.join(root, 'Elsewhere'), turnInFlight: () => true,
  });
  t.after(() => unregisterAttributedAgentSession('interactive-note-other-project'));
  const refused = await fetch(`${origin}/api/project/interactive-note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-stashbase-agent-session-id': 'interactive-note-other-project' },
    body: JSON.stringify({ path: root, name: 'Must not exist' }),
  });
  assert.equal(refused.status, 403);
  assert.equal(fs.existsSync(path.join(root, 'Must not exist')), false);
});
