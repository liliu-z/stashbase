import assert from 'node:assert/strict';
import test from 'node:test';
import type { UnsupportedFileSummary } from '../apiTypes';
import {
  formatUnsupportedExtensions,
  onboardingPatchForNotice,
  retainAvailableUnsupportedNotice,
  unseenUnsupportedNotice,
  unsupportedNoticeForDetails,
  unsupportedSummaryForNotice,
} from '../unsupportedFiles';

const summary: UnsupportedFileSummary = {
  sourceCode: 4,
  other: 3,
  otherExtensions: [
    { extension: '.csv', count: 2 },
    { extension: '.json', count: 1 },
  ],
};

test('first-time notice selects only categories that remain unseen', () => {
  assert.deepEqual(unseenUnsupportedNotice(summary, {}), {
    sourceCode: true,
    other: true,
  });
  assert.deepEqual(unseenUnsupportedNotice(summary, { sourceCodeNoticeVersion: 1 }), {
    sourceCode: false,
    other: true,
  });
  assert.deepEqual(unseenUnsupportedNotice(summary, { unsupportedFormatsNoticeVersion: 1 }), {
    sourceCode: true,
    other: false,
  });
  assert.equal(unseenUnsupportedNotice(summary, {
    sourceCodeNoticeVersion: 1,
    unsupportedFormatsNoticeVersion: 1,
  }), null);
});

test('Details includes every category currently present', () => {
  const categories = unsupportedNoticeForDetails(summary);
  assert.deepEqual(categories, { sourceCode: true, other: true });
  assert.deepEqual(unsupportedSummaryForNotice(summary, categories!), summary);
});

test('acknowledgement patch contains only categories shown in the dialog', () => {
  assert.deepEqual(onboardingPatchForNotice({ sourceCode: false, other: true }), {
    unsupportedFormatsNoticeVersion: 1,
  });
  assert.deepEqual(onboardingPatchForNotice({ sourceCode: true, other: false }), {
    sourceCodeNoticeVersion: 1,
  });
});

test('a live listing refresh drops categories that no longer exist', () => {
  assert.deepEqual(retainAvailableUnsupportedNotice(
    { sourceCode: true, other: true },
    { ...summary, sourceCode: 0 },
  ), { sourceCode: false, other: true });
  assert.equal(retainAvailableUnsupportedNotice(
    { sourceCode: true, other: false },
    { ...summary, sourceCode: 0 },
  ), null);
});

test('extension copy is bounded to three stable groups', () => {
  assert.equal(formatUnsupportedExtensions([
    { extension: '.csv', count: 5 },
    { extension: '.json', count: 4 },
    { extension: '.toml', count: 3 },
    { extension: '.xml', count: 2 },
    { extension: '.zip', count: 1 },
  ]), '.csv, .json, .toml and 2 more formats');
});
