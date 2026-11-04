import { AGENT_SESSION_CLOSE } from '../shared/agent-protocol.ts';
import { agentWriteDiagnosticContext, agentDiagnosticStage, beginAgentDiagnosticTurn, markAgentDiagnosticClosing, reportAgentRuntimeError } from './error-reporting.ts';
/** OpenCode implementation of StashBase's Shared Agent Contract. */
import { prepareAgentAttachments } from './agent-attachments.ts';
import { agentClientEventSchema } from '../shared/protocols/websocket/agent-session.ts';
import { randomUUID } from 'node:crypto';
import type { ContextOverflowError, EventMessagePartDelta, EventPermissionAsked } from '@opencode-ai/sdk/v2/types';
import type {
  Event,
  FileDiff,
  FilePartInput,
  Message,
  Part,
  Session,
  ToolPart,
} from '@opencode-ai/sdk';
import type { WebSocket, RawData } from 'ws';
import { errorMessage, logger } from './log.ts';
import {
  resolveSessionBinding,
  type AgentClientEvent,
  type AgentConnectionOptions,
  type AgentHistoryActions,
  type AgentServerEvent,
  type AgentSessionTermination,
} from './agent-contract.ts';
import {
  attributedAgentSession,
  liveSessionSet,
  registerAttributedAgentSession,
  unregisterAttributedAgentSession,
} from './agent-session-registry.ts';
import { getCurrentFolder, normalizeWindowId, runWithWindowId } from './folder.ts';
import { filesystemPath } from './filesystem-path.ts';
import { agentSessionExitEvent, agentTurnErrorEvent } from './agent-turn-failure.ts';
import { isTransientAttachmentPath } from './routes/attach.ts';
import { historyImageAttachment, restoreHistoryAttachments } from './agent-history-attachments.ts';
import { isStashbaseWorkspaceEdit } from './agent-file-permissions.ts';
import type { AgentAccessMode } from '../shared/agent-runtime.ts';
import {
  createOpenCodeSessionRuntime,
  discardWarmOpenCodeForWindow,
  discardWarmOpenCodeForFolder,
  openCodeClient,
  type AgentToolResult,
  type OpenCodeSessionRuntime,
} from './opencode-runtime.ts';
import type { SessionBlock, SessionInfo } from '../shared/agent-sessions.ts';
import {
  DEFAULT_HOSTED_AGENT_PROFILE,
  defaultHostedAgentProfile,
  hostedAgentCatalogModels,
} from './hosted-agent-models.ts';
import { reviewDefaultAgentPermission } from './default-agent-permissions.ts';
import { rememberCrewChat } from './default-agent-tools.ts';
import { INTERRUPTED_MODEL_RESPONSE } from './hosted-agent-stream.ts';
import { crewCallHistory, recordCrewCall, forgetCrewCalls } from './agent-crew-history.ts';

const log = logger('opencode-agent');
const DATA_REQUEST = { throwOnError: true as const };

// The pinned native binary emits this recovery event; the legacy SDK's Event
// union omits it. Keep the extension at the native protocol boundary.
type ContextOverflowEvent = { type: 'session.error'; properties: { sessionID?: string; error: ContextOverflowError } };

/** Keep OpenCode's provider-specific tool vocabulary behind the adapter.
 * The renderer, history replay, and permission cards all consume the same
 * stable names already used by the Shared Agent Contract. */
function normalizeOpenCodeToolName(name: string): string {
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

function send(ws: WebSocket, event: AgentServerEvent, cause?: unknown): void {
  reportAgentRuntimeError('stashbase', event, ws, cause);
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

/** SDK error envelopes are authored explicitly; never include request bodies. */
function providerErrorDiagnostic(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error;
  const record = error as { name?: unknown; data?: Record<string, unknown> };
  const data = record.data ?? {};
  const headers = data.responseHeaders as Record<string, unknown> | undefined;
  return { name: record.name, code: record.name, message: data.message,
    status: data.statusCode, response_body: data.responseBody,
    request_id: headers?.['x-request-id'] ?? headers?.['request-id'] ?? headers?.['x-amzn-requestid'] };
}

function nativeErrorMessage(error: Extract<Event, { type: 'session.error' }>['properties']['error'] | ContextOverflowError): string {
  if (!error) return 'The agent turn failed.';
  if ('data' in error && error.data && typeof error.data === 'object') {
    const data = error.data as { message?: unknown; responseBody?: unknown };
    if (typeof data.message === 'string' && data.message) {
      // OpenCode serializes SSE error objects into UnknownError prose. Decode
      // only our terminal envelope; all other provider messages stay intact.
      try {
        if (JSON.parse(data.message)?.code === INTERRUPTED_MODEL_RESPONSE.code) return INTERRUPTED_MODEL_RESPONSE.message;
      } catch { /* ordinary provider prose */ }
      return data.message;
    }
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
  private stopping = false;
  private lastFinishReason: string | undefined;
  private completion: Record<string, string | number> = {};
  private turnNumber = 0;
  private readonly messageTurns = new Map<string, number>();
  private readonly content = new Map<string, { text: string; type: 'text' | 'reasoning'; messageID: string }>();
  private readonly tools = new Map<string, ToolPart['state']['status']>();
  private readonly toolNames = new Map<string, string>();
  private readonly toolInputs = new Map<string, Record<string, unknown>>();
  private readonly diffs = new Set<string>();
  private diffCounter = 0;
  private readonly errors = new Set<string>();
  private pendingContextOverflow: string | undefined;
  private readonly retryNotices = new Set<string>();
  /** OpenCode streams the reader's own prompt as parts too; only its role,
   * announced on the message before its parts, tells them from the reply. */
  private readonly userMessages = new Set<string>();

  bindSession(id: string): void { this.sessionId = id; }
  beginTurn(): AgentServerEvent[] {
    if (this.turnActive) return [];
    this.turnActive = true;
    this.stopping = false;
    this.turnNumber++;
    this.nativeTurnStarted = false;
    this.lastFinishReason = undefined;
    this.pendingContextOverflow = undefined;
    this.completion = {};
    this.diffs.clear();
    this.retryNotices.clear();
    return [{ t: 'turn-start' }];
  }
  isTurnActive(): boolean { return this.turnActive; }
  diagnostic(cause?: unknown): unknown {
    return { name: 'OpenCodeTurn', code: 'OPENCODE_TURN_FAILURE',
      message: `Native model completion: ${JSON.stringify(this.completion)}`, cause };
  }
  private recordCompletion(messageId: string, finish: string, tokens: { input: number; output: number; reasoning: number }): void {
    this.lastFinishReason = finish;
    this.completion = { message_id: messageId, finish_reason: finish,
      input_tokens: tokens.input, output_tokens: tokens.output, reasoning_tokens: tokens.reasoning };
  }
  endTurnWithError(): AgentServerEvent[] { return this.finishTurn(true); }
  requestInterrupt(): void { this.stopping = true; }
  endTurnAfterInterrupt(): AgentServerEvent[] { return this.finishTurn(false, true); }

  translate(event: Event | EventPermissionAsked | EventMessagePartDelta | ContextOverflowEvent): AgentServerEvent[] {
    switch (event.type) {
      case 'session.status': {
        if (!this.matches(event.properties.sessionID)) return [];
        if (event.properties.status.type === 'busy') {
          const events = this.beginTurn();
          this.nativeTurnStarted = true;
          return events;
        }
        if (event.properties.status.type === 'retry') {
          const message = event.properties.status.message;
          if (this.retryNotices.has(message)) return [];
          this.retryNotices.add(message);
          return [{ t: 'notice', message }];
        }
        return this.finishTurn(false);
      }
      case 'session.idle':
        return this.matches(event.properties.sessionID) ? this.finishTurn(false) : [];
      case 'session.error': {
        if (event.properties.sessionID && !this.matches(event.properties.sessionID)) return [];
        if (this.stopping && event.properties.error?.name === 'MessageAbortedError') return [];
        const message = nativeErrorMessage(event.properties.error);
        // OpenCode emits this before attempting compaction. It is terminal
        // only if native idle arrives without a successful continuation, or a
        // message records a final error (including a failed summary).
        if (event.properties.error?.name === 'ContextOverflowError' && this.turnActive && this.nativeTurnStarted) {
          const first = this.pendingContextOverflow === undefined;
          this.pendingContextOverflow = message;
          return first ? [{ t: 'notice', message: 'The model context limit was reached. The agent is trying to compact the conversation.' }] : [];
        }
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
        if (info.finish) this.recordCompletion(info.id, info.finish, info.tokens);
        if (!info.summary && !info.error && info.finish && !['unknown', 'error'].includes(info.finish)) {
          this.pendingContextOverflow = undefined;
        }
        if (!info.error) return [];
        if (this.stopping && info.error.name === 'MessageAbortedError') return [];
        const message = nativeErrorMessage(info.error);
        if (this.errors.has(message)) return [];
        this.errors.add(message);
        return [agentTurnErrorEvent(message)];
      }
      case 'message.part.updated':
        return this.part(event.properties.part, event.properties.delta);
      case 'message.part.delta': {
        const { sessionID, messageID, partID, field, delta } = event.properties;
        if (!this.matches(sessionID) || !this.turnActive || field !== 'text'
            || this.userMessages.has(messageID) || this.messageTurns.get(messageID) !== this.turnNumber) return [];
        const part = this.content.get(partID);
        if (!part || part.messageID !== messageID || !delta) return [];
        part.text += delta;
        return [{ t: part.type === 'text' ? 'text' : 'thinking', delta }];
      }
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
    // Native idle can arrive before the abort RPC confirms cancellation.
    if (this.stopping && !isError && !interrupted) return [];
    // `session.status: idle` and `session.idle` can straddle the next prompt.
    // Its optimistic start is not evidence that the native runtime started it.
    if (!isError && !interrupted && !this.nativeTurnStarted) return [];
    const events: AgentServerEvent[] = [];
    if (!interrupted && this.pendingContextOverflow && !this.errors.size) {
      events.push(agentTurnErrorEvent(this.pendingContextOverflow));
      isError = true;
    }
    this.pendingContextOverflow = undefined;
    if (!isError && !interrupted && this.lastFinishReason === 'unknown' && !this.errors.size) {
      events.push(agentTurnErrorEvent('The agent model stopped without a complete response. The task may be incomplete; completed file changes have been kept.'));
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
    if (part.type === 'step-finish' && this.turnActive) this.recordCompletion(part.messageID, part.reason, part.tokens);
    if (part.type === 'text' || part.type === 'reasoning') {
      const previous = this.content.get(part.id)?.text ?? '';
      const next = part.text;
      const addition = delta ?? (next.startsWith(previous) ? next.slice(previous.length) : next);
      this.content.set(part.id, { text: next, type: part.type, messageID: part.messageID });
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
      if (!(this.stopping && part.state.status === 'error' && part.state.error === 'Tool execution aborted')) events.push({
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
  readonly attributionId: string;
  readonly windowId: string;
  private readonly runtime: OpenCodeSessionRuntime;
  private sessionId: string | null = null;
  private client: Awaited<ReturnType<typeof openCodeClient>> | null = null;
  private disposed = false;
  private interrupted = false;
  private access: AgentAccessMode;
  private permissionReview = new AbortController();
  private userRequest = '';
  private readonly pendingPermissions = new Set<string>();
  private readonly seenPermissions = new Set<string>();
  private readonly waitingToolPermissions = new Map<string, Extract<AgentServerEvent, { t: 'permission' }>>();
  private readonly stopRuntimeExitListener: () => void;
  private readonly onMessage = (data: RawData) => { void this.handleMessage(data); };
  private readonly onClose = () => this.dispose();
  private preparingAttachments: AbortController | null = null;
  private attachmentPreparation: Promise<FilePartInput[]> | null = null;
  /** The main agent's profile, as the service listed it when this session
   * started; undefined runs the unversioned default. Roles carry their own
   * profiles in the runtime's configuration. */
  private model: { profile: string; version: number } | undefined;

  constructor(
    private readonly ws: WebSocket,
    private readonly options: AgentConnectionOptions,
    runtime?: OpenCodeSessionRuntime,
  ) {
    const binding = runWithWindowId(options.windowId, () => resolveSessionBinding({
      folder: options.folder,
      currentFolder: getCurrentFolder(),
    }));
    this.cwd = binding.cwd;
    this.access = options.access === 'auto' || options.access === 'acceptEdits' || options.access === 'plan'
      ? options.access : 'default';
    this.windowId = normalizeWindowId(options.windowId);
    this.runtime = runtime ?? createOpenCodeSessionRuntime({
      windowId: this.windowId,
      directory: this.cwd,
      persona: options.persona,
      ...(options.crew || options.resume ? { crew: options.crew ?? options.resume! } : {}),
    });
    this.attributionId = this.runtime.attributionId ?? randomUUID();
    this.stopRuntimeExitListener = this.runtime.onExit((error) => {
      if (!this.disposed) this.fail(error, true);
    });
    registerAttributedAgentSession(this.attributionId, this);
    ws.on('message', this.onMessage);
    ws.on('close', this.onClose);
    void this.initialize();
  }

  boundFolder(): string | null { return this.cwd; }
  diagnosticContext() { return agentWriteDiagnosticContext(this.ws); }

  turnInFlight(): boolean { return this.translator.isTurnActive(); }

  /** Runs an enabled tool for the main agent, inside its running turn: one
   * call on the tool's model, on the turn's catalog snapshot. */
  async runTool(id: string, task: string | (() => Promise<string>), signal?: AbortSignal): Promise<AgentToolResult> {
    if (!this.turnInFlight()) throw Object.assign(new Error('Tools run only inside an agent turn.'), { status: 409 });
    return this.runtime.runTool(id, task, signal);
  }

  dispose(termination?: AgentSessionTermination): void {
    if (this.disposed) return;
    markAgentDiagnosticClosing(this.ws, termination?.kind === 'scope-removed' ? 'scope_removed' : 'session_disposed');
    if (termination) send(this.ws, { t: 'exit', reason: termination.kind, folder: termination.folder });
    this.disposed = true;
    this.pendingPermissions.clear();
    this.seenPermissions.clear();
    this.waitingToolPermissions.clear();
    this.preparingAttachments?.abort();
    this.permissionReview.abort();
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
    void this.runtime.close(termination?.kind === 'scope-removed' ? 'scope_removed' : 'session_closed')
      .catch((error: unknown) => log.warn('Could not close the agent session runtime.', error));
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(AGENT_SESSION_CLOSE.code, AGENT_SESSION_CLOSE.reason);
  }

  private async initialize(): Promise<void> {
    const started = performance.now();
    try {
      // Without a readable list the chat still runs, on the default profile
      // the service picks for an unversioned request.
      const profiles = await this.runtime.models().catch((error: unknown) => {
        log.warn(`could not read the agent model list: ${errorMessage(error)}`);
        return [];
      });
      const main = defaultHostedAgentProfile(profiles);
      if (main) this.model = { profile: main.id, version: main.version };
      if (this.disposed) return;
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
      if (this.options.crew) rememberCrewChat(this.options.crew, native.id);
      this.translator.bindSession(native.id);
      send(this.ws, { t: 'session-id', id: native.id });
      if (native.title) send(this.ws, { t: 'session-title', title: native.title });
      // The main agent always runs on the service's default; the reader
      // chooses each member's model in the Crew menu.
      send(this.ws, main
        ? { t: 'models', models: hostedAgentCatalogModels([main]), activeModel: main.id }
        : { t: 'models', models: [] });
      send(this.ws, { t: 'skills', skills: [], state: 'empty' });
      log.debug('session ready', { session_id: this.attributionId, elapsed_ms: Math.round(performance.now() - started) });
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
          const nativeError = event.type === 'session.error' ? event.properties.error
            : event.type === 'message.updated' && event.properties.info.role === 'assistant' ? event.properties.info.error : undefined;
          const cause = item.t === 'error' ? this.translator.diagnostic(this.runtime.diagnostic?.()) : undefined;
          if (item.t === 'tool' && this.sessionId) {
            const selected = this.runtime.tools().find(({ tool }) => item.name === `stashbase_${tool.agent.toolName}` || item.name === tool.agent.toolName);
            if (selected) {
              item.crew = { id: selected.tool.id, label: selected.tool.name, icon: selected.tool.icon, model: selected.model.name };
              recordCrewCall(this.sessionId, item.id, item.crew);
            }
          }
          send(this.ws, item, nativeError
            ? { ...providerErrorDiagnostic(nativeError) as object, cause }
            : cause);
          if (item.t === 'tool') {
            for (const permission of this.waitingToolPermissions.values()) {
              if (permission.toolUseId !== item.id) continue;
              this.waitingToolPermissions.delete(permission.id);
              await this.handlePermission({ ...permission, input: item.input });
            }
          }
        }
        if (translated.some((item) => item.t === 'turn-end')) {
          this.permissionReview.abort();
          this.pendingPermissions.clear();
          this.seenPermissions.clear();
          this.waitingToolPermissions.clear();
          this.runtime.endTurn();
        }
      }
      // EOF is terminal even when the transport does not throw. Otherwise a
      // running turn keeps its tools and panel alive without any more events.
      if (!this.disposed && !this.abort.signal.aborted) {
        throw Object.assign(new Error('The agent event stream ended. Reconnect to continue this chat.'), {
          code: 'AGENT_EVENT_STREAM_CLOSED',
        });
      }
    } catch (error) {
      if (!this.abort.signal.aborted) this.fail(error, true);
    }
  }

  private async handleMessage(raw: RawData): Promise<void> {
    let event: AgentClientEvent;
    try {
      const parsed = agentClientEventSchema.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success) {
        send(this.ws, agentTurnErrorEvent('Invalid agent request. Review the message and its attachments.'));
        return;
      }
      event = parsed.data;
    } catch { return; }
    if (event.t === 'close') { this.dispose(); return; }
    if (event.t === 'set-model') return;
    if (event.t === 'set-mode') {
      if (!this.turnInFlight() && (event.mode === 'default' || event.mode === 'acceptEdits' || event.mode === 'plan' || event.mode === 'auto')) {
        this.access = event.mode;
      }
      return;
    }
    if (!this.client || !this.sessionId) return;
    let preparationSignal: AbortSignal | undefined;
    try {
      switch (event.t) {
        case 'prompt': {
          if (this.turnInFlight()) return;
          this.permissionReview.abort();
          this.permissionReview = new AbortController();
          this.userRequest = restoreHistoryAttachments(event.text).text;
          this.interrupted = false;
          const modelID = this.model?.profile ?? DEFAULT_HOSTED_AGENT_PROFILE;
          beginAgentDiagnosticTurn(this.ws, event.telemetryTurnId, { model: modelID, native_session_id: this.sessionId });
          this.runtime.beginTurn(event.telemetryTurnId ?? randomUUID(), this.model);
          for (const translated of this.translator.beginTurn()) send(this.ws, translated);
          if (event.titleHint) {
            void this.client.session.update({
              ...DATA_REQUEST,
              path: { id: this.sessionId },
              body: { title: event.titleHint },
            }).catch(() => {});
          }
          const preparation = new AbortController();
          this.preparingAttachments = preparation;
          preparationSignal = preparation.signal;
          let attachments;
          try {
            this.attachmentPreparation = prepareAgentAttachments(event.attachments ?? [], this.cwd, preparation.signal);
            attachments = await this.attachmentPreparation;
          } finally {
            if (this.preparingAttachments === preparation) {
              this.preparingAttachments = null;
              this.attachmentPreparation = null;
            }
          }
          if (this.disposed || this.interrupted || preparation.signal.aborted) return;
          agentDiagnosticStage(this.ws, 'runtime_dispatched');
          await this.client.session.promptAsync({
            ...DATA_REQUEST,
            path: { id: this.sessionId },
            body: {
              model: { providerID: 'stashbase', modelID },
              agent: this.access === 'plan' ? 'stashbase-plan'
                : this.access === 'acceptEdits' || this.access === 'auto' ? 'stashbase-edit' : 'stashbase-folder',
              parts: [{ type: 'text', text: event.text }, ...attachments],
            },
          });
          break;
        }
        case 'interrupt':
          this.permissionReview.abort();
          this.preparingAttachments?.abort();
          this.interrupted = true;
          this.translator.requestInterrupt();
          this.pendingPermissions.clear();
          this.waitingToolPermissions.clear();
          if (this.attachmentPreparation) await this.attachmentPreparation.catch(() => undefined);
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
      if (!this.disposed && !(event.t === 'prompt' && (this.interrupted || preparationSignal?.aborted))) this.fail(error, false);
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
    if ((this.access === 'acceptEdits' || this.access === 'auto') && projectEdit) {
      await this.replyPermission(item.id, true);
      return;
    }
    if (this.access === 'auto') {
      const review = this.permissionReview;
      const allowed = await reviewDefaultAgentPermission({
        name: item.name, input: item.input, project: this.cwd, userRequest: this.userRequest,
      }, (messages, signal) => this.runtime.complete(this.model ?? { profile: DEFAULT_HOSTED_AGENT_PROFILE }, messages, signal), review.signal);
      if (review.signal.aborted || this.permissionReview !== review || this.disposed || !this.turnInFlight()) return;
      if (allowed) {
        await this.replyPermission(item.id, true);
        return;
      }
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
    if (this.disposed) return;
    this.permissionReview.abort();
    this.pendingPermissions.clear();
    this.seenPermissions.clear();
    this.waitingToolPermissions.clear();
    const message = errorMessage(error);
    reportAgentRuntimeError('stashbase', agentTurnErrorEvent(message), this.ws, error);
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(agentTurnErrorEvent(message)));
    this.runtime.endTurn();
    if (terminal) {
      send(this.ws, agentSessionExitEvent(message));
      this.dispose();
    } else {
      for (const event of this.translator.endTurnWithError()) send(this.ws, event);
    }
  }
}

const sessions = liveSessionSet<OpenCodePanelSession>();

/** The live Default chat a tool call is attributed to, if any. */
export function openCodeToolSession(attributionId: string | undefined): OpenCodePanelSession | null {
  const session = attributedAgentSession(attributionId);
  return session instanceof OpenCodePanelSession ? session : null;
}

export function attachOpenCodeWebSocket(ws: WebSocket, options: AgentConnectionOptions): void {
  sessions.add(new OpenCodePanelSession(ws, options));
}

export function killActiveOpenCode(windowId?: string): void {
  sessions.killWindow(windowId);
  void discardWarmOpenCodeForWindow(windowId)
    .catch((error: unknown) => log.warn('Could not retire the window\'s spare agent runtime.', error));
}

export function killOpenCodeSessionsForFolder(folder: string): void {
  sessions.killFolder(folder);
  void discardWarmOpenCodeForFolder(folder)
    .catch((error: unknown) => log.warn('Could not retire the project\'s spare agent runtime.', error));
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
    const restored = restoreHistoryAttachments(textOf(parts.filter((part) => part.type !== 'text' || !part.synthetic), 'text'));
    for (const part of parts) {
      if (part.type !== 'file' || part.source?.type !== 'file') continue;
      const reference = part.source.path;
      if (!isTransientAttachmentPath(reference) || restored.attachments.some(item => item.path === reference)) continue;
      restored.attachments.push(historyImageAttachment(reference) ?? { path: reference, name: part.filename ?? reference.split(/[\\/]/).at(-1)! });
    }
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
      status: part.state.status === 'error'
        ? info.error?.name === 'MessageAbortedError' && part.state.error === 'Tool execution aborted' ? 'cancelled' : 'error'
        : 'done',
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
  const crew = crewCallHistory(id);
  return [
    ...messages.data.flatMap((message) => blocksForMessage(message.info, message.parts))
      .map((block) => block.kind === 'tool' && crew[block.id] ? { ...block, crew: crew[block.id] } : block),
    ...blocksForDiffs(diffs.data),
  ];
}

async function clientFor(folder: string, retryStartup = false) {
  if (!folder) throw new Error('Open a project before reading chat history.');
  const cwd = folder;
  return { client: await openCodeClient(cwd, retryStartup), cwd };
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
      const { client, cwd } = await clientFor(folder, true);
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
      forgetCrewCalls(id);
    },
  };
}
