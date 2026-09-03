import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  estimateSemanticWorkload,
  LARGE_SEMANTIC_BYTES_THRESHOLD,
  LARGE_SEMANTIC_SOURCE_THRESHOLD,
} from './semantic-workload.ts';
import { isLiveConvertedIndexRow, publishSemanticPause, syncIndex } from './sync.ts';
import type { Indexer } from './indexer.ts';
import { excludePausedPendingHits, pausedWriteDisposition, prepareForIndex } from './indexer.mfs.ts';
import { filesystemPath } from './filesystem-path.ts';
import { derivedPathsForPdf } from './pdf.ts';
import { derivedHtmlPathForDocx } from './docx.ts';
import { validatePreparedAudioTranscript } from './prepared-validation.ts';
import { bytesToHex } from '@noble/hashes/utils.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { hasNoExtractableText, indexableFileSizeError, MAX_INDEXABLE_BYTES } from './indexable.ts';

function diff(root: string, count: number) {
  return {
    added: Array.from({ length: count }, (_, i) => path.join(root, `note-${i}.md`)),
    modified: [], deleted: [], renamed: [],
  };
}

test('existing converted rows are live only while their source path remains retrieval-eligible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-hidden-converted-row-'));
  try {
    const visible = path.join(root, 'report.pdf');
    const hiddenDir = path.join(root, '.private');
    const hidden = path.join(hiddenDir, 'report.pdf');
    fs.mkdirSync(hiddenDir);
    fs.writeFileSync(visible, '%PDF');
    fs.writeFileSync(hidden, '%PDF');
    assert.equal(isLiveConvertedIndexRow(root, visible), true);
    assert.equal(isLiveConvertedIndexRow(root, hidden), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('semantic workload source threshold is inclusive and ignores hash-reused renames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-preflight-count-'));
  for (let i = 0; i < LARGE_SEMANTIC_SOURCE_THRESHOLD; i++) fs.writeFileSync(path.join(root, `note-${i}.md`), 'x');
  assert.equal((await estimateSemanticWorkload(root, diff(root, LARGE_SEMANTIC_SOURCE_THRESHOLD - 1))).large, false);
  assert.equal((await estimateSemanticWorkload(root, diff(root, LARGE_SEMANTIC_SOURCE_THRESHOLD))).large, true);
  const renamedOnly = {
    added: [], modified: [], deleted: [],
    renamed: [{ old: path.join(root, 'old.md'), new: path.join(root, 'new.md'), fileHash: 'same' }],
  };
  assert.deepEqual(await estimateSemanticWorkload(root, renamedOnly), {
    sourceCount: 0, estimatedBytes: 0, large: false,
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('JSON indexing keeps raw malformed text, extension, source hash, and visible identity', () => {
  const content = '\uFEFF{\r\n  "z": 1,\r\n  "broken":\r\n';
  const prepared = prepareForIndex('/library/Data.JSON', content);
  assert.equal(prepared.text, content);
  assert.equal(prepared.ext, '.json');
  assert.equal(prepared.fileHash, bytesToHex(blake3(new TextEncoder().encode(content))));
});

test('TXT indexing keeps literal UTF-8 text, extension, source hash, and visible identity', () => {
  const content = '\uFEFFheading-like # source\r\n[link](note.md)\r\n';
  const prepared = prepareForIndex('/library/README.TXT', content);
  assert.equal(prepared.text, content);
  assert.equal(prepared.ext, '.txt');
  assert.equal(prepared.fileHash, bytesToHex(blake3(new TextEncoder().encode(content))));
});

test('TXT reconcile removes a stale row instead of indexing invalid UTF-8', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-invalid-txt-reconcile-'));
  try {
    const invalid = path.join(root, 'broken.txt');
    fs.writeFileSync(invalid, Buffer.from([0x6e, 0x65, 0x80, 0x64, 0x6c, 0x65]));
    const upserts: string[] = [];
    const deletes: string[] = [];
    const indexer = {
      syncDiff: async () => ({ added: [], modified: [invalid], deleted: [], renamed: [] }),
      listFiles: async () => ({ [invalid]: 'stale-hash' }),
      upsertFile: async (source: string) => { upserts.push(source); return 1; },
      deleteFile: async (source: string) => { deletes.push(source); },
      renameFile: async () => 1,
      status: async () => ({ pending: [], total: 0, indexed: 0, pendingCount: 0, orphanedCount: 0, orphaned: [], upToDate: true }),
    } as unknown as Indexer;

    const result = await syncIndex(indexer, root, { semanticEnabled: true });

    assert.deepEqual(upserts, []);
    assert.deepEqual(deletes, [invalid]);
    assert.deepEqual(result.modified, []);
    assert.deepEqual(result.failed, [{ name: 'broken.txt', error: 'source text could not be decoded safely' }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('JSON reconcile covers add, modify, delete, and hash-reused rename under source paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-json-reconcile-'));
  try {
    const added = path.join(root, 'added.json');
    const modified = path.join(root, 'modified.JSON');
    const deleted = path.join(root, 'deleted.json');
    const oldName = path.join(root, 'old.json');
    const renamed = path.join(root, 'renamed.JSON');
    fs.writeFileSync(added, '{"added": true}');
    fs.writeFileSync(modified, '{ malformed modified');
    fs.writeFileSync(renamed, '{"same": true}');
    const upserts: Array<[string, string]> = [];
    const deletes: string[] = [];
    const renames: Array<[string, string, string]> = [];
    const indexer = {
      syncDiff: async () => ({
        added: [added], modified: [modified], deleted: [deleted],
        renamed: [{ old: oldName, new: renamed, fileHash: 'same-hash' }],
      }),
      listFiles: async () => ({ [deleted]: 'old', [oldName]: 'same-hash' }),
      upsertFile: async (source: string, content: string) => { upserts.push([source, content]); return 1; },
      deleteFile: async (source: string) => { deletes.push(source); },
      renameFile: async (oldPath: string, newPath: string, content: string) => {
        renames.push([oldPath, newPath, content]); return 1;
      },
      status: async () => ({ pending: [], total: 3, indexed: 3, pendingCount: 0, orphanedCount: 0, orphaned: [], upToDate: true }),
    } as unknown as Indexer;
    const result = await syncIndex(indexer, root, { semanticEnabled: true });
    assert.deepEqual(upserts, [[added, '{"added": true}'], [modified, '{ malformed modified']]);
    assert.deepEqual(deletes, [deleted]);
    assert.deepEqual(renames, [[oldName, renamed, '{"same": true}']]);
    assert.deepEqual(result.added, ['added.json']);
    assert.deepEqual(result.modified, ['modified.JSON']);
    assert.deepEqual(result.removed, ['deleted.json']);
    assert.deepEqual(result.renamed, ['renamed.JSON']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('JSON empty, whitespace, oversized, excluded, and preflight admission follows direct-text rules', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-json-admission-'));
  try {
    const empty = path.join(root, 'empty.json');
    const whitespace = path.join(root, 'space.JSON');
    const normal = path.join(root, 'normal.json');
    const oversized = path.join(root, 'large.json');
    const excluded = path.join(root, 'node_modules', 'hidden.json');
    fs.writeFileSync(empty, '');
    fs.writeFileSync(whitespace, '  \n\t');
    fs.writeFileSync(normal, '{"counted": true}');
    fs.closeSync(fs.openSync(oversized, 'w'));
    fs.truncateSync(oversized, MAX_INDEXABLE_BYTES + 1);
    fs.mkdirSync(path.dirname(excluded), { recursive: true });
    fs.writeFileSync(excluded, '{"hidden": true}');
    assert.equal(indexableFileSizeError(empty), 'empty file');
    assert.equal(hasNoExtractableText(whitespace), true);
    assert.match(indexableFileSizeError(oversized) ?? '', /too large/);
    const estimate = await estimateSemanticWorkload(root, {
      added: [empty, whitespace, normal, oversized, excluded], modified: [], deleted: [], renamed: [],
    });
    assert.deepEqual(estimate, {
      sourceCount: 2,
      estimatedBytes: fs.statSync(whitespace).size + fs.statSync(normal).size,
      large: false,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('semantic workload byte threshold is inclusive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-preflight-'));
  try {
    const sources = Array.from({ length: 13 }, (_, i) => path.join(root, `large-${i}.md`));
    sources.forEach((source, i) => {
      fs.closeSync(fs.openSync(source, 'w'));
      fs.truncateSync(source, i === sources.length - 1 ? 4 * 1024 * 1024 : 8 * 1024 * 1024);
    });
    const estimate = await estimateSemanticWorkload(root, {
      added: sources, modified: [], deleted: [], renamed: [],
    });
    assert.equal(estimate.estimatedBytes, LARGE_SEMANTIC_BYTES_THRESHOLD);
    assert.equal(estimate.large, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('current prepared representations contribute known text volume', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-prepared-volume-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-prepared-data-'));
  const previous = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = dataRoot;
  try {
    const source = path.join(root, 'prepared.pdf');
    fs.writeFileSync(source, '%PDF');
    const derived = derivedPathsForPdf(source).notePath;
    fs.mkdirSync(path.dirname(derived), { recursive: true });
    fs.closeSync(fs.openSync(derived, 'w'));
    fs.truncateSync(derived, LARGE_SEMANTIC_BYTES_THRESHOLD);
    fs.appendFileSync(derived, '\n<!-- stashbase-pdf-conversion: complete -->');
    const estimate = await estimateSemanticWorkload(root, {
      added: [source], modified: [], deleted: [], renamed: [],
    });
    assert.equal(estimate.sourceCount, 1);
    assert.ok(estimate.estimatedBytes >= LARGE_SEMANTIC_BYTES_THRESHOLD);
    assert.equal(estimate.large, true);
  } finally {
    if (previous == null) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('incomplete prepared artifacts are rejected by format freshness authority', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-incomplete-prepared-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-incomplete-data-'));
  const previous = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = dataRoot;
  try {
    const source = path.join(root, 'incomplete.pdf');
    fs.writeFileSync(source, '%PDF');
    const derived = derivedPathsForPdf(source).notePath;
    fs.mkdirSync(path.dirname(derived), { recursive: true });
    fs.closeSync(fs.openSync(derived, 'w'));
    fs.truncateSync(derived, LARGE_SEMANTIC_BYTES_THRESHOLD);
    const estimate = await estimateSemanticWorkload(root, {
      added: [source], modified: [], deleted: [], renamed: [],
    });
    assert.equal(estimate.sourceCount, 1);
    assert.equal(estimate.estimatedBytes, 0);
    assert.equal(estimate.large, false);
  } finally {
    if (previous == null) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('modified convertible sources never reuse prepared volume when mtimes are preserved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-modified-prepared-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-modified-data-'));
  const previous = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = dataRoot;
  try {
    const source = path.join(root, 'preserved-mtime.pdf');
    fs.writeFileSync(source, '%PDF changed bytes');
    const derived = derivedPathsForPdf(source).notePath;
    fs.mkdirSync(path.dirname(derived), { recursive: true });
    fs.closeSync(fs.openSync(derived, 'w'));
    fs.truncateSync(derived, LARGE_SEMANTIC_BYTES_THRESHOLD);
    fs.appendFileSync(derived, '\n<!-- stashbase-pdf-conversion: complete -->');
    const sameTime = new Date('2025-01-01T00:00:00Z');
    fs.utimesSync(source, sameTime, sameTime);
    fs.utimesSync(derived, sameTime, sameTime);

    const estimate = await estimateSemanticWorkload(root, {
      added: [], modified: [source], deleted: [], renamed: [],
    });
    assert.deepEqual(estimate, { sourceCount: 1, estimatedBytes: 0, large: false });
  } finally {
    if (previous == null) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('prepared DOCX validation performs no synchronous full-file read and yields the event loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-async-docx-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-async-docx-data-'));
  const previousDataRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = dataRoot;
  try {
    const source = path.join(root, 'large.docx');
    fs.writeFileSync(source, 'docx');
    const derived = derivedHtmlPathForDocx(source);
    fs.mkdirSync(path.dirname(derived), { recursive: true });
    fs.writeFileSync(derived, `<p>${'searchable '.repeat(100_000)}</p>\n<!-- stashbase-docx-conversion: complete -->`);
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (() => { throw new Error('synchronous prepared-content read'); }) as typeof fs.readFileSync;
    try {
      let timerRan = false;
      const estimatePromise = estimateSemanticWorkload(root, {
        added: [source], modified: [], deleted: [], renamed: [],
      });
      setTimeout(() => { timerRan = true; }, 0);
      const estimate = await estimatePromise;
      assert.equal(timerRan, true, 'validation must not monopolise the server event loop');
      assert.equal(estimate.sourceCount, 1);
      assert.equal(estimate.estimatedBytes, fs.statSync(derived).size);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  } finally {
    if (previousDataRoot == null) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('large audio transcript parsing and schema validation yield the event loop', async () => {
  const segments = Array.from({ length: 50_000 }, (_, index) => ({
    id: index + 1,
    startMs: index,
    endMs: index + 1,
    text: `segment ${index}`,
  }));
  const input = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    source: {
      durationMs: segments.length + 1,
      size: 42,
      mtimeMs: 1,
      statIdentity: '1:2:3',
      contentHash: 'a'.repeat(64),
    },
    provider: { id: 'test', version: '1', model: 'test-model' },
    language: 'en',
    createdAt: '2025-01-01T00:00:00.000Z',
    segments,
  }));
  let timerRan = false;
  const validation = validatePreparedAudioTranscript(input);
  setTimeout(() => { timerRan = true; }, 0);
  const identity = await validation;
  assert.equal(timerRan, true, 'audio validation must not monopolise the server event loop');
  assert.equal(identity.contentHash, 'a'.repeat(64));
});

test('new unprepared convertible sources cross the inclusive source threshold', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-unprepared-pdfs-'));
  try {
    const sources = Array.from({ length: LARGE_SEMANTIC_SOURCE_THRESHOLD }, (_, i) => {
      const source = path.join(root, `paper-${i}.pdf`);
      fs.writeFileSync(source, '%PDF');
      return source;
    });
    const below = await estimateSemanticWorkload(root, {
      added: sources.slice(0, -1), modified: [], deleted: [], renamed: [],
    });
    assert.equal(below.sourceCount, LARGE_SEMANTIC_SOURCE_THRESHOLD - 1);
    assert.equal(below.estimatedBytes, 0);
    assert.equal(below.large, false);
    const boundary = await estimateSemanticWorkload(root, {
      added: sources, modified: [], deleted: [], renamed: [],
    });
    assert.equal(boundary.sourceCount, LARGE_SEMANTIC_SOURCE_THRESHOLD);
    assert.equal(boundary.estimatedBytes, 0);
    assert.equal(boundary.large, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pause is published only after all stale rows are invalidated', async () => {
  const deleted: string[] = [];
  let published = false;
  const failed: { name: string; error: string }[] = [];
  const paused = await publishSemanticPause(
    { deleteFile: async (source) => { deleted.push(source); } },
    '/library', ['/library/a.md', '/library/b.md'],
    { sourceCount: 2, estimatedBytes: 10, large: true }, failed,
    () => { published = true; return true; },
  );
  assert.equal(paused, true);
  assert.deepEqual(deleted, ['/library/a.md', '/library/b.md']);
  assert.equal(published, true);
  assert.deepEqual(failed, []);
});

test('invalidation or persistence failure cannot publish a silent pause', async () => {
  let publishedAfterDeleteFailure = false;
  const failed: { name: string; error: string }[] = [];
  assert.equal(await publishSemanticPause(
    { deleteFile: async () => { throw new Error('daemon unavailable'); } },
    '/library', ['/library/stale.md'],
    { sourceCount: 1, estimatedBytes: 1, large: true }, failed,
    () => { publishedAfterDeleteFailure = true; return true; },
  ), false);
  assert.equal(publishedAfterDeleteFailure, false);
  assert.match(failed[0]?.error ?? '', /daemon unavailable/);

  assert.equal(await publishSemanticPause(
    { deleteFile: async () => undefined }, '/library', ['/library/stale.md'],
    { sourceCount: 1, estimatedBytes: 1, large: true }, [], () => false,
  ), false);
});

test('paused writes retain hash-current rows and invalidate only changed content', () => {
  assert.equal(pausedWriteDisposition(undefined, 'new'), 'index');
  assert.equal(pausedWriteDisposition('same', 'same'), 'retain');
  assert.equal(pausedWriteDisposition('old', 'new'), 'invalidate');
  assert.equal(pausedWriteDisposition(null, 'new'), 'invalidate');
});

test('semantic retrieval excludes every daemon-pending identity while paused', () => {
  const hits = [
    { fileName: '/library/current.md', content: 'current' },
    { fileName: '/library/stale.md', content: 'stale' },
  ];
  assert.deepEqual(excludePausedPendingHits(
    hits,
    new Set([filesystemPath.identity('/library/stale.md')]),
  ), [hits[0]]);
});

test('actual reconcile skips semantic preflight entirely without a key', async () => {
  let scanned = false;
  let published = false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-no-key-'));
  try {
    const result = await syncIndex({
      syncDiff: async () => { scanned = true; throw new Error('must not scan semantic diff'); },
    } as unknown as Indexer, root, {
      semanticEnabled: false,
      shouldPauseEmbedding: () => true,
      publishPaused: () => { published = true; return true; },
    });
    assert.equal(scanned, false);
    assert.equal(published, false);
    assert.deepEqual(result, { added: [], modified: [], removed: [], renamed: [], failed: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hosted quota exhaustion pauses a batch before another embedding request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-quota-pause-'));
  const first = path.join(root, 'first.md');
  const second = path.join(root, 'second.md');
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(second, 'second');
  let available = true;
  const upserts: string[] = [];
  try {
    const result = await syncIndex({
      syncDiff: async () => ({ added: [first, second], modified: [], deleted: [], renamed: [] }),
      listFiles: async () => ({}),
      upsertFile: async (source: string) => {
        upserts.push(source);
        available = false;
        throw new Error('hosted allowance exhausted');
      },
      status: async () => ({ pending: [first, second], total: 2, indexed: 0, pendingCount: 2, orphanedCount: 0, orphaned: [], upToDate: false }),
    } as unknown as Indexer, root, {
      semanticEnabled: true,
      embeddingAvailable: () => available,
    });
    assert.deepEqual(upserts, [first]);
    assert.equal(result.semanticPaused, true);
    assert.equal(result.cancelled, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('actual no-op reconcile neither warns nor publishes a decision', async () => {
  let published = false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-noop-'));
  try {
    const result = await syncIndex({
      syncDiff: async () => ({ added: [], modified: [], deleted: [], renamed: [] }),
      listFiles: async () => ({}),
    } as unknown as Indexer, root, {
      semanticEnabled: true,
      shouldPauseEmbedding: (workload) => workload.large,
      publishPaused: () => { published = true; return true; },
    });
    assert.equal(published, false);
    assert.equal(result.semanticPaused, undefined);
    assert.deepEqual(result.failed, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
