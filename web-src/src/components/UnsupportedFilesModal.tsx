import { Suspense, useEffect, useRef } from 'react';
import { api } from '../api';
import {
  onboardingPatchForNotice,
  retainAvailableUnsupportedNotice,
  unseenUnsupportedNotice,
  unsupportedNoticeForDetails,
  unsupportedSummaryForNotice,
} from '../unsupportedFiles';
import { useApp } from '../store/AppContext';
import { lazyWithRetry } from './ErrorBoundary';
import { useOverlayLayer } from './OverlayStack';
import { ModalLoadingStatus } from './ui/status';

const ManagedUnsupportedFilesModal = lazyWithRetry(() => import('./ManagedUnsupportedFilesModal'));

/** Own the first-time notice state and register its blocking layer before the
 * managed dialog chunk loads. Cancel is session-only; only the primary action
 * persists the categories that were actually explained. */
export function UnsupportedFilesModalGate() {
  const { state, actions, dispatch } = useApp();
  const summary = state.unsupportedFiles;
  const sourceCode = summary?.sourceCode ?? 0;
  const other = summary?.other ?? 0;
  const activeCategories = retainAvailableUnsupportedNotice(state.unsupportedModal, summary);
  const displayedSummary = activeCategories && summary
    ? unsupportedSummaryForNotice(summary, activeCategories)
    : null;
  const open = displayedSummary !== null && !state.welcomeVisible;
  const layer = useOverlayLayer(open);
  const modalRef = useRef(state.unsupportedModal);
  const dismissedForViewRef = useRef(false);
  modalRef.current = state.unsupportedModal;

  useEffect(() => {
    dismissedForViewRef.current = false;
  }, [state.folderPath]);

  useEffect(() => {
    if (
      sourceCode + other === 0
      || state.welcomeVisible
      || dismissedForViewRef.current
    ) return;
    let mounted = true;
    const currentSummary = { sourceCode, other, otherExtensions: [] };
    api.getOnboarding().then((preferences) => {
      if (!mounted || modalRef.current || dismissedForViewRef.current) return;
      const categories = unseenUnsupportedNotice(currentSummary, preferences);
      if (categories) dispatch({ type: 'UNSUPPORTED_MODAL_OPEN', categories });
    }).catch(() => {
      if (!mounted || modalRef.current || dismissedForViewRef.current) return;
      const categories = unsupportedNoticeForDetails(currentSummary);
      if (categories) dispatch({ type: 'UNSUPPORTED_MODAL_OPEN', categories });
      actions.toast(
        'Could not load unsupported-file notice preferences. The notice will remain available.',
        { level: 'warning' },
      );
    });
    return () => { mounted = false; };
  }, [actions, dispatch, other, sourceCode, state.folderPath, state.welcomeVisible]);

  if (!open || !activeCategories || !displayedSummary) return null;
  const confirmedCategories = activeCategories;

  function handleCancel() {
    dismissedForViewRef.current = true;
    dispatch({ type: 'UNSUPPORTED_MODAL_CLOSE' });
  }

  async function handleConfirm() {
    dismissedForViewRef.current = true;
    dispatch({ type: 'UNSUPPORTED_MODAL_CLOSE' });
    try {
      await api.putOnboarding(onboardingPatchForNotice(confirmedCategories));
    } catch (error) {
      console.warn('Failed to update onboarding preferences', error);
      actions.toast(
        'Could not save this explanation preference. It may appear again later.',
        { level: 'warning' },
      );
    }
  }

  return (
    <Suspense
      fallback={(
        <ModalLoadingStatus
          label="Opening unsupported file details…"
          isTopmost={layer.isTopmost}
          onCancel={handleCancel}
          closeOnBackdrop
        />
      )}
    >
      <ManagedUnsupportedFilesModal
        unsupportedFiles={displayedSummary}
        isTopmost={layer.isTopmost}
        onCancel={handleCancel}
        onConfirm={() => { void handleConfirm(); }}
      />
    </Suspense>
  );
}
