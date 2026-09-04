import { useCallback, useEffect, useState } from 'react';
import { api } from '@/common/api/api';
import { AGENTS, type AgentKind } from '@/common/lib/agentCatalog';
import type { HistoryScope } from '@/common/lib/libraryScope';
import {
  historyRequestParams,
  mergeAgentSessions,
  rowScopeParams,
  type MergedSessionRow,
} from '@/features/agent-panel/lib/sessionHistory';

const rowKey = (row: MergedSessionRow) => `${row.agent}:${row.id}`;

export interface SessionHistory {
  rows: MergedSessionRow[];
  /** Agents whose listing failed; each surfaces as a quiet inline note. */
  failedAgents: AgentKind[];
  /** Agents whose listing has not answered yet. The menu renders settled
   *  rows immediately and names the stragglers, so one slow runtime
   *  never blanks the whole list behind a spinner. */
  pendingAgents: AgentKind[];
  rename: (row: MergedSessionRow, title: string) => Promise<void>;
  /** False when the delete failed and the row is still listed. */
  remove: (row: MergedSessionRow) => Promise<boolean>;
}

/**
 * Every Agent's sessions for one history scope, newest first, with the
 * rename and delete commands for a row.
 *
 * Each Agent stores its own history, so listings are independent
 * requests merged into one ordering. They are fetched together but land
 * INDEPENDENTLY: each answer re-merges into the list as it arrives.
 * Codex's listing spawns a short-lived app-server and can take seconds
 * against a large store, and a failure is per agent — neither may hold
 * the already-answered Agents' rows hostage.
 *
 * Rename and delete route through the row's own agent and scope, not the
 * menu's — the library-wide listing mixes rows from every folder, and each
 * one is only addressable where it lives.
 */
export function useSessionHistory(scope: HistoryScope): SessionHistory {
  const [rows, setRows] = useState<MergedSessionRow[]>([]);
  const [failedAgents, setFailedAgents] = useState<AgentKind[]>([]);
  const [pendingAgents, setPendingAgents] = useState<AgentKind[]>(AGENTS.map((agent) => agent.id));

  useEffect(() => {
    let cancelled = false;
    // Answers accumulate here; every arrival re-merges the settled set so
    // ordering stays one newest-first list however the requests land.
    const settled: { agent: AgentKind; sessions: Awaited<ReturnType<typeof api.listSessions>> | null }[] = [];
    setRows([]);
    setFailedAgents([]);
    setPendingAgents(AGENTS.map((agent) => agent.id));
    for (const agent of AGENTS) {
      void api.listSessions(agent.id, historyRequestParams(scope))
        .catch(() => null)
        .then((sessions) => {
          if (cancelled) return;
          settled.push({ agent: agent.id, sessions });
          const merged = mergeAgentSessions(settled);
          setRows(merged.rows);
          setFailedAgents(merged.failed);
          setPendingAgents((pending) => pending.filter((id) => id !== agent.id));
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the scope identity changes
  }, [scope.kind, scope.kind === 'folder' ? scope.path : '']);

  const rename = useCallback(async (row: MergedSessionRow, title: string) => {
    try {
      const updated = await api.renameSession(row.id, title, row.agent, rowScopeParams(scope, row));
      setRows((rs) => rs.map((r) => (rowKey(r) === rowKey(row) ? { ...r, ...updated } : r)));
    } catch { /* leave list as-is */ }
  }, [scope]);

  const remove = useCallback(async (row: MergedSessionRow): Promise<boolean> => {
    try { await api.deleteSession(row.id, row.agent, rowScopeParams(scope, row)); }
    catch { return false; }
    setRows((rs) => rs.filter((r) => rowKey(r) !== rowKey(row)));
    return true;
  }, [scope]);

  return { rows, failedAgents, pendingAgents, rename, remove };
}
