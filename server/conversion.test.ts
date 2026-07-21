import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeStateDb } from './state-db.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('stale final output is invalidated synchronously when conversion is queued', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-conversion-'));
  const previousDataRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(root, 'data');
  try {
    const { maybeConvert } = await import('./conversion.ts');
    const source = path.join(root, 'report.docx');
    const derived = path.join(root, 'report.html');
    const runGate = deferred();
    fs.writeFileSync(source, 'source');
    fs.writeFileSync(derived, 'stale derived output');
    fs.utimesSync(derived, new Date(1_000), new Date(1_000));
    fs.utimesSync(source, new Date(2_000), new Date(2_000));

    const completion = maybeConvert(source, {
      kind: 'test_extract',
      lane: 'light',
      cost: 0,
      matches: (name: string) => name.endsWith('.docx'),
      derivedNote: () => derived,
      convert: async () => {
        await runGate.promise;
        fs.writeFileSync(derived, '<p>fresh searchable text</p>');
      },
      cleanupDerived: () => fs.rmSync(derived, { force: true }),
    });

    assert.ok(completion);
    assert.equal(fs.existsSync(derived), false);
    runGate.resolve();
    await completion;
    assert.equal(fs.readFileSync(derived, 'utf8'), '<p>fresh searchable text</p>');
  } finally {
    closeStateDb();
    if (previousDataRoot == null) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('filesystem-root folder paths retain one separator', async () => {
  const { runWithFolderRoot, toSourcePath } = await import('./folder.ts');
  const { filesystemPath } = await import('./filesystem-path.ts');
  const filesystemRoot = path.parse(process.cwd()).root;
  const child = path.resolve(filesystemRoot, 'nested', 'report.docx');
  assert.equal(filesystemPath.relative(filesystemRoot, child), 'nested/report.docx');
  assert.equal(filesystemPath.join(filesystemRoot, 'nested/report.docx'), filesystemPath.absolute(child));
  await runWithFolderRoot(filesystemRoot, () => {
    assert.equal(toSourcePath('nested/report.docx'), filesystemPath.absolute(child));
  });
  if (process.platform === 'win32') {
    assert.equal(filesystemPath.equal(child, filesystemPath.absolute(child).toUpperCase()), true);
  }
});

test('file operations cancel queued/running conversion work and await release', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-file-guard-'));
  const previousDataRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(root, 'data');
  const source = path.join(root, 'report.docx');
  const secondSource = path.join(root, 'second.docx');
  const queuedSource = path.join(root, 'queued.docx');
  const gate = deferred();
  fs.writeFileSync(source, 'source');
  fs.writeFileSync(secondSource, 'source');
  fs.writeFileSync(queuedSource, 'source');
  try {
    const { cancelConversionAndWait, getScheduledConversion, maybeConvert } = await import('./conversion.ts');
    const { runWithFolderRoot } = await import('./folder.ts');
    const { filesystemPath } = await import('./filesystem-path.ts');
    const { prepareFileOperation } = await import('./routes/files.ts');
    const spec = {
      kind: 'guard_test',
      lane: 'light',
      cost: 0,
      matches: (name: string) => name.endsWith('.docx'),
      derivedNote: (absPath: string) => `${absPath}.html`,
      convert: async (absPath: string, _onProgress?: unknown, signal?: AbortSignal) => {
        await Promise.race([
          gate.promise,
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          }),
        ]);
        fs.writeFileSync(`${absPath}.html`, '<p>done</p>');
      },
      cleanupDerived: (absPath: string) => fs.rmSync(`${absPath}.html`, { force: true }),
    } as const;
    const completion = maybeConvert(source, spec);
    const secondCompletion = maybeConvert(secondSource, spec);
    const queuedCompletion = maybeConvert(queuedSource, spec);
    assert.ok(completion);
    assert.ok(secondCompletion);
    assert.ok(queuedCompletion);
    for (let attempt = 0; attempt < 10 && getScheduledConversion(source)?.state !== 'running'; attempt += 1) {
      await tick();
    }
    assert.equal(getScheduledConversion(source)?.state, 'running');
    assert.equal(getScheduledConversion(queuedSource)?.state, 'queued');
    if (process.platform === 'win32') {
      assert.equal(filesystemPath.canonicalRelative(root, 'REPORT.DOCX'), 'report.docx');
    }
    assert.equal(await runWithFolderRoot(root, () => prepareFileOperation('report.docx')), true);
    assert.equal(getScheduledConversion(source), null);
    assert.equal(await runWithFolderRoot(root, () => prepareFileOperation('queued.docx')), true);
    assert.equal(getScheduledConversion(queuedSource), null);
    await cancelConversionAndWait(secondSource, 'file-operation');
    gate.resolve();
    await Promise.all([completion, secondCompletion, queuedCompletion]);
  } finally {
    gate.resolve();
    closeStateDb();
    if (previousDataRoot == null) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interactive preview interrupts only the source conversion and preserves scoped auxiliary work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-preview-preemption-'));
  const previousDataRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(root, 'data');
  const source = path.join(root, 'meeting.wav');
  const transcript = path.join(root, 'meeting.md');
  const preview = path.join(root, 'meeting.webm');
  fs.writeFileSync(source, 'source');
  try {
    const {
      getScheduledConversion,
      interruptConversionForInteractivePreview,
      maybeConvert,
      runAuxiliaryConversion,
    } = await import('./conversion.ts');
    const conversion = maybeConvert(source, {
      kind: 'preview_preemption_test',
      lane: 'heavy',
      cost: 20,
      matches: () => true,
      derivedNote: () => transcript,
      convert: async (_abs: string, _progress?: unknown, signal?: AbortSignal) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
        });
      },
      cleanupDerived: () => fs.rmSync(transcript, { force: true }),
    });
    assert.ok(conversion);
    for (let attempt = 0; attempt < 10 && getScheduledConversion(source)?.state !== 'running'; attempt += 1) {
      await tick();
    }
    const auxiliary = runAuxiliaryConversion({
      taskKey: preview,
      sourcePath: source,
      lane: 'heavy',
      urgency: 'interactive',
      cost: 2,
      run: async () => { fs.writeFileSync(preview, 'preview'); },
    });

    assert.equal(await interruptConversionForInteractivePreview(source), true);
    await Promise.all([conversion, auxiliary]);
    assert.equal(fs.readFileSync(preview, 'utf8'), 'preview');
  } finally {
    closeStateDb();
    if (previousDataRoot == null) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('converted indexing uses the source hash bound to completed derived output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-bound-index-hash-'));
  const previousDataRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(root, 'data');
  const source = path.join(root, 'meeting.wav');
  const derived = path.join(root, 'meeting.md');
  fs.writeFileSync(source, 'old source bytes');
  let indexedHash: string | undefined;
  try {
    const { maybeConvert, setDerivedNoteIndexer } = await import('./conversion.ts');
    setDerivedNoteIndexer(async (_sourceAbs, _derivedAbs, sourceHash) => {
      indexedHash = sourceHash;
      fs.writeFileSync(source, 'new source bytes');
    });
    const completion = maybeConvert(source, {
      kind: 'bound_hash_test',
      lane: 'heavy',
      cost: 1,
      matches: () => true,
      derivedNote: () => derived,
      derivedReady: () => true,
      indexSourceHash: () => 'a'.repeat(64),
      convert: async () => { fs.writeFileSync(derived, 'timestamped transcript'); },
      cleanupDerived: () => fs.rmSync(derived, { force: true }),
    });
    assert.ok(completion);
    await completion;
    assert.equal(indexedHash, 'a'.repeat(64));
  } finally {
    const { setDerivedNoteIndexer } = await import('./conversion.ts');
    setDerivedNoteIndexer(async () => undefined);
    closeStateDb();
    if (previousDataRoot == null) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
