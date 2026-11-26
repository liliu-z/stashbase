import assert from 'node:assert/strict';
import test from 'node:test';

import {
  folderSyncResponseSchema,
  indexStatusResponseSchema,
} from './index-status.ts';

const baseline = {
  conversionProgress: {
    'papers/report.pdf': { currentPage: 3, phase: 'extracting' },
    'scans/receipt.png': { lane: 'light', phase: 'queued', tasksAhead: 2 },
  },
  conversionRevision: 12,
  conversionVersions: { 'papers/report.pdf': 4 },
  folder: '/project/research',
  indexed: 10,
  indexWarning: null,
  orphaned: [],
  orphanedCount: 0,
  pending: [],
  pendingConversions: ['papers/report.pdf', 'scans/receipt.png'],
  pendingCount: 0,
  preparationFailures: [
    { attempts: 2, lastError: 'ocr failed', path: 'scans/blurry.jpg', status: 'failed' },
  ],
  semanticIndexing: { state: 'disabled' },
  total: 14,
  treeVersion: 88,
  upToDate: true,
  visibleIndexingSettled: true,
};

test('index status accepts preparation progress phases and durable failures', () => {
  const parsed = indexStatusResponseSchema.parse(baseline);
  assert.equal(parsed.indexReady, false);
  assert.equal(parsed.conversionProgress['papers/report.pdf']?.phase, 'extracting');
  assert.equal(parsed.preparationFailures[0]?.status, 'failed');
});

test('index status rejects an unknown progress phase and an unknown semantic state', () => {
  assert.equal(
    indexStatusResponseSchema.safeParse({
      ...baseline,
      conversionProgress: { 'a.pdf': { phase: 'thinking' } },
    }).success,
    false,
  );
  assert.equal(
    indexStatusResponseSchema.safeParse({
      ...baseline,
      semanticIndexing: { state: 'unknown' },
    }).success,
    false,
  );
});

test('folder sync tolerates change lists and reports only cancellation', () => {
  assert.equal(
    folderSyncResponseSchema.parse({ added: ['a.md'], modified: [], removed: [] }).cancelled,
    undefined,
  );
  assert.equal(folderSyncResponseSchema.parse({ cancelled: true }).cancelled, true);
  assert.throws(() => folderSyncResponseSchema.parse({ cancelled: 'yes' }));
});
