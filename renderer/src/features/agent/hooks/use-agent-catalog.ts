import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { AgentCatalogPort } from '@/features/agent/application/ports';
import { AGENT_ORDER } from '@/features/agent/domain/agent-catalog';

const AGENT_CATALOG_QUERY_KEY = ['agent', 'catalog'] as const;
const PREPARATION_POLL_MS = 500;

export function useAgentCatalog(
  port: AgentCatalogPort,
  {
    accountSignedIn,
    settingsOpen,
  }: {
    accountSignedIn?: boolean | undefined;
    settingsOpen?: boolean | undefined;
  } = {},
) {
  const query = useQuery({
    queryKey: AGENT_CATALOG_QUERY_KEY,
    queryFn: ({ signal }) => port.listAgents(signal),
    retry: false,
    staleTime: 10_000,
    // Startup checks finish after the first listing can answer. Follow only
    // work the host says is running; settled setup needs a user action, and
    // a failed read uses the composer's Retry instead of polling stale data.
    refetchInterval: ({ state }) =>
      state.status !== 'error' &&
      state.data?.agents.some((agent) => agent.preparation !== undefined)
        ? PREPARATION_POLL_MS
        : false,
  });
  const agents = useMemo(
    () =>
      AGENT_ORDER.map((id) => query.data?.agents.find((agent) => agent.id === id)).filter(
        (agent) => agent !== undefined,
      ),
    [query.data],
  );
  const readyAgents = useMemo(() => agents.filter((agent) => agent.ready), [agents]);

  const { refetch } = query;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (accountSignedIn !== undefined) refresh();
  }, [accountSignedIn, refresh]);
  // Settings signs agents in and out, installs and updates them, and the chat
  // stays mounted beneath it; read readiness again once it closes.
  const settingsWereOpen = useRef(false);
  useEffect(() => {
    if (settingsOpen) settingsWereOpen.current = true;
    else if (settingsWereOpen.current) {
      settingsWereOpen.current = false;
      refresh();
    }
  }, [settingsOpen, refresh]);

  return {
    agents,
    error: query.isError,
    loading: query.isLoading,
    readyAgents,
    refresh,
  };
}
