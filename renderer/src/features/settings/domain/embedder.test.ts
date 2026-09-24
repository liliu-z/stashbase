import { describe, expect, it } from 'vite-plus/test';

import { embedderState, keyedEmbedderState } from '@/test/fakes/settings';

import { describeEmbedderSource, keyIsActive } from './embedder';

describe('embedder domain', () => {
  it('uses key presence for every provider without an independent authorization state', () => {
    for (const provider of ['openai', 'openrouter', 'requesty'] as const) {
      expect(keyIsActive(embedderState({ provider }))).toBe(false);
      expect(keyIsActive(keyedEmbedderState({ provider }))).toBe(true);
    }
  });

  it('describes the configured provider without claiming connectivity', () => {
    expect(describeEmbedderSource(embedderState())).toBe(
      'Search by meaning is off. Add a key to turn it on.',
    );
    expect(describeEmbedderSource(keyedEmbedderState({ provider: 'openrouter' }))).toBe(
      'Search by meaning is on. Indexing and searches use your OpenRouter key.',
    );
  });
});
