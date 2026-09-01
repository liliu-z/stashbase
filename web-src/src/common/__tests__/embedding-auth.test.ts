import assert from 'node:assert/strict';
import test from 'node:test';
import type { EmbedderState } from '@/common/api/api';
import {
  hasSeenSimilaritySearchSetup,
  isEmbeddingAuthorized,
  setSimilaritySearchSetupSeen,
  type SimilaritySearchSetupPreferenceStorage,
} from '@/common/lib/embeddingAuth';

class MemoryStorage implements SimilaritySearchSetupPreferenceStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function state(patch: Partial<EmbedderState>): EmbedderState {
  return {
    provider: 'openai',
    hasKey: false,
    authorized: false,
    source: 'openai',
    model: 'text-embedding-3-small',
    account: { signedIn: false, active: false },
    ...patch,
  };
}

test('handling the first-folder Similarity Search setup persists globally', () => {
  const storage = new MemoryStorage();
  assert.equal(hasSeenSimilaritySearchSetup(storage), false);
  setSimilaritySearchSetupSeen(true, storage);
  assert.equal(hasSeenSimilaritySearchSetup(storage), true);

  // A new helper call over the same durable storage models a relaunch: the
  // choice is installation-wide rather than tied to one folder or window.
  assert.equal(hasSeenSimilaritySearchSetup(storage), true);
  setSimilaritySearchSetupSeen(false, storage);
  assert.equal(hasSeenSimilaritySearchSetup(storage), false);
});

test('Similarity Search authorization accepts hosted or BYOK sources', () => {
  assert.equal(isEmbeddingAuthorized(null), false);
  assert.equal(isEmbeddingAuthorized(state({ authorized: true, source: 'stashbase-account' })), true);
  assert.equal(isEmbeddingAuthorized(state({ authorized: true, source: 'openrouter', hasKey: true })), true);
  assert.equal(isEmbeddingAuthorized(state({ authorized: false, source: 'stashbase-account' })), false);
});
