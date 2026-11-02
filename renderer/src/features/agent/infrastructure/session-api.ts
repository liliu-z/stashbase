/** Owns the live WebSocket and HTTP conversation history. Wire translation stays
 * in session-wire; this adapter validates frames and classifies transport failures. */
import {
  AgentSessionError,
  type AgentConnectionListener,
  type AgentSessionPort,
} from '@/features/agent/application/ports';
import type { AgentHistoryEntry } from '@/features/agent/domain/conversation-history';
import type { AgentId, AgentScope, AgentSessionEvent } from '@/features/agent/domain/session';
import { replayedBlock } from '@/features/agent/infrastructure/session-replay';
import { clientEvent, sessionEvent, socketUrl } from '@/features/agent/infrastructure/session-wire';
import { request as httpRequest, type TransportRequest } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  agentSessionEmptyResponseSchema,
  agentSessionFailureSchema,
  agentSessionInfoSchema,
  agentSessionListResponseSchema,
  agentSessionRenameRequestSchema,
  agentSessionReplaySchema,
  type AgentSessionInfoWire,
} from '@/protocols/http/agent-sessions';
import {
  AGENT_SESSION_CLOSE,
  agentClientEventSchema,
  agentServerEventSchema,
} from '@/protocols/websocket/agent-session';

interface SocketLike {
  readonly readyState: number;
  addEventListener(
    type: 'close',
    listener: (event?: Pick<CloseEvent, 'code' | 'reason' | 'wasClean'>) => void,
  ): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(
    type: 'close',
    listener: (event?: Pick<CloseEvent, 'code' | 'reason' | 'wasClean'>) => void,
  ): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
  send(data: string): void;
}

type SocketFactory = (url: string) => SocketLike;

const SOCKET_OPEN = 1;

function scopeQuery(scope: AgentScope): URLSearchParams {
  const query = new URLSearchParams();
  query.set('folder', scope.path);
  return query;
}

function scopedPath(path: string, scope: AgentScope): string {
  return `${path}?${scopeQuery(scope)}`;
}

function historyEntry(
  row: AgentSessionInfoWire,
  agent: AgentId,
  requestedScope: AgentScope,
): AgentHistoryEntry {
  return {
    agent,
    hasContent: row.hasContent,
    id: row.id,
    lastModified: row.lastModified,
    scope: row.folder ? { kind: 'folder', path: row.folder } : requestedScope,
    title: row.title,
  };
}

function history(path: string, signal: AbortSignal): TransportRequest {
  return {
    error: AgentSessionError,
    failureSchema: agentSessionFailureSchema,
    path,
    signal,
  };
}

export function createAgentSessionAdapter(
  client: HttpClient,
  serverOrigin: string,
  createSocket: SocketFactory = (url) => new WebSocket(url),
): AgentSessionPort {
  return {
    connect(request, listener: AgentConnectionListener) {
      const connectionId = crypto.randomUUID();
      let activeTurnId: string | undefined;
      const connectionError = (message: string, close?: Pick<CloseEvent, 'code' | 'wasClean'>) =>
        client.reportError?.(new Error(message), 'agent-connection', {
          connection_id: connectionId,
          ...((listener.telemetryTurnId?.() ?? activeTurnId)
            ? { turn_id: listener.telemetryTurnId?.() ?? activeTurnId }
            : {}),
          ...(close
            ? { close_code: close.code, was_clean: close.wasClean, close_initiator: 'unknown' }
            : {}),
        });
      const socket = createSocket(socketUrl(serverOrigin, request, connectionId));
      let settledByServer = false;
      const onMessage = (message: { data: unknown }) => {
        if (typeof message.data !== 'string') {
          connectionError('Agent returned a non-text frame.');
          listener.onInvalidResponse();
          return;
        }
        let event: AgentSessionEvent | null;
        try {
          const wire = agentServerEventSchema.parse(JSON.parse(message.data));
          if (wire.t === 'exit' || wire.t === 'error') settledByServer = true;
          if (wire.t === 'turn-end') activeTurnId = undefined;
          event = sessionEvent(wire);
        } catch {
          connectionError('Agent returned an invalid frame.');
          listener.onInvalidResponse();
          return;
        }
        // A consumer exception is not a malformed frame. Let its original
        // error surface without closing a valid native stream as a wire failure.
        if (event) listener.onEvent(event);
      };
      const onClose = (event?: Pick<CloseEvent, 'code' | 'reason' | 'wasClean'>) => {
        if (
          !settledByServer &&
          event?.wasClean &&
          event.code === AGENT_SESSION_CLOSE.code &&
          event.reason === AGENT_SESSION_CLOSE.reason
        ) {
          settledByServer = true;
          listener.onEvent({ kind: 'exited', message: null });
        }
        if (!settledByServer)
          connectionError(
            `Agent connection closed unexpectedly (code ${event?.code ?? 'unknown'}, clean ${event?.wasClean ?? false}): ${event?.reason ?? ''}`,
            event,
          );
        listener.onClose();
      };
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      return {
        send(command) {
          if (socket.readyState !== SOCKET_OPEN) return false;
          try {
            socket.send(JSON.stringify(agentClientEventSchema.parse(clientEvent(command))));
            if (command.kind === 'prompt') {
              settledByServer = false;
              activeTurnId = command.telemetryTurnId;
            }
            return true;
          } catch {
            // A refused frame tells the runtime to reconnect and
            // resend, which is a better recovery than any sentence here.
            return false;
          }
        },
        close() {
          socket.removeEventListener('message', onMessage);
          socket.removeEventListener('close', onClose);
          if (socket.readyState === SOCKET_OPEN) {
            socket.send(JSON.stringify(agentClientEventSchema.parse({ t: 'close' })));
          }
          socket.close();
        },
      };
    },
    async list(agent, scope, signal) {
      const rows = await httpRequest(client, {
        ...history(scopedPath(`/api/agents/${agent}/sessions`, scope), signal),
        schema: agentSessionListResponseSchema,
      });
      return rows.map((row) => historyEntry(row, agent, scope));
    },
    async replay(entry, signal) {
      const replay = await httpRequest(client, {
        ...history(
          scopedPath(
            `/api/agents/${entry.agent}/sessions/${encodeURIComponent(entry.id)}/replay`,
            entry.scope,
          ),
          signal,
        ),
        schema: agentSessionReplaySchema,
      });
      const transcript = replay.messages.map((block) =>
        replayedBlock(block, entry.scope, serverOrigin),
      );
      return { effort: replay.effort, persona: replay.persona ?? null, transcript };
    },
    async rename(entry, title, signal) {
      const row = await httpRequest(client, {
        ...history(
          scopedPath(
            `/api/agents/${entry.agent}/sessions/${encodeURIComponent(entry.id)}`,
            entry.scope,
          ),
          signal,
        ),
        body: agentSessionRenameRequestSchema.parse({ title }),
        method: 'PATCH',
        schema: agentSessionInfoSchema,
      });
      return historyEntry(row, entry.agent, entry.scope);
    },
    async remove(entry, signal) {
      await httpRequest(client, {
        ...history(
          scopedPath(
            `/api/agents/${entry.agent}/sessions/${encodeURIComponent(entry.id)}`,
            entry.scope,
          ),
          signal,
        ),
        method: 'DELETE',
        schema: agentSessionEmptyResponseSchema,
      });
    },
  };
}
