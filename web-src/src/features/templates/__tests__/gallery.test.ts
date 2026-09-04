import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  GALLERY_SNAPSHOT,
  loadGalleryWikis,
  parseGalleryIndex,
  resetGalleryCacheForTests,
} from '@/features/templates/gallery';

/** The gallery's data story: the published index wins when it can be
 *  fetched AND understood; everything else — offline, HTTP failure,
 *  malformed payload, future schema — falls back whole to the bundled
 *  snapshot. Half-read indexes must never render. */

const PUBLISHED_INDEX = {
  schemaVersion: 1,
  updated: '2026-09-04',
  wikis: [
    {
      id: 'how-to-start-a-startup',
      name: 'How to Start a Startup',
      category: 'course',
      description: 'The CS183B course, transcripts plus playbook.',
      contents: '20 lecture transcripts · distilled founder playbook',
      repo: 'https://github.com/0-bingwu-0/stashbase-cs183b',
      learnMore: 'https://stashbase.ai/examples/cs183b/',
      starterPrompts: ['How do I find a startup idea?'],
    },
    {
      id: 'second-entry',
      name: 'Second Entry',
      category: 'reference',
      description: 'An entry the bundled snapshot has never heard of.',
      contents: 'one thing',
      repo: 'https://github.com/0-bingwu-0/second-entry',
      starterPrompts: [],
    },
  ],
};

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  resetGalleryCacheForTests();
});

test('a published index parses whole, unknown fields ignored', () => {
  const withExtras = {
    ...PUBLISHED_INDEX,
    futureTopLevel: true,
    wikis: PUBLISHED_INDEX.wikis.map((wiki) => ({ ...wiki, futureField: 1 })),
  };
  const parsed = parseGalleryIndex(withExtras);
  assert.ok(parsed);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1]!.name, 'Second Entry');
  assert.equal(parsed[0]!.learnMore, 'https://stashbase.ai/examples/cs183b/');
});

test('a future schema or a broken entry rejects the whole index', () => {
  assert.equal(parseGalleryIndex({ ...PUBLISHED_INDEX, schemaVersion: 2 }), null);
  assert.equal(parseGalleryIndex({ schemaVersion: 1 }), null);
  const missingRepo = {
    schemaVersion: 1,
    wikis: [{ ...PUBLISHED_INDEX.wikis[0], repo: '' }],
  };
  assert.equal(parseGalleryIndex(missingRepo), null);
});

test('the fetched index replaces the snapshot and is cached for the session', async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls += 1;
    return Promise.resolve(jsonResponse(PUBLISHED_INDEX));
  }) as unknown as typeof fetch;

  const first = await loadGalleryWikis(fetchImpl);
  assert.equal(first.length, 2);
  const second = await loadGalleryWikis(fetchImpl);
  assert.equal(second, first);
  assert.equal(calls, 1);
});

test('offline, HTTP failure, and malformed payloads all fall back to the snapshot', async () => {
  const offline = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
  assert.equal(await loadGalleryWikis(offline), GALLERY_SNAPSHOT);

  resetGalleryCacheForTests();
  const failing = (() => Promise.resolve(jsonResponse({}, false))) as unknown as typeof fetch;
  assert.equal(await loadGalleryWikis(failing), GALLERY_SNAPSHOT);

  resetGalleryCacheForTests();
  const malformed = (() => Promise.resolve(jsonResponse({ schemaVersion: 99 }))) as unknown as typeof fetch;
  assert.equal(await loadGalleryWikis(malformed), GALLERY_SNAPSHOT);
});

test('a fallback answer is not cached — the next load tries the network again', async () => {
  const offline = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
  assert.equal(await loadGalleryWikis(offline), GALLERY_SNAPSHOT);

  const recovered = (() => Promise.resolve(jsonResponse(PUBLISHED_INDEX))) as unknown as typeof fetch;
  const loaded = await loadGalleryWikis(recovered);
  assert.equal(loaded.length, 2);
});

test('snapshot fills optional fields the published entry has not published', async () => {
  const wikis = await loadGalleryWikis(() => Promise.resolve(jsonResponse(PUBLISHED_INDEX)));
  const known = wikis.find((wiki) => wiki.id === 'how-to-start-a-startup');
  // The published entry carries no files/wikiPrompt; the bundled
  // snapshot's same-id entry supplies them.
  assert.ok(known?.files?.includes('transcripts/Lecture01-HowToStart.md'));
  assert.ok(known?.wikiPrompt?.startsWith('Build or update Wiki Pages'));
  // Entries the snapshot has never heard of pass through untouched.
  const unknown = wikis.find((wiki) => wiki.id === 'second-entry');
  assert.equal(unknown?.files, undefined);
  assert.equal(unknown?.wikiPrompt, undefined);
});
