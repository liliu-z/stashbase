import { reportAgentRuntimeError } from './error-reporting.ts';
/** OpenCode implementation of StashBase's Shared Agent Contract. */
import { randomUUID } from 'node:crypto';
import type { EventPermissionAsked } from '@opencode-ai/sdk/v2/types';
import type {
  Event,
  FileDiff,
  Message,
  Part,
  Session,
  ToolPart,
} from '@opencode-ai/sdk';
import type { WebSocket, RawData } from 'ws';
import { errorMessage } from './log.ts';
import {
  disposeSessionsBoundToFolder,
  resolveSessionBinding,
  type AgentClientEvent,
  type AgentHistoryActions,
  type AgentServerEvent,
  type AgentSessionTermination,
} from './agent-contract.ts';
import {
  registerAttributedAgentSession,
  unregisterAttributedAgentSession,
} from './agent-session-registry.ts';
import { getCurrentFolder, runWithWindowId } from './folder.ts';
import { filesystemPath } from './filesystem-path.ts';
import { agentTurnErrorEvent } from './agent-turn-failure.ts';
import { restoreHistoryAttachments } from './agent-history-attachments.ts';
import { isStashbaseWorkspaceEdit } from './agent-file-permissions.ts';
import type { AgentAccessMode } from '../shared/agent-runtime.ts';
import {
  createOpenCodeSessionRuntime,
  openCodeClient,
  type OpenCodeSessionRuntime,
} from './opencode-runtime.ts';
import type { SessionBlock, SessionInfo } from '../shared/agent-sessions.ts';

const DATA_REQUEST = { throwOnError: true as const };

/** Keep OpenCode's provider-specific tool vocabulary behind the adapter.
 * The renderer, history replay, and permission cards all consume the same
 * stable names already used by the Shared Agent Contract. */
export function normalizeOpenCodeToolName(name: string): string {
  switch (name.toLowerCase()) {
    case 'bash': return 'Bash';
    case 'read': return 'Read';
    case 'write': return 'Write';
    case 'edit': case 'patch': case 'apply_patch': return 'Edit';
    case 'multiedit': case 'multi_edit': return 'MultiEdit';
    case 'glob': case 'list': return 'Glob';
    case 'grep': return 'Grep';
    case 'webfetch': case 'web_fetch': return 'WebFetch';
    case 'websearch': case 'web_search': return 'WebSearch';
    case 'todowrite': case 'todo_write': return 'TodoWrite';
    case 'todoread': case 'todo_read': return 'TodoRead';
    case 'question': return 'AskUserQuestion';
    default: return name;
  }
}

function send(ws: WebSocket, event: AgentServerEvent): void {
  reportAgentRuntimeError('stashbase', event);
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function eventErrorMessage(event: Extract<Event, { type: 'session.error' }>): string {
  const error = event.properties.error;
  if (!error) return 'The Agent turn failed.';
  if ('data' in error && error.data && typeof error.data === 'object') {
    const data = error.data as { message?: unknown; responseBody?: unknown };
    if (typeof data.message === 'string' && data.message) return data.message;
    if (typeof data.responseBody === 'string' && data.responseBody) return data.responseBody;
  }
  return error.name;
}

/** Stateful because OpenCode may send cumulative parts without `delta`, and
 * because its busy/idle events can overlap the prompt acknowledgement. */
export class OpenCodeEventTranslator {
  private sessionId: string | null = null;
  private turnActive = false;
  private nativeTurnStarted = false;
  private lastFinishReason: string | undefined;
  private turnNumber = 0;
  private readonly messageTurns = new Map<string, number>();
  private readonly content = new Map<string, string>();
  private readonly tools = new Map<string, ToolPart['state']['status']>();
  private readonly toolNames = new Map<string, string>();
  private readonly toolInputs = new Map<string, Record<string, unknown>>();
  private readonly diffs = new Set<string>();
  private diffCounter = 0;
  private readonly errors = new Set<string>();
  /** OpenCode streams the reader's own prompt as parts too; only its role,
   * announced on the message before its parts, tells them from the reply. */
  private readonly userMessages = new Set<string>();

  bindSession(id: string): void { this.sessionId = id; }
  beginTurn(): AgentServerEvent[] {
    if (this.turnActive) return [];
    this.turnActive = true;
    this.turnNumber++;
    this.nativeTurnStarted = false;
    this.lastFinishReason = undefined;
    this.diffs.clear();
    return [{ t: 'turn-start' }];
  }
  isTurnActive(): boolean { return this.turnActive; }
  endTurnWithError(): AgentServerEvent[] { return this.finishTurn(true); }
  endTurnAfterInterrupt(): AgentServerEvent[] { return this.finishTurn(false, true); }

  translate(event: Event | EventPermissionAsked): AgentServerEvent[] {
    switch (event.type) {
      case 'session.status': {
        if (!this.matches(event.properties.sessionID)) return [];
        if (event.properties.status.type === 'busy') {
          const events = this.beginTurn();
          this.nativeTurnStarted = true;
          return events;
        }
        if (event.properties.status.type === 'retry') {
          return [{ t: 'notice', message: event.properties.status.message }];
        }
        return this.finishTurn(false);
      }
      case 'session.idle':
        return this.matches(event.properties.sessionID) ? this.finishTurn(false) : [];
      case 'session.error': {
        if (event.properties.sessionID && !this.matches(event.properties.sessionID)) return [];
        const message = eventErrorMessage(event);
        const events: AgentServerEvent[] = [];
        if (!this.errors.has(message)) {
          this.errors.add(message);
          events.push(agentTurnErrorEvent(message));
        }
        // A running native turn still owns cleanup until idle. Its message
        // error can arrive even after idle, so retain message/turn attribution.
        if (!this.nativeTurnStarted) events.push(...this.finishTurn(true));
        return events;
      }
      case 'session.updated':
        return this.matches(event.properties.info.id)
          ? [{ t: 'session-title', title: event.properties.info.title }]
          : [];
      case 'session.diff':
        if (!this.matches(event.properties.sessionID)) return [];
        return event.properties.diff.flatMap((diff) => this.fileDiff(diff));
      case 'message.updated': {
        const info = event.properties.info;
        if (!this.matches(info.sessionID)) return [];
        if (!this.messageTurns.has(info.id)) this.messageTurns.set(info.id, this.turnNumber);
        if (info.role === 'user') this.userMessages.add(info.id);
        if (info.role !== 'assistant' || !this.turnActive || this.messageTurns.get(info.id) !== this.turnNumber) return [];
        if (this.turnActive && info.finish) this.lastFinishReason = info.finish;
        if (!info.error) return [];
        const message = 'data' in info.error && typeof info.error.data?.message === 'string'
          ? info.error.data.message
          : info.error.name;
        if (this.errors.has(message)) return [];
        this.errors.add(message);
        return [agentTurnErrorEvent(message)];
      }
      case 'message.part.updated':
        return this.part(event.properties.part, event.properties.delta);
      case 'permission.asked':
      case 'permission.updated': {
        const permission = event.properties;
        if (!this.matches(permission.sessionID)) return [];
        const callId = 'permission' in permission ? permission.tool?.callID : permission.callID;
        const name = 'permission' in permission ? permission.permission : permission.type;
        const toolName = (callId && this.toolNames.get(callId)) || normalizeOpenCodeToolName(name);
        const input = (toolName.startsWith('stashbase_') && callId && this.toolInputs.get(callId))
          || (permission.metadata && typeof permission.metadata === 'object' ? permission.metadata : {});
        return [{
          t: 'permission',
          id: permission.id,
          toolUseId: callId ?? permission.id,
          name: toolName,
          title: 'title' in permission ? permission.title || null : null,
          input,
        }];
      }
      default:
        return [];
    }
  }

  private matches(id: string): boolean { return this.sessionId === id; }

  private finishTurn(isError: boolean, interrupted = false): AgentServerEvent[] {
    if (!this.turnActive) return [];
    // `session.status: idle` and `session.idle` can straddle the next prompt.
    // Its optimistic start is not evidence that the native runtime started it.
    if (!isError && !interrupted && !this.nativeTurnStarted) return [];
    const events: AgentServerEvent[] = [];
    if (!isError && !interrupted && this.lastFinishReason === 'unknown' && !this.errors.size) {
      events.push(agentTurnErrorEvent('The Agent model stopped without a complete response. The task may be incomplete; completed file changes have been kept.'));
      isError = true;
    }
    isError ||= this.errors.size > 0;
    this.turnActive = false;
    this.errors.clear();
    return [...events, { t: 'turn-end', isError }];
  }

  private part(part: Part, delta?: string): AgentServerEvent[] {
    if (!this.matches(part.sessionID) || this.userMessages.has(part.messageID)) return [];
    if (!this.messageTurns.has(part.messageID)) this.messageTurns.set(part.messageID, this.turnNumber);
    if (this.messageTurns.get(part.messageID) !== this.turnNumber) return [];
    if (part.type === 'step-finish' && this.turnActive) this.lastFinishReason = part.reason;
    if (part.type === 'text' || part.type === 'reasoning') {
      const previous = this.content.get(part.id) ?? '';
      const next = part.text;
      const addition = delta ?? (next.startsWith(previous) ? next.slice(previous.length) : next);
      this.content.set(part.id, next);
      if (!addition) return [];
      return [{ t: part.type === 'text' ? 'text' : 'thinking', delta: addition }];
    }
    if (part.type === 'retry') {
      return [{ t: 'notice', message: `Retrying the model request (attempt ${part.attempt}).` }];
    }
    if (part.type !== 'tool') return [];
    return this.tool(part);
  }

  private tool(part: ToolPart): AgentServerEvent[] {
    const id = part.callID;
    const prior = this.tools.get(id);
    const name = normalizeOpenCodeToolName(part.tool);
    const events: AgentServerEvent[] = [];
    this.toolNames.set(id, name);
    if (part.state.status !== 'pending') this.toolInputs.set(id, part.state.input);
    // Pending carries a partially parsed argument object. Wait for running
    // (or a direct terminal state) so the stable protocol opens one card with
    // the complete input rather than freezing the first partial snapshot.
    if (part.state.status !== 'pending' && (!prior || prior === 'pending')) {
      events.push({ t: 'tool', id, name, input: part.state.input });
    }
    if ((part.state.status === 'completed' || part.state.status === 'error') && prior !== part.state.status) {
      events.push({
        t: 'tool-result',
        id,
        content: part.state.status === 'completed' ? part.state.output : part.state.error,
        isError: part.state.status === 'error',
      });
    }
    this.tools.set(id, part.state.status);
    return events;
  }

  private fileDiff(diff: FileDiff): AgentServerEvent[] {
    const key = `${diff.file}\0${diff.before}\0${diff.after}`;
    if (this.diffs.has(key)) return [];
    this.diffs.add(key);
    return [{
      t: 'file-diff',
      id: `diff:${this.sessionId}:${++this.diffCounter}`,
      file: diff.file,
      before: diff.before,
      after: diff.after,
      additions: diff.additions,
      deletions: diff.deletions,
    }];
  }
}

export class OpenCodePanelSession {
  private readonly abort = new AbortController();
  private readonly translator = new OpenCodeEventTranslator();
  private readonly cwd: string;
  readonly agentId = 'stashbase' as const;
  readonly attributionId = randomUUID();
  readonly windowId: string;
  private readonly runtime: OpenCodeSessionRuntime;
  private sessionId: string | null = null;
  private client: Awaited<ReturnType<typeof openCodeClient>> | null = null;
  private disposed = false;
  private interrupted = false;
  private access: AgentAccessMode;
  private readonly pendingPermissions = new Set<string>();
  private readonly seenPermissions = new Set<string>();
  private readonly waitingToolPermissions = new Map<string, Extract<AgentServerEvent, { t: 'permission' }>>();
  private readonly stopRuntimeExitListener: () => void;
  private readonly onMessage = (data: RawData) => { void this.handleMessage(data); };
  private readonly onClose = () => this.dispose();

  constructor(
    private readonly ws: WebSocket,
    private readonly options: import('./agent-contract.ts').AgentConnectionOptions,
    runtime?: OpenCodeSessionRuntime,
  ) {
    const binding = runWithWindowId(options.windowId, () => resolveSessionBinding({
      folder: options.folder,
      currentFolder: getCurrentFolder(),
    }));
    this.cwd = binding.cwd;
    // Auto is not offered here; a new chat asks for it before the renderer
    // settles, and Edit is where it settles.
    this.access = options.access === 'auto' ? 'acceptEdits'
      : options.access === 'acceptEdits' || options.access === 'plan' ? options.access : 'default';
    this.windowId = options.windowId;
    this.runtime = runtime ?? createOpenCodeSessionRuntime({
      windowId: this.windowId,
      agentSessionId: this.attributionId,
      persona: options.persona,
    });
    this.stopRuntimeExitListener = this.runtime.onExit((error) => {
      if (!this.disposed) this.fail(error, true);
    });
    registerAttributedAgentSession(this.attributionId, this);
    ws.on('message', this.onMessage);
    ws.on('close', this.onClose);
    void this.initialize();
  }

  boundFolder(): string | null { return this.cwd; }
  turnInFlight(): boolean { return this.translator.isTurnActive(); }
  ownedByWindow(windowId: string): boolean { return this.options.windowId === windowId; }

  dispose(termination?: AgentSessionTermination): void {
    if (this.disposed) return;
    if (termination) send(this.ws, { t: 'exit', reason: termination.kind, folder: termination.folder });
    this.disposed = true;
    this.pendingPermissions.clear();
    this.seenPermissions.clear();
    this.waitingToolPermissions.clear();
    this.abort.abort();
    this.stopRuntimeExitListener();
    this.runtime.endTurn();
    this.ws.off('message', this.onMessage);
    this.ws.off('close', this.onClose);
    unregisterAttributedAgentSession(this.attributionId);
    if (this.client && this.sessionId) {
      void this.client.session.abort({
        ...DATA_REQUEST,
        path: { id: this.sessionId },
      }).catch(() => {});
    }
    sessions.delete(this);
    void this.runtime.close();
    if (this.ws.readyState === this.ws.OPEN) this.ws.close();
  }

  private async initialize(): Promise<void> {
    try {
      this.client = await this.runtime.client(this.cwd);
      const subscription = await this.client.event.subscribe({ signal: this.abort.signal });
      void this.consume(subscription.stream);
      const nativeResponse = this.options.resume
        ? await this.client.session.get({ ...DATA_REQUEST, path: { id: this.options.resume } })
        : await this.client.session.create({ ...DATA_REQUEST, body: { title: 'New Chat' } });
      const native = nativeResponse.data;
      if (this.disposed) return;
      if (!filesystemPath.equal(native.directory, this.cwd)) {
        throw new Error('The OpenCode session does not belong to this Chat scope.');
      }
      this.sessionId = native.id;
      this.translator.bindSession(native.id);
      send(this.ws, { t: 'session-id', id: native.id });
      if (native.title) send(this.ws, { t: 'session-title', title: native.title });
      send(this.ws, { t: 'skills', skills: [], state: 'empty' });
      send(this.ws, { t: 'ready' });
    } catch (error) {
      this.fail(error, true);
    }
  }

  private async consume(stream: AsyncGenerator<Event>): Promise<void> {
    try {
      for await (const event of stream) {
        if (this.disposed) return;
        const translated = this.translator.translate(event);
        for (const item of translated) {
          if (item.t === 'permission') {
            if (this.seenPermissions.has(item.id)) continue;
            // OpenCode can ask for MCP permission before publishing the running
            // tool's arguments. Wait for that same call rather than granting a
            // tool-wide rule or showing an approval card without its file path.
            if (!this.interrupted && this.access !== 'plan'
                && item.name.startsWith('stashbase_') && Object.keys(item.input).length === 0) {
              this.waitingToolPermissions.set(item.id, item);
              continue;
            }
            await this.handlePermission(item);
            continue;
          }
          send(this.ws, item);
          if (item.t === 'tool') {
            for (const permission of this.waitingToolPermissions.values()) {
              if (permission.toolUseId !== item.id) continue;
              this.waitingToolPermissions.delete(permission.id);
              await this.handlePermission({ ...permission, input: item.input });
            }
          }
        }
        if (translated.some((item) => item.t === 'turn-end')) {
          this.pendingPermissions.clear();
          this.seenPermissions.clear();
          this.waitingToolPermissions.clear();
          this.runtime.endTurn();
        }
      }
    } catch (error) {
      if (!this.abort.signal.aborted) this.fail(error, true);
    }
  }

  private async handleMessage(raw: RawData): Promise<void> {
    let event: AgentClientEvent;
    try { event = JSON.parse(raw.toString()) as AgentClientEvent; } catch { return; }
    if (event.t === 'close') { this.dispose(); return; }
    if (event.t === 'set-mode') {
      if (!this.turnInFlight() && (event.mode === 'default' || event.mode === 'acceptEdits' || event.mode === 'plan')) {
        this.access = event.mode;
      }
      return;
    }
    if (!this.client || !this.sessionId) return;
    try {
      switch (event.t) {
        case 'prompt':
          if (this.turnInFlight()) return;
          this.interrupted = false;
          this.runtime.beginTurn(randomUUID());
          for (const translated of this.translator.beginTurn()) send(this.ws, translated);
          if (event.titleHint) {
            void this.client.session.update({
              ...DATA_REQUEST,
              path: { id: this.sessionId },
              body: { title: event.titleHint },
            }).catch(() => {});
          }
          await this.client.session.promptAsync({
            ...DATA_REQUEST,
            path: { id: this.sessionId },
            body: {
              model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' },
              agent: this.access === 'plan' ? 'stashbase-plan' : this.access === 'acceptEdits' ? 'stashbase-edit' : 'stashbase-folder',
              parts: [{ type: 'text', text: event.text }],
            },
          });
          break;
        case 'interrupt':
          this.interrupted = true;
          this.pendingPermissions.clear();
          this.waitingToolPermissions.clear();
          await this.client.session.abort({ ...DATA_REQUEST, path: { id: this.sessionId } });
          for (const item of this.translator.endTurnAfterInterrupt()) send(this.ws, item);
          this.runtime.endTurn();
          break;
        case 'permission-reply':
          if (!this.pendingPermissions.delete(event.id)) return;
          await this.replyPermission(event.id, event.allow);
          break;
        case 'refresh-skills':
          send(this.ws, { t: 'skills', skills: [], state: 'empty' });
          break;
        case 'steer':
          send(this.ws, { t: 'steer-result', id: event.id, ok: false, message: 'The Default Agent queues follow-up prompts.' });
          break;
      }
    } catch (error) {
      this.fail(error, false);
    }
  }

  private async handlePermission(item: Extract<AgentServerEvent, { t: 'permission' }>): Promise<void> {
    if (this.seenPermissions.has(item.id)) return;
    this.seenPermissions.add(item.id);
    if (this.interrupted || !this.turnInFlight()) {
      await this.replyPermission(item.id, false);
      return;
    }
    if (this.access === 'plan' && ![
      'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'external_directory',
      'stashbase_read_file', 'stashbase_list_directory', 'stashbase_list_projects', 'stashbase_search_project',
    ].includes(item.name)) {
      await this.replyPermission(item.id, false);
      return;
    }
    const projectEdit = item.name.startsWith('stashbase_') && isStashbaseWorkspaceEdit({
      input: { server: 'stashbase', tool: item.name.slice('stashbase_'.length), arguments: item.input },
    }, this.cwd);
    if (this.access === 'acceptEdits' && projectEdit) {
      await this.replyPermission(item.id, true);
      return;
    }
    this.pendingPermissions.add(item.id);
    send(this.ws, item);
  }

  private async replyPermission(id: string, allow: boolean): Promise<void> {
    if (!this.client || !this.sessionId) return;
    await this.client.postSessionIdPermissionsPermissionId({
      ...DATA_REQUEST,
      path: { id: this.sessionId, permissionID: id },
      body: { response: allow ? 'once' : 'reject' },
    });
  }

  private fail(error: unknown, terminal: boolean): void {
    this.pendingPermissions.clear();
    this.seenPermissions.clear();
    this.waitingToolPermissions.clear();
    const message = errorMessage(error);
    send(this.ws, agentTurnErrorEvent(message));
    this.runtime.endTurn();
    if (terminal) {
      send(this.ws, { t: 'exit', message });
      this.dispose();
    } else {
      for (const event of this.translator.endTurnWithError()) send(this.ws, event);
    }
  }
}

const sessions = new Set<OpenCodePanelSession>();

export function attachOpenCodeWebSocket(
  ws: WebSocket,
  options: import('./agent-contract.ts').AgentConnectionOptions,
): void {
  const session = new OpenCodePanelSession(ws, options);
  sessions.add(session);
}

export function killActiveOpenCode(windowId?: string): void {
  for (const session of [...sessions]) {
    if (windowId && !session.ownedByWindow(windowId)) continue;
    session.dispose();
  }
}

export function killOpenCodeSessionsForFolder(folderAbs: string): void {
  disposeSessionsBoundToFolder(sessions, folderAbs);
}

export function openCodeSessionHasContent(
  session: Pick<Session, 'title'>,
  messageCount: number,
): boolean {
  return session.title !== 'New Chat' || messageCount > 0;
}

function sessionInfo(session: Session, hasContent = session.title !== 'New Chat'): SessionInfo {
  return {
    id: session.id,
    title: session.title,
    lastModified: session.time.updated,
    hasContent,
    cwd: session.directory,
  };
}

function textOf(parts: Part[], type: 'text' | 'reasoning'): string {
  return parts.filter((part): part is Extract<Part, { type: typeof type }> => part.type === type)
    .map((part) => part.text)
    .join('');
}

/** One stored message as transcript blocks. A prompt's generated context
 * suffixes return to chips, as they do for the other runtimes' history. */
export function blocksForMessage(info: Message, parts: Part[]): SessionBlock[] {
  const blocks: SessionBlock[] = [];
  if (info.role === 'user') {
    const restored = restoreHistoryAttachments(textOf(parts, 'text'));
    if (restored.text || restored.attachments.length) {
      blocks.push({
        kind: 'user',
        id: info.id,
        text: restored.text,
        ...(restored.attachments.length ? { attachments: restored.attachments } : {}),
      });
    }
    return blocks;
  }
  const reasoning = textOf(parts, 'reasoning');
  if (reasoning) blocks.push({ kind: 'thinking', id: `${info.id}:reasoning`, text: reasoning });
  const text = textOf(parts, 'text');
  if (text) blocks.push({ kind: 'assistant', id: `${info.id}:text`, text });
  for (const part of parts) {
    if (part.type !== 'tool' || part.state.status === 'pending' || part.state.status === 'running') continue;
    blocks.push({
      kind: 'tool',
      id: part.callID,
      name: normalizeOpenCodeToolName(part.tool),
      input: part.state.input,
      status: part.state.status === 'error' ? 'error' : 'done',
      result: part.state.status === 'error' ? part.state.error : part.state.output,
    });
  }
  return blocks;
}

function blocksForDiffs(diffs: FileDiff[]): SessionBlock[] {
  return diffs.map((diff, index) => ({
    kind: 'tool',
    id: `diff:history:${index}:${diff.file}`,
    name: 'FileDiff',
    input: {
      path: diff.file,
      before: diff.before,
      after: diff.after,
      additions: diff.additions,
      deletions: diff.deletions,
    },
    status: 'done',
  }));
}

async function sessionBlocks(
  client: Awaited<ReturnType<typeof openCodeClient>>,
  id: string,
): Promise<SessionBlock[]> {
  const [messages, diffs] = await Promise.all([
    client.session.messages({ ...DATA_REQUEST, path: { id } }),
    client.session.diff({ ...DATA_REQUEST, path: { id } }),
  ]);
  return [
    ...messages.data.flatMap((message) => blocksForMessage(message.info, message.parts)),
    ...blocksForDiffs(diffs.data),
  ];
}

async function clientFor(folder: string) {
  if (!folder) throw new Error('Open a project before reading chat history.');
  const cwd = folder;
  return { client: await openCodeClient(cwd), cwd };
}

async function assertSessionInScope(
  client: Awaited<ReturnType<typeof openCodeClient>>,
  id: string,
  cwd: string,
): Promise<Session> {
  const response = await client.session.get({ ...DATA_REQUEST, path: { id } });
  if (!filesystemPath.equal(response.data.directory, cwd)) {
    throw new Error('The OpenCode session does not belong to this Chat scope.');
  }
  return response.data;
}

export function openCodeHistoryActions(): AgentHistoryActions {
  return {
    async list(folder) {
      const { client, cwd } = await clientFor(folder);
      const list = await client.session.list(DATA_REQUEST);
      return Promise.all(
        list.data
          .filter((session) => filesystemPath.equal(session.directory, cwd))
          .map(async (session) => {
            if (session.title !== 'New Chat') return sessionInfo(session, true);
            try {
              const messages = await client.session.messages({
                ...DATA_REQUEST,
                path: { id: session.id },
              });
              return sessionInfo(
                session,
                openCodeSessionHasContent(session, messages.data.length),
              );
            } catch {
              // A failed content probe must not hide a potentially valuable
              // conversation. Keep it visible until a later listing resolves.
              return sessionInfo(session, true);
            }
          }),
      );
    },
    async messages(id, folder) {
      const { client, cwd } = await clientFor(folder);
      await assertSessionInScope(client, id, cwd);
      return sessionBlocks(client, id);
    },
    async replay(id, folder) {
      const { client, cwd } = await clientFor(folder);
      await assertSessionInScope(client, id, cwd);
      return {
        protocol: 2,
        messages: await sessionBlocks(client, id),
        effort: null,
      };
    },
    async rename(id, title, folder) {
      const { client, cwd } = await clientFor(folder);
      await assertSessionInScope(client, id, cwd);
      const updated = await client.session.update({ ...DATA_REQUEST, path: { id }, body: { title } });
      return sessionInfo(updated.data, true);
    },
    async remove(id, folder) {
      const { client, cwd } = await clientFor(folder);
      await assertSessionInScope(client, id, cwd);
      await client.session.delete({ ...DATA_REQUEST, path: { id } });
    },
  };
}
