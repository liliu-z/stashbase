/** The user-owned provider authorized to produce embeddings. */

export type EmbedderProvider = 'openai' | 'openrouter' | 'requesty';

/** What saving a provider key reports back. `hasKey` is literal `true`:
 *  the endpoint only answers on success, so a caller never has to check it. */
export interface ApiKeySaveResult {
  hasKey: true;
  provider: EmbedderProvider;
  model: string;
  /** Backfill requested after adding a key or changing provider. Rotating
   * a key for the same provider keeps existing vectors valid. */
  backfillStarted?: boolean;
  /** Present when the key was saved but StashBase could not reach
   *  the provider to validate it at save time. Indexing/search will
   *  surface the real connectivity failure if it persists. */
  warning?: string;
}

/** Current provider configuration. Key presence does not prove provider
 * authentication, connectivity, or index readiness. */
export interface EmbedderState {
  provider: EmbedderProvider;
  hasKey: boolean;
  model: string;
  /** Reported by key saves that schedule a backfill. */
  backfillStarted?: boolean;
}
