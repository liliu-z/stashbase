/** Live-session attribution for project operations. The private session id
 * travels through the native process and MCP host; it selects the calling
 * conversation's project without granting additional file access. */

import type { AgentSessionTermination } from './agent-contract.ts';
import { filesystemPath } from './filesystem-path.ts';

export const AGENT_SESSION_ID_HEADER = 'x-stashbase-agent-session-id';

export type AttributedAgentId = 'stashbase' | 'claude' | 'codex' | 'antigravity';

/** The narrow live-session surface attributed host operations need. */
export interface AttributedAgentSession {
  readonly agentId: AttributedAgentId;
  /** The window that owns this panel session. */
  readonly windowId: string;
  /** Member folder the session is bound to; null before startup or after retirement. */
  boundFolder(): string | null;
  /** True while the session is running a turn (a tool call from the agent
   * necessarily happens inside its own active turn). */
  turnInFlight(): boolean;
  /** Captured from this session's live socket, never a global active turn. */
  diagnosticContext?(): { turn_id?: string; runtime_version?: string };
}

const sessions = new Map<string, AttributedAgentSession>();

export function registerAttributedAgentSession(id: string, session: AttributedAgentSession): void {
  if (id) sessions.set(id, session);
}

export function unregisterAttributedAgentSession(id: string): void {
  sessions.delete(id);
}

export function attributedAgentSession(id: string | null | undefined): AttributedAgentSession | null {
  if (typeof id !== 'string' || !id.trim()) return null;
  return sessions.get(id.trim()) ?? null;
}

/** Window-scoped attribution fallback for MCP hosts that predate the
 * session-id header (an installed `stashbase-mcp` binary keeps forwarding
 * only the window id). A tool call happens inside the calling session's
 * active turn, so "the one session of this window currently running a
 * turn" identifies the caller precisely; any ambiguity (zero or several
 * candidates) attributes to nobody rather than guessing. */
function attributedSessionForWindow(
  windowId: string | null | undefined,
): AttributedAgentSession | null {
  if (typeof windowId !== 'string' || !windowId.trim()) return null;
  const id = windowId.trim();
  const candidates: AttributedAgentSession[] = [];
  for (const session of sessions.values()) {
    if (session.windowId === id && session.turnInFlight()) candidates.push(session);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** Supplied session identity is authoritative, including when stale or blank.
 * Only its absence permits a window's sole active turn to identify the caller.
 * Never infer request ownership from activity elsewhere in the app. */
export function attributedRequestSession(
  sessionId: string | null | undefined,
  windowId: string | null | undefined,
): AttributedAgentSession | null {
  return sessionId != null
    ? attributedAgentSession(sessionId)
    : attributedSessionForWindow(windowId);
}

/** The live panel sessions of one runtime. Window retirement and app quit
 * stop a window's (or every) session; project removal stops exactly the
 * sessions bound to that folder (filesystem identity comparison), leaving
 * sessions bound to other folders running. A folder switch stops nothing. */
export function liveSessionSet<T extends {
  readonly windowId: string;
  boundFolder(): string | null;
  dispose(termination?: AgentSessionTermination): void;
}>() {
  const sessions = new Set<T>();
  return {
    add: (session: T) => { sessions.add(session); },
    delete: (session: T) => { sessions.delete(session); },
    killWindow(windowId?: string): void {
      for (const session of [...sessions]) {
        if (windowId && session.windowId !== windowId) continue;
        session.dispose();
        sessions.delete(session);
      }
    },
    killFolder(folderAbs: string): void {
      for (const session of [...sessions]) {
        const bound = session.boundFolder();
        let matches = false;
        try {
          matches = bound != null && filesystemPath.equal(bound, folderAbs);
        } catch {
          matches = false;
        }
        if (!matches) continue;
        session.dispose({ kind: 'scope-removed', folder: folderAbs });
        sessions.delete(session);
      }
    },
  };
}
