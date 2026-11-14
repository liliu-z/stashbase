import './__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearRecord, markCancelled, markFailed } from './conversion-status.ts';
import { derivedNoteFor, registerDerivedSource } from './derived-store.ts';
import { derivedHtmlPathForDocx } from './docx.ts';
import { registerProjectFolderAsync } from './folder.ts';
import { agentContextFile, readProjectFile } from './project-file-reader.ts';
import { registerAttributedAgentSession, unregisterAttributedAgentSession } from './agent-session-registry.ts';
import { withAgentProjectScope } from './project-request-scope.ts';
import { filesystemPath } from './filesystem-path.ts';
import { fileSymlink } from './__tests__/filesystem-links.ts';

test('explicit generic context keeps exact source paths without reading their bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-generic-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await registerProjectFolderAsync(root);
  const names = ['build notes (local).mjs', '.env', 'Makefile'];
  for (const name of names) fs.writeFileSync(path.join(root, name), 'source text');
  const open = t.mock.method(fs.promises, 'open', async () => {
    throw new Error('Context resolution must not open source bytes.');
  });
  for (const name of names) {
    const source = path.join(root, name);
    const context = await agentContextFile(source);
    assert.equal(context.path, filesystemPath.absolute(source));
    assert.equal(context.sourcePath, name);
    assert.equal(context.readPath, name);
    assert.equal(context.sourceFormat, 'generic');
    assert.equal(context.kind, 'direct');
    assert.equal(context.available, true);
    fs.unlinkSync(source);
    await assert.rejects(agentContextFile(source), { status: 404 });
  }
  assert.equal(open.mock.callCount(), 0);
});

test('prepared reads and context require a current source and complete output, including legacy derived paths', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-prepared-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await registerProjectFolderAsync(root);
  for (const format of ['pdf', 'docx'] as const) {
    await t.test(format, async () => {
      const source = path.join(root, `document.${format}`);
      fs.writeFileSync(source, 'source bytes');
      fs.utimesSync(source, 100, 100);
      registerDerivedSource(source);
      const derived = format === 'docx' ? derivedHtmlPathForDocx(source) : derivedNoteFor(source);
        fs.mkdirSync(path.dirname(derived), { recursive: true });
        fs.writeFileSync(derived, format === 'docx'
          ? '<p>prepared document</p>\n<!-- stashbase-docx-conversion: complete -->'
          : 'prepared document\n<!-- stashbase-pdf-conversion: complete -->');
      const completed = fs.readFileSync(derived, 'utf8');
      assert.equal((await agentContextFile(source)).available, true);
      const read = await readProjectFile(source);
      assert.equal(read.content, completed);
      assert.equal(read.path, filesystemPath.absolute(source));
      assert.ok(read.version);
      assert.deepEqual(await readProjectFile(derived), read);
      const window = await readProjectFile(derived, { offset: 1, limit: 1 });
      assert.equal(window.partial, true);
      assert.equal(window.version, undefined);

      const unavailable = async () => {
        assert.equal((await agentContextFile(source)).available, false);
        for (const target of [source, derived]) {
          await assert.rejects(readProjectFile(target), { status: 409, code: 'CONVERSION_NOT_READY' });
        }
      };
      fs.writeFileSync(derived, 'partial output');
      await unavailable();
      fs.writeFileSync(derived, completed);
      for (const fail of [() => markCancelled(source), () => markFailed(source, 'failed extraction')]) {
        fail();
        await unavailable();
        clearRecord(source);
      }
      assert.equal((await agentContextFile(source)).available, true);
      const future = new Date(Date.now() + 10_000);
      fs.utimesSync(source, future, future);
      await unavailable();
      fs.unlinkSync(source);
      await assert.rejects(agentContextFile(source), { status: 404 });
      for (const target of [source, derived]) await assert.rejects(readProjectFile(target), { status: 404 });
    });
  }
});

test('legacy derived reads retain project scope, source containment, and the bounded-read limit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-prepared-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  fs.mkdirSync(project); fs.mkdirSync(other);
  await registerProjectFolderAsync(project);
  await registerProjectFolderAsync(other);
  const source = path.join(project, 'document.pdf');
  fs.writeFileSync(source, 'source');
  registerDerivedSource(source);
  const derived = derivedNoteFor(source);
  fs.mkdirSync(path.dirname(derived), { recursive: true });
  fs.writeFileSync(derived, 'prepared\n<!-- stashbase-pdf-conversion: complete -->');
  registerAttributedAgentSession('other-project', {
    agentId: 'claude', windowId: 'scope', boundFolder: () => other, turnInFlight: () => true,});
  t.after(() => unregisterAttributedAgentSession('other-project'));
  await assert.rejects(withAgentProjectScope('other-project', () => readProjectFile(derived)), { code: 'PROJECT_SCOPE_MISMATCH' });
  fs.truncateSync(derived, 8 * 1024 * 1024 + 1);
  await assert.rejects(readProjectFile(derived, { limit: 1 }), { code: 'FILE_TOO_LARGE' });
  fs.unlinkSync(source);
  const outside = path.join(root, 'outside.pdf');
  fs.writeFileSync(outside, 'outside');
  if (fileSymlink(outside, source, t)) await assert.rejects(readProjectFile(derived), { status: 404 });
});


test('media remains a project file but has no prepared content or Agent read path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-media-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await registerProjectFolderAsync(root);
  const { listFilesAsync, listImmediateDirectoryAsync } = await import('./file-listing.ts');
  const { runWithFolderRoot } = await import('./folder.ts');
  const { reprocessFileInFolder } = await import('./routes/indexing.ts');
  const { queueConvertibleSource, currentPreparedTextPathAsync } = await import('./conversion-dispatch.ts');
  for (const name of ['recording.wav', 'movie.mp4']) {
    const source = path.join(root, name);
    const bytes = Buffer.from([0, 1, 2, 255]);
    fs.writeFileSync(source, bytes);
    assert.equal(queueConvertibleSource(source), false);
    assert.equal(await currentPreparedTextPathAsync(source), null);
    await assert.rejects(agentContextFile(source), { status: 415, code: 'UNSUPPORTED_FORMAT' });
    await assert.rejects(readProjectFile(source), { status: 415, code: 'UNSUPPORTED_FORMAT' });
    await assert.rejects(reprocessFileInFolder(name, root), { status: 415 });
    assert.deepEqual(fs.readFileSync(source), bytes);
  }
  await runWithFolderRoot(root, async () => {
    assert.deepEqual((await listFilesAsync()).map((file) => file.name).sort(), ['movie.mp4', 'recording.wav']);
    assert.deepEqual(await listImmediateDirectoryAsync(), []);
  });
});
