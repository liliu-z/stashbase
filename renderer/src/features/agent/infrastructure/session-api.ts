/** The Agent session transport: one WebSocket for the live conversation and
 *  the HTTP calls behind conversation history. Wire vocabulary stops here —
 *  server frames are translated into the feature's own session events, and
 *  refusals are reported on the session error ladder — so nothing above this
 *  module reads a protocol schema. */
import {
  AgentSessionError,
  type AgentConnectionListener,
  type AgentConnectRequest,
  type AgentSessionPort,
} from '@/features/agent/application/ports';
import type { AgentAccessMode } from '@/features/agent/domain/access';
import { passageContextItem, type AgentContextItem } from '@/features/agent/domain/context';
import type { AgentHistoryEntry } from '@/features/agent/domain/conversation-history';
import type { AgentSkill } from '@/features/agent/domain/runtime-catalog';
import type { AgentId, AgentScope, AgentSessionEvent } from '@/features/agent/domain/session';
import type { AgentSessionCommand } from '@/features/agent/domain/session-command';
import type { AgentTranscriptBlock } from '@/features/agent/domain/session-transcript';
import { toModel } from '@/features/agent/infrastructure/model-wire';
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
  type AgentSessionBlockWire,
} from '@/protocols/http/agent-sessions';
import {
  agentClientEventSchema,
  agentServerEventSchema,
  agentSessionConnectSchema,
  type AgentAccessMode as AgentAccessModeWire,
  type AgentClientEvent,
  type AgentServerEvent,
  type AgentSkill as AgentSkillWire,
} from '@/protocols/websocket/agent-session';

interface SocketLike {
  readonly readyState: number;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'close', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
  send(data: string): void;
}

type SocketFactory = (url: string) => SocketLike;

const SOCKET_OPEN = 1;

/** The browser socket, read through the narrow surface this adapter uses. */
function browserSocket(url: string): SocketLike {
  return new WebSocket(url);
}

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

/** The wire spells an absent field `key?: T | undefined`; the feature spells
 *  it as a missing key. Rebuild rather than widen, so nothing above this
 *  module has to test for both. */
function toSkill(wire: AgentSkillWire): AgentSkill {
  return {
    id: wire.id,
    label: wire.label,
    ...(wire.description === undefined ? {} : { description: wire.description }),
    ...(wire.argumentHint === undefined ? {} : { argumentHint: wire.argumentHint }),
  };
}

/** Both spellings of the access mode, paired once. The `satisfies` is what
 *  makes a wire enum that drifts a compile error rather than a runtime
 *  refusal at the socket. */
const ACCESS_MODE_WIRE = {
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  default: 'default',
  plan: 'plan',
} as const satisfies Record<AgentAccessMode, AgentAccessModeWire>;

/** One session command, encoded for the socket. A choice the feature spells
 *  `null` is a field the wire simply omits. */
function clientEvent(command: AgentSessionCommand): AgentClientEvent {
  switch (command.kind) {
    case 'prompt':
      return {
        t: 'prompt',
        text: command.text,
        ...(command.titleHint ? { titleHint: command.titleHint } : {}),
        ...(command.skill === null ? {} : { skill: command.skill }),
      };
    case 'interrupt':
      return { t: 'interrupt' };
    case 'reply-permission':
      return {
        t: 'permission-reply',
        id: command.id,
        allow: command.allow,
        ...(command.always === null ? {} : { always: command.always }),
        ...(command.answers === null ? {} : { answers: command.answers }),
      };
    case 'select-model':
      return { t: 'set-model', ...(command.model === null ? {} : { model: command.model }) };
    case 'set-access-mode':
      return { t: 'set-mode', mode: ACCESS_MODE_WIRE[command.mode] };
    case 'refresh-skills':
      return { t: 'refresh-skills' };
  }
}

function sessionEvent(event: AgentServerEvent): AgentSessionEvent | null {
  switch (event.t) {
    case 'ready':
      return { kind: 'ready' };
    case 'session-id':
      return { id: event.id, kind: 'identified' };
    case 'session-title':
      return { kind: 'titled', title: event.title };
    case 'turn-start':
      return { kind: 'turn-started' };
    case 'text':
      return { delta: event.delta, kind: 'text' };
    case 'thinking':
      return { delta: event.delta, kind: 'thinking' };
    case 'models':
      return {
        activeModel: event.activeModel ?? null,
        fallback: event.fallback ?? null,
        kind: 'models',
        models: event.models.map(toModel),
      };
    case 'tool':
      return { id: event.id, input: event.input, kind: 'tool-started', name: event.name };
    case 'tool-delta':
      return { delta: event.delta, id: event.id, kind: 'tool-output' };
    case 'tool-result':
      return {
        content: event.content,
        id: event.id,
        isError: event.isError,
        kind: 'tool-finished',
      };
    case 'permission':
      return {
        id: event.id,
        input: event.input,
        kind: 'permission-requested',
        name: event.name,
        title: event.title,
        toolUseId: event.toolUseId,
      };
    case 'turn-end':
      return { isError: event.isError, kind: 'turn-ended' };
    case 'notice':
      return { kind: 'notice', message: event.message };
    case 'error':
      return { failure: event.failure?.kind, kind: 'failed', message: event.message };
    case 'exit':
      return 'reason' in event
        ? { folderPath: event.folder, kind: 'scope-retired' }
        : { kind: 'exited', message: event.message ?? null };
    case 'file-diff':
      return {
        additions: event.additions,
        after: event.after,
        before: event.before,
        deletions: event.deletions,
        id: event.id,
        kind: 'file-changed',
        path: event.file,
      };
    case 'skills':
      return {
        error: event.error ?? null,
        kind: 'skills',
        skills: event.skills.map(toSkill),
        state: event.state,
      };
    case 'steer-result':
      return null;
  }
}

/** One session-history call. The service names its own refusal, so that
 *  sentence is what the reader sees. */
/** One replayed block in the feature's terms. Image previews are server
 *  routes, absolutized here where the origin is known. A turn that carried a
 *  selected passage replays as bound context, so its passage reads as the
 *  chip it was sent as; a quote outside the chat's folder stays an upload. */
function replayedBlock(
  block: AgentSessionBlockWire,
  scope: AgentScope,
  serverOrigin: string,
): AgentTranscriptBlock {
  if (block.kind !== 'user' || !block.attachments) return block;
  const attachments = block.attachments.map(({ quote, ...attachment }) => ({
    attachment: attachment.previewUrl
      ? { ...attachment, previewUrl: new URL(attachment.previewUrl, serverOrigin).href }
      : attachment,
    quote,
  }));
  if (!attachments.some(({ quote }) => quote !== undefined))
    return { ...block, attachments: attachments.map(({ attachment }) => attachment) };
  const folder = `${scope.path}/`;
  const context = attachments.map(({ attachment, quote }): AgentContextItem => {
    const passage =
      quote !== undefined && attachment.path.startsWith(folder)
        ? passageContextItem(
            { folderPath: scope.path, path: attachment.path.slice(folder.length) },
            quote,
          )
        : null;
    return (
      passage ?? {
        dims: attachment.dims,
        kind: 'transient',
        name: attachment.name,
        path: attachment.path,
        previewUrl: attachment.previewUrl,
      }
    );
  });
  const { attachments: _replayed, ...rest } = block;
  return { ...rest, context };
}

function history(path: string, signal: AbortSignal, invalid: string): TransportRequest {
  return {
    error: AgentSessionError,
    failureSchema: agentSessionFailureSchema,
    messages: { 'invalid-response': invalid, unavailable: 'Agent session service is unavailable.' },
    path,
    serverMessage: true,
    signal,
  };
}

function socketUrl(serverOrigin: string, request: AgentConnectRequest): string {
  const url = new URL('/ws/agent', serverOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const wire = agentSessionConnectSchema.parse({
    agent: request.agent,
    access: ACCESS_MODE_WIRE[request.access ?? 'auto'],
    effort: request.effort,
    model: request.model,
    resume: request.resume,
    folder: request.scope.path,
  });
  for (const [key, value] of Object.entries(wire)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function createAgentSessionAdapter(
  client: HttpClient,
  serverOrigin: string,
  createSocket: SocketFactory = browserSocket,
): AgentSessionPort {
  return {
    connect(request, listener: AgentConnectionListener) {
      const socket = createSocket(socketUrl(serverOrigin, request));
      const onMessage = (message: { data: unknown }) => {
        if (typeof message.data !== 'string') {
          listener.onInvalidResponse();
          return;
        }
        try {
          const event = sessionEvent(agentServerEventSchema.parse(JSON.parse(message.data)));
          if (event) listener.onEvent(event);
        } catch {
          listener.onInvalidResponse();
        }
      };
      const onClose = () => listener.onClose();
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      return {
        send(command) {
          if (socket.readyState !== SOCKET_OPEN) return false;
          try {
            socket.send(JSON.stringify(agentClientEventSchema.parse(clientEvent(command))));
            return true;
          } catch {
            // swallowed: a socket that refuses the frame is already closing.
            // Answering false is what tells the runtime to reconnect and
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
        ...history(
          scopedPath(`/api/agents/${agent}/sessions`, scope),
          signal,
          'Agent history returned an invalid response.',
        ),
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
          'Agent replay returned an invalid response.',
        ),
        schema: agentSessionReplaySchema,
      });
      const transcript = replay.messages.map((block) =>
        replayedBlock(block, entry.scope, serverOrigin),
      );
      return { effort: replay.effort, transcript };
    },
    async rename(entry, title, signal) {
      const row = await httpRequest(client, {
        ...history(
          scopedPath(
            `/api/agents/${entry.agent}/sessions/${encodeURIComponent(entry.id)}`,
            entry.scope,
          ),
          signal,
          'Agent rename returned an invalid response.',
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
          'Agent delete returned an invalid response.',
        ),
        method: 'DELETE',
        schema: agentSessionEmptyResponseSchema,
      });
    },
  };
}
