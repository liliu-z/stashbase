import { useMemo } from 'react';

import type { FailureView } from '@/shared/domain/feature-error';
import type { DismissibleNotice, WorkspaceNotice } from '@/shared/domain/workspace-notice';

/** The shell's notices, sorted by where the Visual Style puts each. */
export interface WorkspaceNoticePlacement {
  /** Outcomes of a request the reader just made, floated over the workspace. */
  readonly floating: readonly DismissibleNotice[];
  /** Work the reader was not watching, at the sidebar's foot. */
  readonly corner: readonly DismissibleNotice[];
  /** Standing conditions of the whole window, in the strip under the title
   *  row. The sign-in banner joins these in `WorkspaceNoticeStrip`. */
  readonly strip: readonly WorkspaceNotice[];
}

/**
 * The notices the window raises for things outside any one panel, and where
 * each one goes.
 *
 * Three owners can raise one. Preparation the shell ran on the reader's
 * behalf, on opening a document or syncing a folder, reports from the corner:
 * the reader was not watching it. A reprocess the reader asked for floats, as
 * does a tab menu's copy or reveal that failed. A turn review the reader asked for that did
 * not open floats over the workspace, since nothing opened to carry it. The
 * host disagreeing about which folder this window is on is a standing
 * condition that only resolves when the host answers again, so it holds the
 * strip and cannot be dismissed. Nothing here offers setup; the strip's only
 * invitation is the settings feature's sign-in banner.
 */
export function useWorkspaceNotices({
  dismissPreparationFailure,
  dismissRevisionFailure,
  dismissTabMenuFailure = () => undefined,
  hostFailure,
  preparationFailure,
  preparationRequested = false,
  revisionFailures,
  tabMenuFailure = null,
}: {
  dismissPreparationFailure: () => void;
  /** Drops one review notice by its sentence, which is what the cards key
   *  on. */
  dismissRevisionFailure: (message: string) => void;
  dismissTabMenuFailure?: (() => void) | undefined;
  hostFailure: string | null;
  preparationFailure: FailureView | null;
  /** The failure answers a reprocess the reader asked for. */
  preparationRequested?: boolean;
  /** Reviews that were asked for and could not be shown. */
  revisionFailures: readonly string[];
  /** A copy or reveal the reader chose from a tab menu that failed. */
  tabMenuFailure?: FailureView | null | undefined;
}): WorkspaceNoticePlacement {
  return useMemo(() => {
    // A floating card names its dismissal in words; the corner's cross needs
    // an accessible name that says what it dismisses.
    const preparation = (dismissLabel: string): DismissibleNotice[] =>
      preparationFailure
        ? [
            {
              action: null,
              dismissLabel,
              message: preparationFailure.message,
              onDismiss: dismissPreparationFailure,
              tone: preparationFailure.tone,
            },
          ]
        : [];
    return {
      // Preparation run on the reader's behalf reports from the corner; a
      // reprocess they asked for answers where they acted, floating.
      corner: preparationRequested ? [] : preparation('Dismiss preparation notice'),
      // A review that did not open is StashBase failing to show what was
      // offered, not the reader's own request refused.
      floating: [
        ...(preparationRequested ? preparation('Dismiss') : []),
        ...revisionFailures.map((message) => ({
          action: null,
          dismissLabel: 'Dismiss',
          message,
          onDismiss: () => dismissRevisionFailure(message),
          tone: 'capability' as const,
        })),
        ...(tabMenuFailure
          ? [
              {
                action: null,
                dismissLabel: 'Dismiss',
                message: tabMenuFailure.message,
                onDismiss: dismissTabMenuFailure,
                tone: tabMenuFailure.tone,
              },
            ]
          : []),
      ],
      // Not the reader's request coming back, so said as a capability that
      // could not answer.
      strip: hostFailure
        ? [
            {
              action: null,
              dismissLabel: 'Dismiss',
              message: hostFailure,
              onDismiss: null,
              tone: 'capability' as const,
            },
          ]
        : [],
    };
  }, [
    dismissPreparationFailure,
    dismissRevisionFailure,
    dismissTabMenuFailure,
    hostFailure,
    preparationFailure,
    preparationRequested,
    revisionFailures,
    tabMenuFailure,
  ]);
}
