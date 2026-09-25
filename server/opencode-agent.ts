/** OpenCode implementation of StashBase's Shared Agent Contract. */
import { randomUUID } from 'node:crypto';
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
  private readonly content = new Map<string, string>();
  private readonly tools = new Map<string, ToolPart['state']['status']>();
  private readonly toolNames = new Map<string, string>();
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
    this.diffs.clear();
    return [{ t: 'turn-start' }];
  }
  isTurnActive(): boolean { return this.turnActive; }
  endTurnWithError(): AgentServerEvent[] { return this.finishTurn(true); }

  translate(event: Event): AgentServerEvent[] {
    switch (event.type) {
      case 'session.status': {
        if (!this.matches(event.properties.sessionID)) return [];
        if (event.properties.status.type === 'busy') return this.beginTurn();
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
        events.push(...this.finishTurn(true));
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
        if (this.matches(info.sessionID) && info.role === 'user') this.userMessages.add(info.id);
        if (!this.matches(info.sessionID) || info.role !== 'assistant' || !info.error) return [];
        const message = 'data' in info.error && typeof info.error.data?.message === 'string'
          ? info.error.data.message
          : info.error.name;
        if (this.errors.has(message)) return [];
        this.errors.add(message);
        return [agentTurnErrorEvent(message)];
      }
      case 'message.part.updated':
        return this.part(event.properties.part, event.properties.delta);
      case 'permission.updated': {
        const permission = event.properties;
        if (!this.matches(permission.sessionID)) return [];
        const input = permission.metadata && typeof permission.metadata === 'object'
          ? permission.metadata
          : {};
        return [{
          t: 'permission',
          id: permission.id,
          toolUseId: permission.callID ?? permission.id,
          name: permission.callID
            ? this.toolNames.get(permission.callID) ?? normalizeOpenCodeToolName(permission.type)
            : normalizeOpenCodeToolName(permission.type),
          title: permission.title || null,
          input,
        }];
      }
      default:
        return [];
    }
  }

  private matches(id: string): boolean { return this.sessionId === id; }

  private finishTurn(isError: boolean): AgentServerEvent[] {
    if (!this.turnActive) return [];
    this.turnActive = false;
    this.errors.clear();
    return [{ t: 'turn-end', isError }];
  }

  private part(part: Part, delta?: string): AgentServerEvent[] {
    if (!this.matches(part.sessionID) || this.userMessages.has(part.messageID)) return [];
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
    this.windowId = options.windowId;
    this.runtime = runtime ?? createOpenCodeSessionRuntime({
      windowId: this.windowId,
      agentSessionId: this.attributionId,
      cwd: this.cwd,
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
        for (const item of translated) send(this.ws, item);
        if (translated.some((item) => item.t === 'turn-end')) this.runtime.endTurn();
      }
    } catch (error) {
      if (!this.abort.signal.aborted) this.fail(error, true);
    }
  }

  private async handleMessage(raw: RawData): Promise<void> {
    let event: AgentClientEvent;
    try { event = JSON.parse(raw.toString()) as AgentClientEvent; } catch { return; }
    if (event.t === 'close') { this.dispose(); return; }
    if (event.t === 'set-mode') return;
    if (!this.client || !this.sessionId) return;
    try {
      switch (event.t) {
        case 'prompt':
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
              agent: 'stashbase-folder',
              parts: [{ type: 'text', text: event.text }],
            },
          });
          break;
        case 'interrupt':
          await this.client.session.abort({ ...DATA_REQUEST, path: { id: this.sessionId } });
          break;
        case 'permission-reply':
          await this.client.postSessionIdPermissionsPermissionId({
            ...DATA_REQUEST,
            path: { id: this.sessionId, permissionID: event.id },
            body: { response: event.allow ? (event.always ? 'always' : 'once') : 'reject' },
          });
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

  private fail(error: unknown, terminal: boolean): void {
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
