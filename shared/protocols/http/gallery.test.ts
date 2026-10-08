import assert from 'node:assert/strict';
import { test } from 'node:test';

import { galleryEntrySchema, galleryIndexSchema } from './gallery.ts';

const ENTRY = {
  category: 'course',
  description: 'A course.',
  id: 'cs183b',
  name: 'How to Start a Startup',
  repo: 'https://github.com/owner/repo',
};

test('carries an entry that publishes only its required fields', () => {
  const parsed = galleryEntrySchema.parse(ENTRY);
  assert.equal(parsed.screenshot, undefined);
});

test('ignores a field a newer gallery publishes', () => {
  // Additive-only: an index published by a newer gallery must still read here,
  // or shipping one field would break every older build.
  const parsed = galleryEntrySchema.parse({ ...ENTRY, difficulty: 'beginner' });
  assert.equal('difficulty' in parsed, false);
});

test('refuses an offline error envelope without a catalog', () => {
  assert.equal(galleryIndexSchema.safeParse({ error: 'offline' }).success, false);
});

test('refuses the whole index when one entry is unusable', () => {
  // One unusable entry means the publication is wrong; showing the rest would
  // hide that from the publisher as well as the reader.
  const index = galleryIndexSchema.safeParse({

    wikis: [ENTRY, { ...ENTRY, id: '   ' }],
  });
  assert.equal(index.success, false);
});

test('refuses an index longer than a shelf a reader browses', () => {
  // The document comes from a host outside the machine, so the outer array is
  // bounded like every array inside an entry. Refusing it whole falls back to
  // the bundled snapshot.
  const wikis = Array.from({ length: 501 }, (_unused, index) => ({
    ...ENTRY,
    id: `entry-${index}`,
  }));
  assert.equal(galleryIndexSchema.safeParse({ wikis }).success, false);
  assert.equal(
    galleryIndexSchema.safeParse({ wikis: wikis.slice(0, 500) }).success,
    true,
  );
});

test('repository URLs must be accepted by the public GitHub acquisition contract', () => {
  for (const repo of ['plain text', 'https://gitlab.com/owner/repo', 'https://github.com/owner/repo/tree/main',
    'http://github.com/owner/repo', 'https://user:secret@github.com/owner/repo']) {
    assert.equal(galleryIndexSchema.safeParse({ wikis: [ENTRY, { ...ENTRY, id: 'bad', repo }] }).success, false);
  }
  assert.equal(galleryEntrySchema.safeParse({ ...ENTRY, repo: 'https://github.com/owner/repo.git/' }).success, true);
});

const PERSONA = {
  category: 'news',
  description: 'A neutral news report',
  id: 'journalist',
  name: 'Journalist',
  prompt: 'Report what happened.',
};

test('an index without personas still reads, and personas are optional per field', () => {
  // Personas were added after the first publication; absent is not an error.
  assert.equal(galleryIndexSchema.parse({ wikis: [ENTRY] }).personas, undefined);
  const parsed = galleryIndexSchema.parse({ wikis: [], personas: [PERSONA] });
  assert.equal(parsed.personas?.[0]?.sample, undefined);
  assert.equal(parsed.personas?.[0]?.icon, undefined);
});

test('an unknown persona icon reads as none, but an unusable persona refuses the index', () => {
  const parsed = galleryIndexSchema.parse({

    wikis: [],
    personas: [{ ...PERSONA, icon: 'rocket' }],
  });
  assert.equal(parsed.personas?.[0]?.icon, undefined);
  // An id names a file in the reader's library, so a path is refused whole.
  assert.equal(
    galleryIndexSchema.safeParse({ wikis: [], personas: [{ ...PERSONA, id: '../x' }] }).success,
    false,
  );
  assert.equal(
    galleryIndexSchema.safeParse({ wikis: [], personas: [{ ...PERSONA, prompt: '' }] }).success,
    false,
  );
});


test('reads a catalog without a version gate in publisher order with one cover per project', () => {
  const cover = 'https://assets.stashbase.ai/wikis/x-content-starter/screenshots/cover.png';
  const parsed = galleryIndexSchema.safeParse({

    wikis: [{ ...ENTRY, id: 'x-content-starter', screenshot: cover }, ENTRY],
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.wikis.map((entry) => entry.id), ['x-content-starter', 'cs183b']);
  assert.equal(parsed.data.wikis[0]?.screenshot, cover);
});
