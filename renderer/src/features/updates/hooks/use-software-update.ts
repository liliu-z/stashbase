/**
 * The Software updates row in Settings.
 *
 * Settings answers when it is asked, so unlike the notice strip it reads every
 * phase, including the quiet ones that are not worth interrupting anyone for.
 * It volunteers nothing and it dismisses nothing.
 */
import { useCallback } from 'react';

import type { UpdatesPort } from '@/features/updates/application/ports';
import { updateOffer } from '@/features/updates/domain/update-offer';
import { updateInProgress } from '@/features/updates/domain/update-status';
import { useUpdates } from '@/features/updates/hooks/use-updates';
import type { SoftwareUpdateRow } from '@/shared/domain/software-update';

export function useSoftwareUpdate(port: UpdatesPort | null): SoftwareUpdateRow {
  const { failure, run, running, state } = useUpdates(port);

  const offer = updateOffer(state.status);
  const action = offer.action;
  const act = useCallback(() => {
    if (action?.kind === 'primary') run((updater) => updater.runPrimaryAction());
    else run((updater) => updater.check());
  }, [action, run]);

  const checkAgain = useCallback(() => run((updater) => updater.check()), [run]);

  const setAutoCheck = useCallback(
    (enabled: boolean) => {
      run((updater) => updater.setAutoCheck(enabled));
    },
    [run],
  );

  return {
    autoCheckEnabled: state.autoCheckEnabled,
    busy: running || updateInProgress(state.status),
    act,
    checkAgain: state.status.phase === 'ready' ? checkAgain : null,
    actionLabel: action?.label ?? 'Check for updates',
    failure,
    setAutoCheck: state.status.phase === 'store' ? null : setAutoCheck,
    status: offer.sentence,
    version: state.currentVersion,
  };
}
