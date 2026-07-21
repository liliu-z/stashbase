import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const isolatedEnvNames = [
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'XDG_DATA_HOME',
  'STASHBASE_LOCAL_DATA_ROOT',
] as const;

test('MCP library mutations work outside an active folder and enforce versions', async (t) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-library-mutations-'));
  const originalEnv = new Map(isolatedEnvNames.map((name) => [name, process.env[name]]));
  let clearCurrentFolder: (() => void) | undefined;
  let closeStateDb: (() => void) | undefined;
  let closeIndexer: (() => Promise<void>) | undefined;
  let server: HttpServer | undefined;

  t.after(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    clearCurrentFolder?.();
    await closeIndexer?.();
    closeStateDb?.();
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.LOCALAPPDATA = path.join(testHome, 'LocalAppData');
  process.env.XDG_DATA_HOME = path.join(testHome, 'xdg-data');
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(testHome, 'stashbase-data');

  const [
    { default: express },
    folder,
    libraryRoutes,
    mcpRoutes,
    stateDb,
    derivedStore,
    state,
  ] = await Promise.all([
    import('express'),
    import('./folder.ts'),
    import('./routes/library-files.ts'),
    import('./routes/mcp-http.ts'),
    import('./state-db.ts'),
    import('./derived-store.ts'),
    import('./state.ts'),
  ]);
  clearCurrentFolder = folder.clearCurrentFolder;
  closeStateDb = stateDb.closeStateDb;
  closeIndexer = () => state.indexer.close();

  const root = path.join(testHome, 'Library Folder');
  const source = path.join(root, 'Drafts', 'Note.md');
  const target = path.join(root, 'Archive', 'Note.md');
  fs.mkdirSync(root, { recursive: true });
  folder.setCurrentFolder(root);
  folder.clearCurrentFolder();
  assert.equal(folder.getCurrentFolder(), null);

  const app = express();
  app.use(express.json());
  libraryRoutes.mount(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server?.once('listening', resolve);
    server?.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const token = 'a'.repeat(64);
  mcpRoutes.mount(app, { webBase: base, getToken: () => token });

  const created = await callTool(base, token, 'write_file', {
    path: source,
    content: 'version one',
  });
  assert.ok(created.version);
  assert.equal('content' in created, false);
  assert.equal(fs.readFileSync(source, 'utf8'), 'version one');
  assert.equal(folder.getCurrentFolder(), null);

  const updated = await callTool(base, token, 'write_file', {
    path: source,
    content: 'version two',
    baseVersion: created.version,
  });
  assert.ok(updated.version);
  await assert.rejects(
    callTool(base, token, 'write_file', {
      path: source,
      content: 'stale writer',
      baseVersion: created.version,
    }),
    /409|FILE_CHANGED/,
  );

  const edited = await callTool(base, token, 'edit_file', {
    path: source,
    old_text: 'version two',
    new_text: 'version three',
    baseVersion: updated.version,
  });
  assert.equal(edited.replacements, 1);
  assert.equal(fs.readFileSync(source, 'utf8'), 'version three');

  const moved = await callTool(base, token, 'move_file', {
    path: source,
    new_path: target,
  });
  assert.equal(moved.linksUpdated, 0);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'version three');

  const deleted = await callTool(base, token, 'delete_file', { path: target });
  assert.equal(deleted.alreadyGone, false);
  assert.equal(fs.existsSync(target), false);

  const audioSource = path.join(root, 'Recordings', 'meeting.wav');
  const audioTarget = path.join(root, 'Archive', 'meeting.wav');
  fs.mkdirSync(path.dirname(audioSource), { recursive: true });
  fs.writeFileSync(audioSource, Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x80]));
  const staleAudioNote = derivedStore.derivedNoteFor(audioSource);
  const staleAudioTranscript = derivedStore.derivedTranscriptFor(audioSource);
  fs.mkdirSync(path.dirname(staleAudioNote), { recursive: true });
  fs.writeFileSync(staleAudioNote, 'stale transcript');
  fs.writeFileSync(staleAudioTranscript, '{}');

  const movedAudio = await callTool(base, token, 'move_file', {
    path: audioSource,
    new_path: audioTarget,
  });
  assert.equal(movedAudio.path, audioTarget.replace(/\\/g, '/'));
  assert.deepEqual(fs.readFileSync(audioTarget), Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x80]));
  assert.equal(fs.existsSync(staleAudioNote), false);
  assert.equal(fs.existsSync(staleAudioTranscript), false);
  assert.equal(folder.getCurrentFolder(), null);
});

async function callTool(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-${Date.now()}`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await response.json() as any;
  if (!response.ok || body.error) {
    throw new Error(`MCP ${name} failed: ${response.status} ${JSON.stringify(body.error ?? body)}`);
  }
  const result = body.result;
  const text = result?.content?.find((item: any) => item?.type === 'text')?.text;
  if (result?.isError || typeof text !== 'string') {
    throw new Error(`MCP ${name} failed: ${typeof text === 'string' ? text : JSON.stringify(result)}`);
  }
  return JSON.parse(text) as Record<string, any>;
}
