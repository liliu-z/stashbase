/** Provider configuration owned by the Settings feature. Key presence controls
 * setup state; it does not prove provider connectivity or authentication.
 * The infrastructure adapter translates the wire without carrying legacy
 * source-selection or authorization aliases into this domain. */

export type EmbedderProvider = 'openai' | 'openrouter' | 'requesty';

/** The providers a reader may choose between, in offer order. */
export const EMBEDDER_PROVIDERS: readonly EmbedderProvider[] = ['openai', 'openrouter', 'requesty'];

export const EMBEDDER_PROVIDER_LABELS: Record<EmbedderProvider, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  requesty: 'Requesty',
};

export interface EmbedderState {
  readonly hasKey: boolean;
  readonly model: string;
  readonly provider: EmbedderProvider;
}

/** A stored key answers with the one thing the reader still needs to see:
 *  whether StashBase could verify it before saving. */
export interface EmbedderKeySave {
  readonly warning: string | null;
}

/** Whether a provider key is configured. Actual provider errors belong to
 * the operation that uses it, not an independent authorization state. */
export function keyIsActive(state: EmbedderState): boolean {
  return state.hasKey;
}

/** What the configured provider means for search, said once under the group. */
export function describeEmbedderSource(state: EmbedderState): string {
  if (keyIsActive(state)) {
    return `Search by meaning is on. Indexing and searches use your ${EMBEDDER_PROVIDER_LABELS[state.provider]} key.`;
  }
  return 'Search by meaning is off. Add a key to turn it on.';
}
