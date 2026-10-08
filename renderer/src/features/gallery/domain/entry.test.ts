/** What the shop knows about an entry that the published index has not said
 *  yet, and which name a copy takes. */
import { describe, expect, it } from 'vite-plus/test';

import { enrichedFromSnapshot, type GalleryEntry } from './entry';

const published: GalleryEntry = {
  about: null,
  category: 'course',

  description: 'A course.',

  id: 'cs183b',

  name: 'How to Start a Startup',
  repo: 'https://github.com/owner/repo',
  screenshot: null,
};

const bundled: GalleryEntry = {
  ...published,
  about: 'Why it was made.',

  screenshot: '/api/gallery/image?src=bundled',
};

describe('enrichedFromSnapshot', () => {
  it('fills only the slots the published entry left empty', () => {
    expect(enrichedFromSnapshot(published, [bundled])).toMatchObject({
      about: 'Why it was made.',

      screenshot: '/api/gallery/image?src=bundled',
    });
  });

  it('never overwrites a published value with a bundled one', () => {
    // The index is the service contract. A build shipping a stale introduction must
    // not put it back over the one the gallery just published.
    const fresh = { ...published, about: 'A fresh introduction.' };
    expect(enrichedFromSnapshot(fresh, [bundled]).about).toBe('A fresh introduction.');
  });

  it('leaves an entry the snapshot has never heard of alone', () => {
    expect(enrichedFromSnapshot({ ...published, id: 'new-entry' }, [bundled]).about).toBeNull();
  });
});
