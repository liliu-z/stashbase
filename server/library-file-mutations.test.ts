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
    libraryMutations,
    stateDb,
    derivedStore,
    state,
  ] = await Promise.all([
    import('express'),
    import('./folder.ts'),
    import('./routes/library-files.ts'),
    import('./routes/mcp-http.ts'),
    import('./library-file-mutations.ts'),
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

  const corruptedFormula = `[
P_0=\frac{EPS_{\text{FY28}}\times PE}{1+r}
]`;
  assert.match(corruptedFormula, /[\u0008\u000c]/);
  const corruptedSource = path.join(root, 'Drafts', 'Corrupted formula.md');
  await assert.rejects(
    callTool(base, token, 'write_file', {
      path: corruptedSource,
      content: corruptedFormula,
    }),
    /INVALID_TEXT_CONTENT|String\.raw/,
  );
  assert.equal(fs.existsSync(corruptedSource), false);

  const literalFormula = String.raw`$$
P_0=\frac{EPS_{\text{FY28}}\times PE}{1+r}
$$`;
  const formulaCreated = await callTool(base, token, 'write_file', {
    path: corruptedSource,
    content: literalFormula,
  });
  assert.equal(fs.readFileSync(corruptedSource, 'utf8'), literalFormula);
  await assert.rejects(
    callTool(base, token, 'edit_file', {
      path: corruptedSource,
      old_text: 'PE',
      new_text: corruptedFormula,
      baseVersion: formulaCreated.version,
    }),
    /INVALID_TEXT_CONTENT|String\.raw/,
  );
  assert.equal(fs.readFileSync(corruptedSource, 'utf8'), literalFormula);

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

  const jsonSource = path.join(root, 'Data', 'config.JSON');
  const jsonTarget = path.join(root, 'Archive', 'config.JSON');
  const jsonCreated = await callTool(base, token, 'write_file', {
    path: jsonSource,
    content: '\uFEFF{\r\n  "z": 1,\r\n  "broken":\r\n',
  });
  const jsonRead = await callTool(base, token, 'read_file', { path: jsonSource });
  assert.equal(jsonRead.format, 'json');
  assert.equal(jsonRead.content, '\uFEFF{\r\n  "z": 1,\r\n  "broken":\r\n');
  const jsonEdited = await callTool(base, token, 'edit_file', {
    path: jsonSource,
    old_text: '"z": 1',
    new_text: '"z": 2',
    baseVersion: jsonCreated.version,
  });
  assert.equal(jsonEdited.replacements, 1);
  assert.equal(fs.readFileSync(jsonSource, 'utf8'), '\uFEFF{\r\n  "z": 2,\r\n  "broken":\r\n');
  await assert.rejects(callTool(base, token, 'write_file', {
    path: jsonSource,
    content: '{}',
    baseVersion: jsonCreated.version,
  }), /409|FILE_CHANGED/);
  await callTool(base, token, 'move_file', { path: jsonSource, new_path: jsonTarget });
  assert.equal(fs.existsSync(jsonSource), false);
  assert.equal(fs.readFileSync(jsonTarget, 'utf8').includes('"z": 2'), true);
  await callTool(base, token, 'delete_file', { path: jsonTarget });
  assert.equal(fs.existsSync(jsonTarget), false);

  const textSource = path.join(root, 'Plain', 'README.TXT');
  const textTarget = path.join(root, 'Archive', 'README.TXT');
  const textLinkSource = path.join(root, 'Plain text link.md');
  fs.writeFileSync(textLinkSource, '[Plain text](Plain/README.TXT)\n', 'utf8');
  const textCreated = await callTool(base, token, 'write_file', {
    path: textSource,
    content: '\uFEFF# literal heading\r\n[link](Note.md)\r\n',
  });
  const textRead = await callTool(base, token, 'read_file', { path: textSource });
  assert.equal(textRead.format, 'txt');
  assert.equal(textRead.content, '\uFEFF# literal heading\r\n[link](Note.md)\r\n');
  const textEdited = await callTool(base, token, 'edit_file', {
    path: textSource,
    old_text: 'literal heading',
    new_text: 'literal source',
    baseVersion: textCreated.version,
  });
  assert.equal(textEdited.replacements, 1);
  assert.equal(fs.readFileSync(textSource, 'utf8'), '\uFEFF# literal source\r\n[link](Note.md)\r\n');
  fs.writeFileSync(textSource, '\uFEFFexternal\r\nchange\r\n', 'utf8');
  await assert.rejects(callTool(base, token, 'write_file', {
    path: textSource,
    content: 'stale writer',
    baseVersion: textEdited.version,
  }), /409|FILE_CHANGED/);
  assert.equal(fs.readFileSync(textSource, 'utf8'), '\uFEFFexternal\r\nchange\r\n');
  const textMoved = await callTool(base, token, 'move_file', { path: textSource, new_path: textTarget });
  assert.equal(textMoved.linksUpdated, 1);
  assert.equal(fs.readFileSync(textLinkSource, 'utf8'), '[Plain text](Archive/README.TXT)\n');
  assert.equal(fs.existsSync(textSource), false);
  assert.equal(fs.readFileSync(textTarget, 'utf8'), '\uFEFFexternal\r\nchange\r\n');
  await callTool(base, token, 'delete_file', { path: textTarget });
  assert.equal(fs.existsSync(textTarget), false);

  const invalidText = path.join(root, 'Plain', 'broken.txt');
  fs.mkdirSync(path.dirname(invalidText), { recursive: true });
  const invalidBytes = Buffer.from([0x66, 0x6f, 0x80, 0x6f]);
  fs.writeFileSync(invalidText, invalidBytes);
  await assert.rejects(callTool(base, token, 'read_file', { path: invalidText }), /415|UNSUPPORTED_ENCODING/);
  await assert.rejects(callTool(base, token, 'edit_file', {
    path: invalidText,
    old_text: 'foo',
    new_text: 'bar',
  }), /415|UNSUPPORTED_ENCODING/);
  assert.deepEqual(fs.readFileSync(invalidText), invalidBytes);

  const movedInvalidText = path.join(root, 'Archive', 'broken.txt');
  await callTool(base, token, 'move_file', {
    path: invalidText,
    new_path: movedInvalidText,
  });
  assert.equal(fs.existsSync(invalidText), false);
  assert.deepEqual(fs.readFileSync(movedInvalidText), invalidBytes);
  await callTool(base, token, 'delete_file', { path: movedInvalidText });

  const oversizedText = path.join(root, 'Plain', 'oversized.txt');
  const movedOversizedText = path.join(root, 'Archive', 'oversized.txt');
  fs.writeFileSync(oversizedText, Buffer.alloc((8 * 1024 * 1024) + 1, 0x61));
  await callTool(base, token, 'move_file', {
    path: oversizedText,
    new_path: movedOversizedText,
  });
  assert.equal(fs.existsSync(oversizedText), false);
  assert.equal(fs.statSync(movedOversizedText).size, (8 * 1024 * 1024) + 1);
  await callTool(base, token, 'delete_file', { path: movedOversizedText });

  const opaqueSource = path.join(root, 'Data', 'script.ts');
  fs.writeFileSync(opaqueSource, 'export const value = 1;');
  await assert.rejects(callTool(base, token, 'read_file', { path: opaqueSource }), /415|UNSUPPORTED_FORMAT/);
  await assert.rejects(callTool(base, token, 'move_file', {
    path: opaqueSource,
    new_path: path.join(root, 'Archive', 'script.ts'),
  }), /415|UNSUPPORTED_FORMAT/);
  await assert.rejects(callTool(base, token, 'delete_file', { path: opaqueSource }), /415|UNSUPPORTED_FORMAT/);
  assert.equal(fs.readFileSync(opaqueSource, 'utf8'), 'export const value = 1;');

  const opaqueTarget = path.join(root, 'Archive', 'script.ts');
  const workbenchMoved = await libraryMutations.moveLibraryFile(opaqueSource, opaqueTarget, { allowOpaque: true });
  assert.equal(workbenchMoved.path, opaqueTarget.replace(/\\/g, '/'));
  assert.equal(fs.existsSync(opaqueSource), false);
  assert.equal(fs.readFileSync(opaqueTarget, 'utf8'), 'export const value = 1;');
  const workbenchDeleted = await libraryMutations.deleteLibraryFile(opaqueTarget, { allowOpaque: true });
  assert.equal(workbenchDeleted.alreadyGone, false);
  assert.equal(fs.existsSync(opaqueTarget), false);

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

  // Workbench-visible hidden directories remain outside semantic and
  // Preparation lifecycles when a source is moved into them.
  fs.mkdirSync(path.join(root, '.private'), { recursive: true });
  const hiddenTextSource = path.join(root, 'Archive', 'hidden-bound.md');
  const hiddenTextTarget = path.join(root, '.private', 'hidden-bound.md');
  fs.writeFileSync(hiddenTextSource, '# Hidden-bound note\n');
  const movedHiddenText = await libraryMutations.moveLibraryFile(hiddenTextSource, hiddenTextTarget);
  assert.equal(movedHiddenText.indexWarning, undefined);
  assert.equal(fs.readFileSync(hiddenTextTarget, 'utf8'), '# Hidden-bound note\n');

  const hiddenAudioSource = path.join(root, 'Archive', 'hidden-bound.wav');
  const hiddenAudioTarget = path.join(root, '.private', 'hidden-bound.wav');
  fs.writeFileSync(hiddenAudioSource, Buffer.from([0x52, 0x49, 0x46, 0x46]));
  const movedHiddenAudio = await libraryMutations.moveLibraryFile(hiddenAudioSource, hiddenAudioTarget);
  assert.equal(movedHiddenAudio.indexWarning, undefined);
  assert.equal(fs.existsSync(hiddenAudioTarget), true);
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
