import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  githubImportFailureSchema,
  githubImportRequestSchema,
  githubImportResultSchema,
} from './github-import.ts';

test('a request carries the pasted URL and the chosen folder name', () => {
  assert.deepEqual(
    githubImportRequestSchema.parse({
      folderName: ' notes ',
      url: ' https://github.com/owner/repo ',
    }),
    { folderName: 'notes', url: 'https://github.com/owner/repo' },
  );
});

test('a request may name the location the copy is created in', () => {
  assert.deepEqual(
    githubImportRequestSchema.parse({
      folderName: 'notes',
      location: '/Users/me/Projects',
      url: 'https://github.com/owner/repo',
    }),
    { folderName: 'notes', location: '/Users/me/Projects', url: 'https://github.com/owner/repo' },
  );
  assert.equal(
    githubImportRequestSchema.safeParse({ folderName: 'n', location: '', url: 'https://x' }).success,
    false,
  );
});

test('a request refuses an unknown key, an empty name, and an over-long name', () => {
  assert.equal(
    githubImportRequestSchema.safeParse({ folderName: 'n', rogue: 1, url: 'https://x' }).success,
    false,
  );
  assert.equal(githubImportRequestSchema.safeParse({ folderName: '  ', url: 'https://x' }).success, false);
  assert.equal(
    githubImportRequestSchema.safeParse({ folderName: 'n'.repeat(65), url: 'https://x' }).success,
    false,
  );
});

test('success carries the published destination and nothing about staging', () => {
  assert.deepEqual(
    githubImportResultSchema.parse({ path: '/home/me/repo', stagingRoot: '/tmp/.import-staging-1' }),
    { path: '/home/me/repo' },
  );
});

test('a refusal keeps a code the renderer can switch on', () => {
  assert.deepEqual(
    githubImportFailureSchema.parse({ code: 'UNSUPPORTED_LFS', error: 'Git LFS is not supported.' }),
    { code: 'UNSUPPORTED_LFS', error: 'Git LFS is not supported.' },
  );
});

test('a refusal with a code this build does not know is refused, not guessed at', () => {
  assert.equal(
    githubImportFailureSchema.safeParse({ code: 'FUTURE_REFUSAL', error: 'nope' }).success,
    false,
  );
});

test('a refusal may carry no code at all', () => {
  assert.deepEqual(githubImportFailureSchema.parse({ error: 'Failed to import repository.' }), {
    error: 'Failed to import repository.',
  });
});
