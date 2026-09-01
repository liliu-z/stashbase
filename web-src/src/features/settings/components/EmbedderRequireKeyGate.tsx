/**
 * Owns the Similarity Search setup dialog. Mounted once at the app root, always —
 * not only when a folder is open — so it can resolve the app-wide
 * `embedderHasKey` fact even in a bare window, which is what lets the standing
 * Files-panel callout (and its "Set up" action) work before any folder opens.
 *
 * The dialog opens once when the first folder becomes active and no embedding
 * source is authorized. A bare Library never prompts. Explicit capability actions
 * and the standing Files-panel entry can reopen it later; a durable Not now
 * choice prevents automatic re-prompts without hiding those manual routes.
 *
 * Daily use is not tied to online auth (the check is a localhost call).
 * Activation persists as the selected source (and a credential when that
 * source requires one). Completing or declining this invitation records it
 * as seen across folders and relaunches. Deliberately removing a source later
 * exposes the standing setup actions without replaying onboarding.
 *
 * The gate owns the dialog rather than the card, because the post-save work
 * is app-level: reducer state, the validation-warning toast, marking visible
 * files pending, and refreshing index state.
 *
 * Exits:
 *   • Select a source or save a key — activates; dialog closes.
 *   • Not now — records that onboarding was handled; dialog closes. The
 *     Files-panel Set up entry (and Settings) can reopen it later.
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useAppActions, useWorkspace } from '@/store/contexts/AppContext';
import { useEmbedderState } from '@/common/hooks/useEmbedderState';
import { hasSeenSimilaritySearchSetup, isEmbeddingAuthorized, setSimilaritySearchSetupSeen } from '@/common/lib/embeddingAuth';
import { type EmbedderState } from '@/common/api/apiTypes';
import { lazyWithRetry } from '@/common/components/ErrorBoundary';
import { useOverlayLayer } from '@/common/components/OverlayStack';
import { ModalLoadingStatus } from '@/common/components/ui/status';
import { OPEN_EMBEDDING_SETUP_EVENT } from '@/common/lib/embeddingSetupTrigger';

const RequireApiKeyModal = lazyWithRetry(() =>
  import('@/features/settings/components/embedder/RequireApiKeyModal').then((mod) => ({ default: mod.RequireApiKeyModal })),
);

export function EmbedderRequireKeyGate() {
  const appState = useWorkspace();
  const { dispatch, actions } = useAppActions();
  const folder = appState.folder;
  const [open, setOpen] = useState(false);
  const layer = useOverlayLayer(open);
  // Fetch regardless of folder so `embedderHasKey` is an app-wide fact: the
  // Files-panel callout must be able to show (and its "Set up" must work)
  // even in a bare window with nothing open yet. embedderHasKey is part of
  // the key: removing a key must update the standing setup surfaces right
  // away, even though the one-time onboarding dialog does not replay.
  const onLoaded = useCallback((embedder: EmbedderState) => {
    dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: embedder.authorized });
    // An already-authorized installation has necessarily handled setup,
    // including installations upgraded from before this preference existed.
    if (isEmbeddingAuthorized(embedder)) setSimilaritySearchSetupSeen(true);
    if (folder && !isEmbeddingAuthorized(embedder) && !hasSeenSimilaritySearchSetup()) {
      setOpen(true);
    }
  }, [dispatch, folder]);
  const { embedder: state, patchEmbedder } = useEmbedderState({
    refreshKey: `${folder ?? ''}|${appState.embedderHasKey}`,
    onLoaded,
  });

  const finishSetup = useCallback((backfillStarted?: boolean) => {
    dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: true });
    setSimilaritySearchSetupSeen(true);
    setOpen(false);
    if (backfillStarted) void actions.markVisibleFilesPendingForSearch();
    void actions.refreshIndexState();
  }, [actions, dispatch]);

  useEffect(() => {
    function onOpen() { setOpen(true); }
    window.addEventListener(OPEN_EMBEDDING_SETUP_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EMBEDDING_SETUP_EVENT, onOpen);
  }, []);

  if (!open) return null;

  return (
    <Suspense fallback={<ModalLoadingStatus label="Getting things ready…" isTopmost={layer.isTopmost} onCancel={() => { /* no casual dismiss while the dialog chunk loads */ }} />}>
      <RequireApiKeyModal
        initialProvider={state?.provider}
        isTopmost={layer.isTopmost}
        onSaved={(provider, model, backfillStarted, warning) => {
          patchEmbedder((s) => ({ ...s, provider, model, hasKey: true, authorized: true, source: provider }));
          if (warning) actions.toast(`API key saved, but validation could not reach the provider: ${warning}`, { level: 'warning' });
          finishSetup(backfillStarted);
        }}
        onSignedIn={(backfillStarted) => {
          patchEmbedder((s) => ({
            ...s,
            authorized: true,
            source: 'stashbase-account',
            account: { ...s.account, signedIn: true, active: true },
          }));
          finishSetup(backfillStarted);
        }}
        onSkip={() => {
          // One deliberate dismissal quiets automatic onboarding across
          // folders and relaunches; manual setup routes remain available.
          setSimilaritySearchSetupSeen(true);
          setOpen(false);
        }}
      />
    </Suspense>
  );
}
