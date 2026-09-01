import type { ReactNode } from 'react';
import { Button } from '@/common/components/ui/button';
import { SectionHeading } from '@/common/components/ui/section';
import { StatusMessage } from '@/common/components/ui/status';
import { openSettings } from '@/common/lib/settingsTrigger';
import { useAppActions, useWorkspace } from '@/store/contexts/AppContext';
import { openEmbeddingSetup } from '@/common/lib/embeddingSetupTrigger';

/** One readiness/problem banner: title + detail copy on the left, optional
 *  compact actions on the right, on the status token ramp. */
function SearchBanner({ tone, title, detail, actions }: {
  tone: 'warning' | 'info';
  title: ReactNode;
  detail: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <StatusMessage tone={tone} className="mx-3 mb-2 flex items-start justify-between gap-2.5 px-2.5 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SectionHeading className="text-sm">{title}</SectionHeading>
        <div className="leading-snug opacity-90">{detail}</div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </StatusMessage>
  );
}

/** Readiness explanation for the ACTIVE folder — preparation, indexing, and
 *  failure counts come from the folder-scoped status poll. Other folders'
 *  readiness is not reported here (no library-wide status surface yet).
 *  `onNavigateAway` closes the popup before opening Settings — the Settings
 *  dialog stacks BELOW the picker veil. */
export function SearchStatusBanner({ semanticMode, onNavigateAway }: {
  semanticMode: boolean;
  onNavigateAway: () => void;
}) {
  const state = useWorkspace();
  const { actions } = useAppActions();
  const semanticDisabled = state.embedderHasKey === false;
  const conversionPendingCount = state.pendingConversions.length;
  const semanticPendingPaths = new Set<string>();
  for (const path of Object.keys(state.pendingSemanticNames)) semanticPendingPaths.add(path);
  for (const path of state.pendingConversions) semanticPendingPaths.add(path);
  const semanticPendingCount = semanticPendingPaths.size;
  const pendingCount = semanticMode ? semanticPendingCount : conversionPendingCount;
  const failedCount = state.preparationFailures.filter((problem) => problem.status !== 'cancelled').length;
  const cancelledCount = state.preparationFailures.length - failedCount;
  const failureCount = failedCount + cancelledCount;
  const blockedCount = state.blockedConversions.length;
  const total = state.files.length;
  const unavailablePaths = new Set([
    ...state.pendingConversions,
    ...state.preparationFailures.map((failure) => failure.path),
    ...state.blockedConversions,
    ...(semanticMode ? Object.keys(state.pendingSemanticNames) : []),
  ]);
  const readyCount = Math.max(0, total - unavailablePaths.size);

  if (state.semanticIndexing && ['awaiting-decision', 'paused', 'partial-paused'].includes(state.semanticIndexing.state)) return null;

  if (semanticMode && state.indexWarning) {
    return (
      <SearchBanner
        tone="warning"
        title="Search needs attention"
        detail={<>Search may be incomplete: {state.indexWarning.message}</>}
        actions={
          <>
            <Button variant="outline" size="xs" onClick={() => { void actions.runSync(); }}>Retry</Button>
            <Button variant="outline" size="xs" onClick={() => { void actions.dismissIndexWarning(); }}>Dismiss</Button>
          </>
        }
      />
    );
  }

  if (failureCount > 0) {
    return (
      <SearchBanner
        tone="warning"
        title={failedCount > 0 ? 'Some files could not be prepared for search.' : 'Some file preparation was cancelled.'}
        detail={
          <>
            {[
              failedCount > 0 ? `${failedCount} failed` : '',
              cancelledCount > 0 ? `${cancelledCount} cancelled` : '',
            ].filter(Boolean).join(' · ')}. Open a file to retry it.
          </>
        }
      />
    );
  }

  if (blockedCount > 0) {
    return (
      <SearchBanner
        tone="warning"
        title="Transcription setup required"
        detail={
          <>
            {readyCount} file{readyCount === 1 ? ' is' : 's are'} ready to search. {blockedCount} media file{blockedCount === 1 ? '' : 's'} need transcription setup.
          </>
        }
        actions={
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              onNavigateAway();
              openSettings('transcription');
            }}
          >
            Open Settings
          </Button>
        }
      />
    );
  }

  if (semanticMode && semanticDisabled) {
    return (
      <SearchBanner
        tone="info"
        title="Similarity Search setup required"
        detail="Set up Similarity Search to match by meaning. Exact Search stays available without it."
        actions={
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              onNavigateAway();
              openEmbeddingSetup();
            }}
          >
            Set up
          </Button>
        }
      />
    );
  }

  if (pendingCount > 0) {
    const readyLabel = `${readyCount} file${readyCount === 1 ? '' : 's'} ${readyCount === 1 ? 'is' : 'are'} ready to search.`;
    const pendingLabel = semanticMode
      ? `${pendingCount} ${pendingCount === 1 ? 'is' : 'are'} still being prepared.`
      : `${pendingCount} ${pendingCount === 1 ? 'is' : 'are'} still being converted.`;
    return (
      <SearchBanner
        tone="info"
        title={semanticMode ? 'Preparing files for Similarity Search' : 'Preparing text for Exact Search'}
        detail={<>{readyLabel} {pendingLabel}</>}
      />
    );
  }

  return null;
}
