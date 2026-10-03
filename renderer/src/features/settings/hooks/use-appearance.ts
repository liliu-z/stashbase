import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import { settingsFailure } from '@/features/settings/application/failure-messages';
import type { AppearancePort } from '@/features/settings/application/ports';
import { appearanceQuery, settingsQueryKeys } from '@/features/settings/application/queries';
import type {
  AppearanceChange,
  AppearancePreferences,
} from '@/features/settings/domain/appearance';
import { useSettingsCommand } from '@/features/settings/hooks/use-settings-command';
import type { FailureView } from '@/shared/domain/feature-error';
import { publishAppearanceSurface } from '@/shared/runtime/appearance-surface';

/** What the Appearance panel renders and can do. The panel never sees a query
 *  or a mutation object, only this. */
export interface AppearanceViewModel {
  readonly preferences: AppearancePreferences | null;
  readonly loading: boolean;
  readonly failure: FailureView | null;
  change(change: AppearanceChange): void;
}

interface AppearanceWrite {
  readonly change: AppearanceChange;
  readonly optimistic: AppearancePreferences;
  readonly revision: number;
}

export function useAppearance(port: AppearancePort): AppearanceViewModel {
  const queryClient = useQueryClient();
  const preferences = useQuery(appearanceQuery(port));
  const revision = useRef(0);
  /** The newest record the server stood behind, and so the only honest thing a
   *  rollback can go back to. Never an optimistic value. */
  const confirmed = useRef<AppearancePreferences | null>(null);

  const settle = (next: AppearancePreferences) => {
    queryClient.setQueryData(settingsQueryKeys.appearance, next);
    publishAppearanceSurface(next);
  };

  const update = useSettingsCommand(
    'update',
    (write: AppearanceWrite, signal) => port.update(write.change, signal),
    {
      onStart: async (write) => {
        // A read already in flight must not land on top of the optimistic
        // value, and cancelling it reverts the cache, so it goes first.
        await queryClient.cancelQueries({ queryKey: settingsQueryKeys.appearance });
        confirmed.current ??=
          queryClient.getQueryData<AppearancePreferences>(settingsQueryKeys.appearance) ?? null;
        queryClient.setQueryData(settingsQueryKeys.appearance, write.optimistic);
      },
      onFailed: (write) => {
        // Only the newest write may undo itself. An older save that fails
        // after a newer one started would otherwise revert the newer choice.
        if (revision.current !== write.revision) return;
        const previous = confirmed.current;
        if (previous) settle(previous);
      },
      onDone: (saved) => {
        confirmed.current = saved;
        settle(saved);
      },
    },
  );

  return {
    preferences: preferences.data ?? null,
    loading: preferences.isPending,
    failure: preferences.isError ? settingsFailure(preferences.error) : update.failure,
    change: (change) => {
      const current = queryClient.getQueryData<AppearancePreferences>(settingsQueryKeys.appearance);
      if (!current) return;
      const optimistic = { ...current, ...change };
      revision.current += 1;
      publishAppearanceSurface(optimistic);
      update.run({ change, optimistic, revision: revision.current });
    },
  };
}
