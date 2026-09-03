import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileListingGeneration } from '@/store/lib/fileListingGeneration';

test('new file listings invalidate every older success, failure, and async continuation', () => {
  const listings = createFileListingGeneration();
  let ownsFolder = true;
  const first = listings.begin(() => ownsFolder);
  assert.equal(first.isCurrent(), true);

  const second = listings.begin(() => ownsFolder);
  assert.equal(first.isCurrent(), false, 'an older failure cannot clear the newer listing');
  assert.equal(second.isCurrent(), true);

  const third = listings.begin(() => ownsFolder);
  assert.equal(second.isCurrent(), false, 'an older post-listing stat batch loses ownership too');
  assert.equal(third.isCurrent(), true);
  ownsFolder = false;
  assert.equal(third.isCurrent(), false, 'folder ownership remains part of the same boundary');
});
