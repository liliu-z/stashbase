/** The folder's conversation history as the Chats panel and the Chat pane's
 *  header read and change it: one listing per Agent under one query root,
 *  and the rename and removal mutations that rewrite that cache in place.
 *  A rename can start from a sidebar row or from the open Chat's own header,
 *  so the mutation is shared and only the caller's failure surface differs. */
import {
  useMutation,
  useQueries,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useState } from 'react';

import {
  agentFailure,
  failureKind,
  type AgentFailureKind,
} from '@/features/agent/application/failure-messages';
import type { AgentSessionRuntime } from '@/features/agent/application/session-runtime';
import type { AgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import { agentLabel, AGENT_ORDER } from '@/features/agent/domain/agent-catalog';
import type { AgentHistoryEntry } from '@/features/agent/domain/conversation-history';
import type { AgentId, AgentScope, AgentSessionState } from '@/features/agent/domain/session';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';

const HISTORY_QUERY_ROOT = ['agent', 'history'] as const;

/** What a rename or a removal did. A bare `false` could not tell a caller
 *  whether the service refused the change or nothing was ever asked of it,
 *  so a refusal carries the kind behind it and the caller decides how to
 *  say so. */
export type AgentHistoryMutation = { kind: 'done' } | { kind: 'refused'; reason: AgentFailureKind };

function scopeKey(scope: AgentScope): string {
  return `folder:${scope.path}`;
}

function historyQueryKey(agent: AgentId, scope: AgentScope) {
  return [...HISTORY_QUERY_ROOT, agent, scopeKey(scope)] as const;
}

/** The history row a mounted session stands for once the runtime has
 *  identified it, or null before then, when there is nothing on record. */
function historyEntryOf(state: AgentSessionState): AgentHistoryEntry | null {
  if (state.nativeSessionId === null) return null;
  return {
    agent: state.agent,
    hasContent: state.transcript.length > 0,
    id: state.nativeSessionId,
    lastModified: state.lastModified,
    scope: state.scope,
    title: state.title,
  };
}

/** The one rename-on-record mutation both surfaces run: the Chats panel's
 *  rows and the Chat pane's own header. A success rewrites the cached
 *  listing in place, so the row reads the new name without a refetch. */
function useRenameHistoryMutation(
  runtime: AgentWorkspaceRuntime,
  signal: () => AbortSignal,
  onFailure: (message: string | null) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: 'agent-history-rename' },
    mutationFn: ({ entry, title }: { entry: AgentHistoryEntry; title: string }) =>
      runtime.renameHistory(entry, title, signal()),
    onMutate: () => onFailure(null),
    onError: (error) => onFailure(agentFailure(error).message),
    onSuccess: (updated) => {
      queryClient.setQueryData<AgentHistoryEntry[]>(
        historyQueryKey(updated.agent, updated.scope),
        (entries = []) => entries.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
    },
  });
}

/** Renames the Chat behind a mounted session from wherever it is shown. The
 *  native title changes only after persistence succeeds. Draft titles stay local. */
export function useRenameConversation(runtime: AgentWorkspaceRuntime) {
  const signalFor = useRequestSignals<'rename'>();
  const [failure, setFailure] = useState<string | null>(null);
  const mutation = useRenameHistoryMutation(runtime, () => signalFor('rename'), setFailure);
  return {
    failure,
    rename: async (session: AgentSessionRuntime, title: string): Promise<AgentHistoryMutation> => {
      const state = session.store.getState();
      const entry = historyEntryOf(state);
      if (entry === null) {
        session.rename(title);
        return { kind: 'done' };
      }
      try {
        await mutation.mutateAsync({ entry, title });
        return { kind: 'done' };
      } catch (error) {
        return { kind: 'refused', reason: failureKind(error) };
      }
    },
  };
}

function needsInstallation(query: UseQueryResult<AgentHistoryEntry[]>) {
  return query.isError && failureKind(query.error) === 'installation-required';
}

/** useQueries returns a new result array on each render. Combining at the
 * query boundary preserves unchanged history rows, so streaming a reply does
 * not continuously reset the history popover's keyboard selection. */
function combineHistory(queries: UseQueryResult<AgentHistoryEntry[]>[]) {
  const history = queries.flatMap((query) => query.data ?? []);
  return {
    history,
    installationRequired: AGENT_ORDER.filter((_, index) => {
      const query = queries[index];
      return query && needsInstallation(query);
    }),
    failedAgents: AGENT_ORDER.filter((_, index) => {
      const query = queries[index];
      return query?.isError && !needsInstallation(query);
    }),
    loading: queries.some((query) => query.isLoading) && history.length === 0,
    refetch: queries
      .filter((query) => query.isError && !needsInstallation(query))
      .map((query) => query.refetch),
    checkInstallation: queries.filter(needsInstallation).map((query) => query.refetch),
  };
}

export function useConversationHistory(
  runtime: AgentWorkspaceRuntime,
  scope: AgentScope,
  enabled = true,
) {
  const queryClient = useQueryClient();
  const signalFor = useRequestSignals<'remove' | 'rename'>();
  const [mutationFailure, setMutationFailure] = useState<string | null>(null);
  // The Chats panel is the one sidebar pane that unmounts when another is
  // chosen, so these queries lose their last observer every time the reader
  // switches to Documents. `gcTime: Infinity` is what makes coming back free:
  // without it the default five-minute collection drops the rows, and the
  // panel that reopens has nothing to paint and says "Loading chats…" while a
  // native listing is read off disk again. Kept for the window's life rather
  // than a longer finite span, because what bounds this cache is the number of
  // folder scopes a window ever opens, not time.
  //
  // `staleTime` stays short on purpose: it is standing in for an invalidation
  // this hook does not have, so a chat written by a `claude` run outside the
  // app still turns up. With rows retained that refetch now happens BEHIND the
  // list the reader is already looking at instead of in front of it.
  const result = useQueries({
    combine: combineHistory,
    queries: AGENT_ORDER.map((agent) => ({
      queryKey: historyQueryKey(agent, scope),
      queryFn: ({ signal }: { signal: AbortSignal }) => runtime.listHistory(agent, scope, signal),
      enabled,
      gcTime: Infinity,
      retry: false,
      staleTime: 5_000,
    })),
  });

  const { history, failedAgents } = result;
  const historyFailure =
    failedAgents.length > 0
      ? `Chats unavailable for ${failedAgents.map(agentLabel).join(', ')}.`
      : null;

  const rename = useRenameHistoryMutation(runtime, () => signalFor('rename'), setMutationFailure);
  const remove = useMutation({
    mutationFn: async (entry: AgentHistoryEntry) => {
      await runtime.removeHistory(entry, signalFor('remove'));
      return entry;
    },
    onMutate: () => setMutationFailure(null),
    onError: (error) => setMutationFailure(agentFailure(error).message),
    onSuccess: (removed) => {
      queryClient.setQueryData<AgentHistoryEntry[]>(
        historyQueryKey(removed.agent, removed.scope),
        (entries = []) => entries.filter((entry) => entry.id !== removed.id),
      );
    },
  });

  return {
    clearMutationFailure: () => setMutationFailure(null),
    history,
    historyFailure,
    installationRequired: result.installationRequired,
    historyLoading: result.loading,
    mutationFailure,
    mutationPending: rename.isPending || remove.isPending,
    remove: async (entry: AgentHistoryEntry): Promise<AgentHistoryMutation> => {
      try {
        await remove.mutateAsync(entry);
        return { kind: 'done' };
      } catch (error) {
        return { kind: 'refused', reason: failureKind(error) };
      }
    },
    rename: async (entry: AgentHistoryEntry, title: string): Promise<AgentHistoryMutation> => {
      try {
        await rename.mutateAsync({ entry, title });
        return { kind: 'done' };
      } catch (error) {
        return { kind: 'refused', reason: failureKind(error) };
      }
    },
    retry: () => Promise.all(result.refetch.map((refetch) => refetch())),
    checkInstallation: () => Promise.all(result.checkInstallation.map((refetch) => refetch())),
  };
}
