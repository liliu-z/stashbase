import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useCallback } from 'react';

import { settingsFailure } from '@/features/settings/application/failure-messages';
import type { ProjectMathPort } from '@/features/settings/application/ports';
import { settingsQueryKeys } from '@/features/settings/application/queries';
import { useWindowFocus } from '@/shared/runtime/use-window-focus';

type MathSetting = { scope: string; math_mode: boolean };

/** Retained document menus share one write per project. A menu mounted during
 * a save waits before reading, so its GET cannot replace the optimistic value
 * with the previous setting. Accepted writes outlive their presenting menu. */
class ProjectMathWrites {
  private pending = new Map<string, Promise<void>>();

  constructor(private readonly client: QueryClient) {}

  async load(port: ProjectMathPort, scope: string, signal: AbortSignal): Promise<MathSetting> {
    await this.pending.get(scope)?.catch(() => {});
    signal.throwIfAborted();
    return port.load(scope, signal);
  }

  save(port: ProjectMathPort, scope: string, mathMode: boolean): Promise<void> {
    const pending = this.pending.get(scope);
    if (pending) return pending;
    const key = settingsQueryKeys.projectMath(scope);
    const previous = this.client.getQueryData<MathSetting>(key);
    if (!previous) return Promise.resolve();
    const cancelled = this.client.cancelQueries({ queryKey: key });
    this.client.setQueryData<MathSetting>(key, { ...previous, math_mode: mathMode });
    const saved = cancelled.then(async () => {
      try {
        const value = await port.update(scope, mathMode, AbortSignal.timeout(30_000));
        this.client.setQueryData(key, value);
      } catch (error) {
        this.client.setQueryData(key, previous);
        throw error;
      } finally {
        this.pending.delete(scope);
      }
    });
    // Duplicate writers must observe the same outcome. Reads catch a refused
    // save above and resume with the confirmed value after rollback.
    this.pending.set(scope, saved);
    return saved;
  }
}

const owners = new WeakMap<QueryClient, ProjectMathWrites>();
function writesFor(client: QueryClient): ProjectMathWrites {
  let owner = owners.get(client);
  if (!owner) {
    owner = new ProjectMathWrites(client);
    owners.set(client, owner);
  }
  return owner;
}

export function useProjectMath(port: ProjectMathPort, scope: string | null) {
  const owner = writesFor(useQueryClient());
  const key = settingsQueryKeys.projectMath(scope);
  const query = useQuery({
    enabled: scope !== null,
    queryFn: ({ signal }) => {
      if (scope === null) throw new Error('No project is open.');
      return owner.load(port, scope, signal);
    },
    queryKey: key,
    retry: false,
  });
  const { refetch } = query;
  const refresh = useCallback(() => void refetch({ cancelRefetch: false }), [refetch]);
  // Another desktop window may have changed this project's persisted mode.
  // Retained menus share the same request when the window becomes active.
  useWindowFocus(refresh, scope !== null);
  const mutation = useMutation({
    mutationKey: key,
    mutationFn: (saved: Promise<void>) => saved,
  });
  const mutations = useMutationState({
    filters: { mutationKey: key, exact: true },
    select: ({ state }) => ({ status: state.status, error: state.error }),
  });
  const saving = mutations.some(({ status }) => status === 'pending');
  const latest = mutations.at(-1);
  return {
    enabled: query.data?.math_mode ?? false,
    loading: scope !== null && query.isPending,
    saving,
    failure: query.isError
      ? settingsFailure(query.error)
      : latest?.status === 'error'
        ? settingsFailure(latest.error)
        : null,
    unavailable: query.data === undefined,
    retry: refresh,
    setEnabled: (next: boolean) => {
      if (scope && !saving) mutation.mutate(owner.save(port, scope, next));
    },
  };
}
