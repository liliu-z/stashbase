import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { filesystemPath } from '../filesystem-path.ts';
import type { ExactSearchOptions } from '../indexer.ts';
import { createRetrieval } from './index.ts';

test('Retrieval reports unavailable semantic mode without invoking its adapter', async () => {
  let called = false;
  const retrieval = createRetrieval({
    sourceAvailable: async () => true,
    hasEmbeddingKey: () => false,
    hybridSearch: async () => {
      called = true;
      return [];
    },
  });

  assert.deepEqual(
    await retrieval.search({ mode: 'hybrid', query: 'architecture', folderRoot: '/project' }),
    { evidence: [], availability: { state: 'unavailable', reason: 'embedding-key-required' }, truncated: false },
  );
  assert.equal(called, false);
});

test('Retrieval reports missing BYOK configuration without invoking vector search', async () => {
  let called = false;
  const retrieval = createRetrieval({
    sourceAvailable: async () => true,
    hasEmbeddingKey: () => false,
    embeddingUnavailableReason: () => 'embedding-key-required',
    hybridSearch: async () => {
      called = true;
      return [];
    },
  });

  const result = await retrieval.search({ mode: 'hybrid', query: 'architecture', folderRoot: '/project' });
  assert.deepEqual(result.availability, { state: 'unavailable', reason: 'embedding-key-required' });
  assert.equal(called, false);
});

test('Retrieval normalizes keyword matches into flat visible-source evidence', async () => {
  const folderRoot = filesystemPath.absolute('/project');
  const retrieval = createRetrieval({
    sourceAvailable: async () => true,
    grep: async () => ({
      files: [{
        path: 'notes/brief.md', totalMatches: 2,
        matches: [
          { line: 4, text: 'System architecture', ranges: [[7, 19]] },
          { line: 9, text: 'architecture diagram', ranges: [[0, 12]] },
        ],
      }],
      truncated: false,
    }),
  });

  const result = await retrieval.search({ mode: 'grep', query: 'architecture', folderRoot });

  assert.deepEqual(result, {
    evidence: [
      { sourcePath: filesystemPath.join(folderRoot, 'notes/brief.md'), snippet: 'System architecture', ranges: [[7, 19]], sourceMatchCount: 2, locator: { line: 4 } },
      { sourcePath: filesystemPath.join(folderRoot, 'notes/brief.md'), snippet: 'architecture diagram', ranges: [[0, 12]], sourceMatchCount: 2, locator: { line: 9 } },
    ],
    availability: { state: 'ready' },
    truncated: false,
  });
});

test('Retrieval applies top_k to keyword evidence and reports truncation', async () => {
  const retrieval = createRetrieval({
    sourceAvailable: async () => true,
    grep: async () => ({
      files: [{
        path: 'notes/brief.md', totalMatches: 2,
        matches: [
          { line: 4, text: 'first match', ranges: [[0, 5]] },
          { line: 9, text: 'second match', ranges: [[0, 6]] },
        ],
      }],
      truncated: false,
    }),
  });

  const result = await retrieval.search({
    mode: 'grep',
    query: 'match',
    folderRoot: '/project',
    topK: 1,
  });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.locator.line, 4);
  assert.deepEqual(result.availability, { state: 'partial', reason: 'truncated' });
  assert.equal(result.truncated, true);
});

test('Retrieval passes exact scope and source filters to MFS grep', async () => {
  let options: ExactSearchOptions | undefined;
  const retrieval = createRetrieval({
    sourceAvailable: async () => true,
    grep: async (_query, _folder, requested) => {
      options = requested;
      return { files: [], truncated: false };
    },
  });

  await retrieval.search({
    mode: 'grep',
    query: 'Needle',
    folderRoot: '/project',
    pathPrefix: '/project/research',
    types: ['pdf', 'docx'],
    caseStrict: true,
    wholeWord: true,
  });

  assert.deepEqual(options, {
    caseStrict: true,
    wholeWord: true,
    pathPrefix: '/project/research',
    extensions: ['.pdf', '.docx'],
  });
});

test('Retrieval preserves semantic source identity and source-safe locators', async () => {
  const folderRoot = filesystemPath.absolute('/project');
  const sourcePath = filesystemPath.join(folderRoot, 'paper.pdf');
  const retrieval = createRetrieval({
    sourceAvailable: async () => true,
    hasEmbeddingKey: () => true,
    hybridSearch: async () => [{
      fileName: sourcePath, chunkIndex: 3, content: 'derived evidence', heading: 'Results',
      startLine: 42, endLine: 45, pdfPage: 7, score: 0.9,
    }],
  });

  const result = await retrieval.search({ mode: 'hybrid', query: 'evidence', folderRoot });

  assert.deepEqual(result.evidence, [{
    sourcePath, snippet: 'derived evidence', heading: 'Results',
    locator: { line: 42, endLine: 45, page: 7 }, score: 0.9, chunkIndex: 3,
  }]);
});

test('Retrieval maps source categories to semantic index extension filters', async () => {
  let extensions: string[] | undefined;
  const retrieval = createRetrieval({
    sourceAvailable: async () => true,
    hasEmbeddingKey: () => true,
    hybridSearch: async (_query, _topK, _folderRoot, _pathPrefix, requestedExtensions) => {
      extensions = requestedExtensions;
      return [];
    },
  });

  await retrieval.search({
    mode: 'hybrid',
    query: 'evidence',
    folderRoot: '/project',
    types: ['pdf', 'docx'],
  });

  assert.deepEqual(extensions, ['.pdf', '.docx']);
});

test('Retrieval remaps scoped semantic legacy-derived hits to their visible source', async () => {
  const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-retrieval-'));
  const sourcePath = path.join(folderRoot, 'paper.pdf');
  try {
    fs.writeFileSync(sourcePath, 'source');
    const retrieval = createRetrieval({
      sourceAvailable: async () => true,
      hasEmbeddingKey: () => true,
      hybridSearch: async () => [{
        fileName: path.join(folderRoot, '.paper.pdf.md'), chunkIndex: 0,
        content: 'derived evidence', heading: '', score: 1,
      }],
    });

    const result = await retrieval.search({ mode: 'hybrid', query: 'evidence', folderRoot });

    assert.deepEqual(result.evidence, [{
      sourcePath: filesystemPath.absolute(sourcePath), snippet: 'derived evidence', heading: '', locator: {}, score: 1, chunkIndex: 0,
    }]);
  } finally {
    fs.rmSync(folderRoot, { recursive: true, force: true });
  }
});

test('both retrieval modes reject deleted, cancelled, failed, and stale prepared sources', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-retrieval-availability-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', `(async () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const assert = require('node:assert/strict');
      os.homedir = () => process.env.HOME;
      const { createRetrieval } = await import('./server/retrieval/index.ts');
      const { preparedTextCandidatePath } = await import('./server/conversion-dispatch.ts');
      const { markCancelled, markFailed, clearRecord } = await import('./server/conversion-status.ts');
      const { closeStateDb } = await import('./server/state-db.ts');
      const { filesystemPath } = await import('./server/filesystem-path.ts');
      const { fileSymlink } = await import('./server/__tests__/filesystem-links.ts');
      const root = path.join(os.homedir(), 'project');
      fs.mkdirSync(root);
      const direct = path.join(root, 'note.md');
      fs.writeFileSync(direct, 'needle');
      let source = direct;
      let legacy = false;
      const retrieval = createRetrieval({
        hasEmbeddingKey: () => true,
        hybridSearch: async () => [{ fileName: legacy ? path.join(root, '.paper.pdf.md') : source,
          chunkIndex: 0, content: 'needle', heading: '', score: 1 }],
        grep: async () => ({ files: [{ path: legacy ? '.paper.pdf.md' : path.relative(root, source),
          totalMatches: 1, matches: [{ line: 1, text: 'needle', ranges: [[0, 6]] }] }], truncated: false }),
      });
      async function expectCount(count, label) {
        for (const mode of ['keyword', 'semantic']) {
          const result = await retrieval.search({ mode, query: 'needle', folderRoot: root });
          assert.equal(result.evidence.length, count, mode + ': ' + label);
          if (count) assert.equal(result.evidence[0].sourcePath, filesystemPath.absolute(source));
        }
      }
      try {
        await expectCount(1, 'live direct source');
        fs.rmSync(direct);
        await expectCount(0, 'external deletion');
        for (const [name, content] of [
          ['paper.pdf', 'needle<!-- stashbase-pdf-conversion: complete -->'],
          ['photo.png', 'needle<!-- stashbase-ocr-conversion: complete -->'],
          ['draft.docx', '<p>needle</p><!-- stashbase-docx-conversion: complete -->'],
        ]) {
          source = path.join(root, name);
          fs.writeFileSync(source, 'source');
          fs.utimesSync(source, 100, 100);
          const prepared = preparedTextCandidatePath(source);
          fs.mkdirSync(path.dirname(prepared), { recursive: true });
          fs.writeFileSync(prepared, content);
          fs.utimesSync(prepared, 200, 200);
          await expectCount(1, name + ' current preparation');
          markCancelled(source);
          await expectCount(0, name + ' cancelled preparation');
          clearRecord(source);
          markFailed(source, 'conversion failed');
          await expectCount(0, name + ' failed preparation');
          clearRecord(source);
          fs.utimesSync(source, 300, 300);
          await expectCount(0, name + ' source newer than preparation');
          fs.utimesSync(source, 100, 100);
          fs.writeFileSync(prepared, 'partial output');
          await expectCount(0, name + ' incomplete preparation');
          fs.writeFileSync(prepared, content);
          if (name === 'paper.pdf') {
            legacy = true;
            await expectCount(1, 'legacy hit maps to current visible source');
            markCancelled(source);
            await expectCount(0, 'availability checked after legacy remap');
            clearRecord(source);
            legacy = false;
          }
          fs.rmSync(prepared);
          await expectCount(0, name + ' missing preparation');
        }
        source = path.join(root, 'clip.wav');
        fs.writeFileSync(source, 'audio fixture');
        assert.equal(preparedTextCandidatePath(source), null);
        await expectCount(0, 'media is excluded from retrieval');
        source = path.join(root, '.private', 'hidden.md');
        fs.mkdirSync(path.dirname(source));
        fs.writeFileSync(source, 'needle');
        await expectCount(0, 'hidden directory');
        const outside = path.join(os.homedir(), 'outside.md');
        fs.writeFileSync(outside, 'needle');
        source = path.join(root, 'link.md');
        if (fileSymlink(outside, source, { diagnostic: console.log })) await expectCount(0, 'symlink outside project');
      } finally { closeStateDb(); }
    })().catch((error) => { console.error(error); process.exitCode = 1; });`], {
      cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, STASHBASE_LOCAL_DATA_ROOT: path.join(home, 'data') },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('availability checks each visible source once and filters before keyword top_k', async () => {
  const checked: string[] = [];
  const retrieval = createRetrieval({
    sourceAvailable: async (source) => { checked.push(source); return source.endsWith('/live.md'); },
    grep: async () => ({ files: ['gone.md', 'live.md'].map((name) => ({
      path: name, totalMatches: 2,
      matches: [1, 2].map((line) => ({ line, text: 'needle', ranges: [[0, 6] as [number, number]] })),
    })), truncated: false }),
  });
  const result = await retrieval.search({ mode: 'grep', query: 'needle', folderRoot: '/project', topK: 1 });
  assert.equal(checked.length, 2);
  assert.equal(result.evidence[0]?.sourcePath, filesystemPath.absolute('/project/live.md'));
  assert.equal(result.truncated, true);
});
