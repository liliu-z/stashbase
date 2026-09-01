/**
 * Whether Similarity Search is authorized, whether the one-time setup invitation has
 * already been handled, and the one place that decides both.
 *
 * A signed-in account allowance and a provider API key are equal activation
 * sources. The server resolves the explicit active source and exposes the
 * resulting `authorized` fact so the dialog, Files-panel line, Settings, and
 * search never disagree.
 */
import type { EmbedderState } from '@/common/api/api';

export function isEmbeddingAuthorized(state: EmbedderState | null | undefined): boolean {
  if (!state) return false;
  return state.authorized;
}

/** The first-folder setup is a one-time invitation, not a per-folder nag.
 * Completing or declining it records a durable renderer preference; the
 * standing Files-panel action and Settings remain available if Similarity Search isn't set up. */
// Keep the legacy storage key so existing dismissals survive the terminology
// migration; the identifier names the current product concept.
const SIMILARITY_SEARCH_SETUP_SEEN_KEY = 'stashbase.ai-setup-seen';

export interface SimilaritySearchSetupPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): SimilaritySearchSetupPreferenceStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function hasSeenSimilaritySearchSetup(
  storage: SimilaritySearchSetupPreferenceStorage | undefined = browserStorage(),
): boolean {
  try {
    return storage?.getItem(SIMILARITY_SEARCH_SETUP_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSimilaritySearchSetupSeen(
  seen: boolean,
  storage: SimilaritySearchSetupPreferenceStorage | undefined = browserStorage(),
): void {
  try {
    if (seen) storage?.setItem(SIMILARITY_SEARCH_SETUP_SEEN_KEY, '1');
    else storage?.removeItem(SIMILARITY_SEARCH_SETUP_SEEN_KEY);
  } catch {
    // Hardened WebViews may reject localStorage. The setup can reappear on a
    // later launch, but browsing and Exact Search still remain available.
  }
}
