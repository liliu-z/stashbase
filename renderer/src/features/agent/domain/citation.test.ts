import { describe, expect, it } from 'vite-plus/test';

import { parseCitationHref } from './citation';

describe('parseCitationHref', () => {
  it.each([
    ['notes/draft%20one.md', { path: 'notes/draft one.md', phrase: null }],
    ['notes/draft.md?view=raw#intro', { path: 'notes/draft.md', phrase: null }],
    ['draft.md#:~:text=rising%20tides', { path: 'draft.md', phrase: 'rising tides' }],
    ['draft.md#:~:text=the%20-,rising%20tides', { path: 'draft.md', phrase: 'rising tides' }],
    ['draft.md#:~:text=rising,tides', { path: 'draft.md', phrase: 'rising' }],
    ['draft.md#:~:text=rising,-tides', { path: 'draft.md', phrase: 'rising' }],
    ['draft.md#:~:text=a-,rising,falls,-b', { path: 'draft.md', phrase: 'rising' }],
    ['draft.md#:~:text=one%2C%20two', { path: 'draft.md', phrase: 'one, two' }],
    ['draft.md#intro:~:text=rising', { path: 'draft.md', phrase: 'rising' }],
    ['draft.md#:~:text=first&text=second', { path: 'draft.md', phrase: 'first' }],
    ['draft.md#:~:text=%E0%A4%A', { path: 'draft.md', phrase: null }],
    ['draft.md#:~:text=prefix-', { path: 'draft.md', phrase: null }],
    ['draft.md#text=rising', { path: 'draft.md', phrase: null }],
    [
      'draft.md#:~:text=%2A%2Abold%2A%2A%20and%20%60code%60%20and%20%5Ba%20link%5D(x.md)',
      { path: 'draft.md', phrase: 'bold and code and a link' },
    ],
    [
      'draft.md#:~:text=spread%0A%20%20across%09lines',
      { path: 'draft.md', phrase: 'spread across lines' },
    ],
  ])('%s', (href, expected) => {
    expect(parseCitationHref(href)).toEqual(expected);
  });

  it('caps a long phrase', () => {
    const parsed = parseCitationHref(`draft.md#:~:text=${'word%20'.repeat(100)}`);
    expect(parsed?.phrase?.length).toBeLessThanOrEqual(300);
  });

  it('refuses a malformed path', () => {
    expect(parseCitationHref('draft%E0%A4%A.md#:~:text=rising')).toBeNull();
  });
});
