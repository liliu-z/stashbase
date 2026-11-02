/** Translates the live session protocol into feature commands and events. */
import type { AgentConnectRequest } from '@/features/agent/application/ports';
import type { AgentAccessMode } from '@/features/agent/domain/access';
import type { AgentSkill } from '@/features/agent/domain/runtime-catalog';
import type { AgentSessionEvent } from '@/features/agent/domain/session';
import type { AgentSessionCommand } from '@/features/agent/domain/session-command';
import { toModel } from '@/features/agent/infrastructure/model-wire';
import {
  agentSessionConnectSchema,
  type AgentAccessMode as AgentAccessModeWire,
  type AgentClientEvent,
  type AgentServerEvent,
  type AgentSkill as AgentSkillWire,
} from '@/protocols/websocket/agent-session';

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
export function clientEvent(command: AgentSessionCommand): AgentClientEvent {
  switch (command.kind) {
    case 'prompt':
      return {
        ...(command.attachments?.length ? { attachments: command.attachments } : {}),
        t: 'prompt',
        ...(command.telemetryTurnId ? { telemetryTurnId: command.telemetryTurnId } : {}),
        text: command.text,
        ...(command.titleHint ? { titleHint: command.titleHint } : {}),
        ...(command.skill === null ? {} : { skill: command.skill }),
      };
    case 'steer':
      return { id: command.id, t: 'steer', text: command.text };
    case 'interrupt':
      return { t: 'interrupt' };
    case 'reply-permission':
      return {
        t: 'permission-reply',
        id: command.id,
        allow: command.allow,
        ...(command.always === null ? {} : { always: command.always }),
        ...(command.scope ? { scope: command.scope } : {}),
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

export function sessionEvent(event: AgentServerEvent): AgentSessionEvent | null {
  switch (event.t) {
    case 'ready':
      return { kind: 'ready' };
    case 'instructions-changed':
      return { kind: 'instructions-changed' };
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
        ...(event.effort === undefined ? {} : { effort: event.effort }),
        fallback: event.fallback ?? null,
        kind: 'models',
        models: event.models.map(toModel),
      };
    case 'tool':
      return {
        id: event.id,
        input: event.input,
        kind: 'tool-started',
        name: event.name,
        ...(event.crew ? { crew: event.crew } : {}),
      };
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
        ...(event.approvalScopes ? { approvalScopes: event.approvalScopes } : {}),
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
        : { kind: 'exited', message: event.message ?? null, failure: event.failure?.kind };
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
      return { id: event.id, kind: 'steer-result', ok: event.ok };
    case 'turn-changes':
      return { files: event.files, kind: 'turn-changed', turnId: event.turnId };
  }
}

export function socketUrl(
  serverOrigin: string,
  request: AgentConnectRequest,
  connectionId: string,
): string {
  const url = new URL('/ws/agent', serverOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const wire = agentSessionConnectSchema.parse({
    agent: request.agent,
    telemetryConnectionId: connectionId,
    access: ACCESS_MODE_WIRE[request.access ?? 'auto'],
    effort: request.effort,
    model: request.model,
    persona: request.persona,
    crew: request.crew,
    resume: request.resume,
    folder: request.scope.path,
  });
  for (const [key, value] of Object.entries(wire)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
