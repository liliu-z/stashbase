import './__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { runWithFolderRoot } from './folder.ts';
import { saveFileContent } from './file-save.ts';
import { indexer } from './state.ts';
import { readTextSnapshotAsync, textVersion } from './text-file-transaction.ts';
import { applyRenamePlanAsync, planRenameLinksAsync } from './links.ts';
import { DIRECTORY_LINK } from './__tests__/filesystem-links.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-text-transactions-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const folder = () => fs.mkdtempSync(path.join(scratch, 'project-'));

test('concurrent versioned saves accept one edit and reject the other without mixing response versions', async (t) => {
  t.mock.method(indexer, 'upsertFile', async () => ({ outcome: 'unchanged' }));
  const root = folder();
  fs.writeFileSync(path.join(root, 'note.md'), 'original');
  const results = await Promise.all(['first', 'second'].map((content) =>
    runWithFolderRoot(root, () => saveFileContent('note.md', content, { baseVersion: textVersion('original') })),
  ).map((operation) => operation.then((value) => ({ value }), (error) => ({ error }))));
  const successes = results.filter((result) => 'value' in result);
  const failures = results.filter((result) => 'error' in result);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].error.code, 'FILE_CHANGED');
  const saved = successes[0].value;
  assert.equal(saved.version, textVersion(saved.content));
  assert.equal(fs.readFileSync(path.join(root, 'note.md'), 'utf8'), saved.content);
});

test('an external edit during save staging is preserved and the failed transaction releases its queue', async (t) => {
  t.mock.method(indexer, 'upsertFile', async () => ({ outcome: 'unchanged' }));
  const root = folder();
  const target = path.join(root, 'note.md');
  fs.writeFileSync(target, 'original');
  const writeFile = fs.promises.writeFile;
  let injected = false;
  const staging = t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
    await writeFile(...args);
    if (!injected && String(args[0]).endsWith('.tmp')) {
      injected = true;
      await writeFile(target, 'external edit');
    }
  });
  await runWithFolderRoot(root, async () => {
    await assert.rejects(saveFileContent('note.md', 'my edit', { baseVersion: textVersion('original') }),
      { code: 'FILE_CHANGED' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'external edit');
    assert.deepEqual(fs.readdirSync(root), ['note.md']);
    staging.mock.restore();
    const saved = await saveFileContent('note.md', 'resolved edit', { baseVersion: textVersion('external edit') });
    assert.equal(saved.version, textVersion('resolved edit'));
  });
});

test('a source snapshot hashes the exact BOM and CRLF bytes returned as content', async () => {
  const root = folder();
  const content = '\uFEFF{\r\n  "value": 1\r\n}\r\n';
  fs.writeFileSync(path.join(root, 'data.json'), content);
  await runWithFolderRoot(root, async () => {
    assert.deepEqual(await readTextSnapshotAsync('data.json'), { content, version: textVersion(content) });
  });
});

test('a rename plan refuses a newer source instead of replacing the new paragraph', async () => {
  const root = folder();
  fs.writeFileSync(path.join(root, 'target.md'), 'target');
  fs.writeFileSync(path.join(root, 'ref.md'), '[target](target.md)\n');
  await runWithFolderRoot(root, async () => {
    const plan = await planRenameLinksAsync([{ kind: 'file', old: 'target.md', new: 'renamed.md' }]);
    fs.renameSync(path.join(root, 'target.md'), path.join(root, 'renamed.md'));
    const edited = '[target](target.md)\nnew user paragraph\n';
    fs.writeFileSync(path.join(root, 'ref.md'), edited);
    const applied = await applyRenamePlanAsync(plan);
    assert.equal(applied.failed.length, 1);
    assert.deepEqual(applied.updated, []);
    assert.equal(fs.readFileSync(path.join(root, 'ref.md'), 'utf8'), edited);
  });
});

test('link rollback restores only unchanged rewrites and preserves later user edits', async () => {
  const root = folder();
  fs.writeFileSync(path.join(root, 'target.md'), 'target');
  for (const name of ['ref.md', 'edited.md']) fs.writeFileSync(path.join(root, name), '[target](target.md)\n');
  await runWithFolderRoot(root, async () => {
    const plan = await planRenameLinksAsync([{ kind: 'file', old: 'target.md', new: 'renamed.md' }]);
    fs.renameSync(path.join(root, 'target.md'), path.join(root, 'renamed.md'));
    const applied = await applyRenamePlanAsync(plan);
    assert.equal(applied.updated.length, 2);
    assert.deepEqual(applied.failed, []);
    const edited = '[target](renamed.md)\nnew user paragraph\n';
    fs.writeFileSync(path.join(root, 'edited.md'), edited);
    await applied.rollback();
    assert.equal(fs.readFileSync(path.join(root, 'ref.md'), 'utf8'), '[target](target.md)\n');
    assert.equal(fs.readFileSync(path.join(root, 'edited.md'), 'utf8'), edited);
  });
});

test('two folder aliases serialize writes to the same source directory entry', async (t) => {
  t.mock.method(indexer, 'upsertFile', async () => ({ outcome: 'unchanged' }));
  const root = folder();
  const alias = path.join(scratch, 'alias');
  try { fs.symlinkSync(root, alias, DIRECTORY_LINK); }
  catch { t.skip('directory symlinks unavailable'); return; }
  fs.writeFileSync(path.join(root, 'note.md'), 'original');
  const results = await Promise.allSettled([root, alias].map((scope, index) =>
    runWithFolderRoot(scope, () => saveFileContent('note.md', `edit ${index}`, { baseVersion: textVersion('original') })),
  ));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failure = results.find((result) => result.status === 'rejected');
  assert.equal(failure?.reason.code, 'FILE_CHANGED');
});

test('cleared sources cannot return stale evidence after a failed index removal; identical saves retry', async (t) => {
  const { sourceAvailable } = await import('./retrieval/availability.ts');
  const root = folder();
  const source = path.join(root, 'note.md');
  fs.writeFileSync(source, 'oldneedle');
  let removals = 0;
  t.mock.method(indexer, 'deleteFile', async () => {
    if (++removals === 1) throw new Error('transport unavailable');
  });
  await runWithFolderRoot(root, async () => {
    const cleared = await saveFileContent('note.md', '');
    assert.equal(fs.readFileSync(source, 'utf8'), '');
    assert.match(cleared.indexWarning ?? '', /transport unavailable/);
    assert.equal(await sourceAvailable(source, root), false);
    const retried = await saveFileContent('note.md', '', { baseVersion: textVersion('oldneedle') });
    assert.equal(retried.version, cleared.version);
    assert.equal(retried.indexWarning, undefined);
    assert.equal(removals, 2);
  });
  // Eligibility is derived from disk, not an in-memory failure flag.
  fs.writeFileSync(source, '\uFEFF \n\t');
  assert.equal(await sourceAvailable(source, root), false);
  fs.writeFileSync(source, 'a new draft');
  assert.equal(await sourceAvailable(source, root), true);
});

test('save submits the current projection without waiting for embedding completion', async (t) => {
  const root = folder();
  const source = path.join(root, 'note.md');
  fs.writeFileSync(source, 'original');
  const accepted: string[] = [];
  t.mock.method(indexer, 'upsertFile', async (target: string, content: string, options?: { waitForIndex?: boolean }) => {
    assert.equal(target, source.replace(/\\/g, '/'));
    assert.equal(fs.readFileSync(source, 'utf8'), content);
    assert.equal(options?.waitForIndex, false);
    accepted.push(content);
    return { outcome: 'updated' };
  });
  await runWithFolderRoot(root, async () => {
    const first = await saveFileContent('note.md', 'first');
    const second = await saveFileContent('note.md', 'second', { baseVersion: first.version });
    assert.equal(second.content, 'second');
  });
  assert.deepEqual(accepted, ['first', 'second']);
});

test('a deleted source refuses a versioned save and is recreated only by an explicit overwrite', async (t) => {
  t.mock.method(indexer, 'upsertFile', async () => ({ outcome: 'unchanged' }));
  const root = folder();
  const note = path.join(root, 'note.md');
  fs.writeFileSync(note, 'original');
  const baseVersion = textVersion('original');
  fs.rmSync(note);

  // Autosave writes against the version it read. With no file there is no such
  // version, so the draft is refused rather than silently recreating the file.
  await assert.rejects(
    runWithFolderRoot(root, () => saveFileContent('note.md', 'my draft', { baseVersion })),
    (error: { code?: string }) => error.code === 'FILE_CHANGED',
  );
  assert.equal(fs.existsSync(note), false);

  // The reader's explicit restore carries no base version, and creates it.
  const restored = await runWithFolderRoot(root, () => saveFileContent('note.md', 'my draft'));
  assert.equal(fs.readFileSync(note, 'utf8'), 'my draft');
  assert.equal(restored.version, textVersion('my draft'));
});

test('an absent-version save creates a sibling but never replaces a concurrently created file', async (t) => {
  t.mock.method(indexer, 'upsertFile', async () => ({ outcome: 'unchanged' }));
  const root = folder();
  await runWithFolderRoot(root, async () => {
    await saveFileContent('form.json', '{"value":1}', { baseVersion: 'absent' });
    assert.equal(fs.readFileSync(path.join(root, 'form.json'), 'utf8'), '{"value":1}');
    await assert.rejects(saveFileContent('form.json', '{"value":2}', { baseVersion: 'absent' }), { code: 'FILE_CHANGED' });
    assert.equal(fs.readFileSync(path.join(root, 'form.json'), 'utf8'), '{"value":1}');
    fs.writeFileSync(path.join(root, 'raced.json'), '{"agent":true}');
    await assert.rejects(saveFileContent('raced.json', '{}', { baseVersion: 'absent' }), { code: 'FILE_CHANGED' });
    fs.symlinkSync(path.join(root, '..'), path.join(root, 'outside'), DIRECTORY_LINK);
    await assert.rejects(saveFileContent('outside/forbidden.json', '{}', { baseVersion: 'absent' }));
  });
});
