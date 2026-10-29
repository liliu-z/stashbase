import { AGENT_SESSION_CLOSE } from '../shared/agent-protocol.ts';
import { setAgentProcessSnapshot, updateAgentDiagnosticContext, markAgentDiagnosticClosing, agentDiagnosticStage, beginAgentDiagnosticTurn, reportAgentRuntimeError } from './error-reporting.ts';
import { isStashbaseWorkspaceEdit, isWorkspaceFileChange } from './agent-file-permissions.ts';
import { retireAgentProcess } from './agent-process.ts';
/**
 * Live Codex WebSocket session runtime.
 *
 * One instance owns one app-server process, one persistent thread, turn
 * lifecycle, JSON-RPC correlation, and renderer event normalization.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { resolveAgentRuntimeInstructions } from './agent-runtime-instructions.ts';
import {
  consumeAgentTurnFailure,
  simulatedTurnFailureScript,
  type AgentTurnFailureSimulation,
} from './agent-runtime-paths.ts';
import { agentSessionExitEvent, agentTurnErrorEvent } from './agent-turn-failure.ts';
import { agentBootstrapCoordinator } from './agent-runtime-installer.ts';
import {
  isAgentAccessMode,
  resolveSessionBinding,
  type AgentAccessMode,
  type AgentConnectionOptions,
  type AgentModel,
  type AgentSkill,
  type AgentClientEvent,
  type AgentServerEvent,
  type AgentSessionTermination,
} from './agent-contract.ts';
import {
  approvalTitle,
  codexAccessOptions,
  codexTurnAccessOptions,
  commandCanRemember,
  commandApprovalInput,
  fileChangeApprovalInput,
  mcpToolApprovalFromElicitation,
  mcpApprovalScopes,
  notificationMessage,
  protocolNoticeFromParams,
  requestedPermissions,
  usefulMessage,
} from './codex-approval.ts';
import { rememberAgentDefaultModel, rememberAgentModels } from './agent-model-catalog.ts';
import { spawnCodexAppServerProcess } from './codex-app-server-process.ts';
import { loadCodexModelCatalog } from './codex-model-catalog.ts';
import {
  codexTurnStatus,
  stringValue,
  toolResultFromItem,
  toolStartFromItem,
  type JsonObject,
  type JsonRpcId,
  type ThreadItem,
} from './codex-protocol.ts';
import {
  connectCodexAppServer,
  CodexRpcRequestTimeoutError,
  CODEX_RPC_REQUEST_TIMEOUT_MS,
  type CodexAppServerConnection,
} from './codex-rpc-transport.ts';
import {
  liveSessionSet,
  registerAttributedAgentSession,
  unregisterAttributedAgentSession,
  type AttributedAgentSession,
} from './agent-session-registry.ts';
import { getCurrentFolder, normalizeWindowId, runWithWindowId } from './folder.ts';
import { errorMessage, logger } from './log.ts';

const log = logger('codex-agent');

interface PendingApproval {
  requestId: JsonRpcId;
  method: string;
  params?: JsonObject;
}

class CodexTurnCancelledError extends Error {
  constructor() {
    super('Codex turn cancelled.');
  }
}

export class CodexSession implements AttributedAgentSession {
  private closed = false;
  private ready = false;
  private appServerReady = false;
  private processGeneration = 0;
  private retirement: Promise<void> = Promise.resolve();
  private proc: ChildProcessWithoutNullStreams | null = null;
  private cwd: string | null = null;
  /** The library persona this Chat runs under, read when its thread starts. */
  persona: string | undefined;
  private threadId: string | null = null;
  private threadAccessMode: AgentAccessMode | undefined;
  private workspaceSandboxPolicy: JsonObject | undefined;
  private resumeThreadId: string | null = null;
  private activeTurnId: string | null = null;
  // An app-server can report a terminal notification in the same stdout
  // batch as its turn/start response. Keep it until that response gives us
  // the authoritative turn id, rather than dropping a matching failure.
  private pendingTerminalError: JsonObject | null = null;
  private busy = false;
  private interruptRequested = false;
  private interruptingTurnId: string | null = null;
  /** Follow-ups Codex accepted into the running turn, by the client message id
   *  it records them under, until it reads one at the turn's next step. */
  private steers = new Map<string, string>();
  /** Follow-ups that arrived while the turn was still starting; they go to
   *  Codex once it names the turn and shows how it records input. */
  private earlySteers: Array<{ id: string; prompt: string }> = [];
  /** The client id the running turn's own prompt was sent with, until Codex
   *  records that prompt. */
  private turnMessageId: string | null = null;
  /** Whether this app-server records input under the client id sent with it,
   *  as a turn's own prompt shows; undefined until one does. One that does
   *  not never names the follow-up it reads, so accepting it confirms it. */
  private recordsClientIds: boolean | undefined;
  private appServer: CodexAppServerConnection | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  /** The native catalog is resolved once. `selectedModel` may then change
   * only through an explicit idle `set-model` event; a catalog refresh or
   * runtime notification can never silently change the next turn. */
  private modelResolved = false;
  /** Explicit override for the next turn. Never derive this from the model
   * the runtime reports for a resumed/default session. */
  private selectedModel: string | undefined;
  /** A pick made while the catalog was still being read, applied by
   * `resolveModel` the way it applies the choice the URL carried. */
  private heldModel: string | null | undefined;
  private activeModel: string | undefined;
  private models: AgentModel[] = [];
  /** Native metadata gaps belong to this process generation. A later refusal
   * of the same model can offer the updater without treating every account
   * rejection (or every advisory warning) as a version problem. */
  private modelsWithoutMetadata = new Set<string>();
  private skills = new Map<string, { name: string; path: string }>();
  private skillSequence = 0;
  readonly windowId: string;
  readonly agentId = 'codex' as const;
  /** Private per-session attribution id. Rides the app-server env
   * (`STASHBASE_AGENT_SESSION_ID`) → stdio MCP host → request header, so
   * host-side MCP tools can find the live calling session. */
  readonly attributionId = randomUUID();

  private activeCwd(): string | null {
    return this.cwd;
  }

  /** The project pinned at startup, or its explicit connection-time folder. */
  boundFolder(): string | null {
    return this.cwd ?? this.folder ?? null;
  }

  turnInFlight(): boolean {
    return this.busy;
  }

  constructor(
    private ws: WebSocket,
    windowId: string,
    private effort?: string,
    resume?: string,
    private accessMode?: AgentAccessMode,
    private model?: string,
    /** Explicit, membership-validated session folder. Undefined with no
     *  follows the window folder before startup. */
    private folder?: string,
    private onDispose?: (session: CodexSession) => void,
    private spawnProcess: typeof spawnCodexAppServerProcess = spawnCodexAppServerProcess,
    private requestTimeoutMs: number = CODEX_RPC_REQUEST_TIMEOUT_MS,
  ) {
    this.windowId = normalizeWindowId(windowId);
    this.resumeThreadId = typeof resume === 'string' && resume.trim() ? resume.trim() : null;
    registerAttributedAgentSession(this.attributionId, this);
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
  }

  begin(): void {
    runWithWindowId(this.windowId, () => { void this.start(); });
  }

  private async start(): Promise<void> {
    if (this.closed) return;
    let cwd: string;
    try { cwd = resolveSessionBinding({ folder: this.folder, currentFolder: getCurrentFolder() }).cwd; }
    catch (error) { this.finish(errorMessage(error), error); return; }
    this.cwd = cwd;
    // Model choice belongs to the first turn, so publish the native catalog
    // before the renderer enables its composer. Otherwise a fresh Codex chat
    // cannot select a model for that first turn.
    try {
      await this.ensureAppServer();
      if (this.closed) return;
      await this.resolveModel();
      if (this.closed) return;
      await this.publishSkills();
      if (this.closed) return;
      // Loading a historic thread is what lets the native app-server return
      // its persisted model metadata before the panel becomes interactive.
      if (this.resumeThreadId) await this.ensureThread();
      if (this.closed) return;
      this.ready = true;
      this.send({ t: 'ready' });
    } catch (err: unknown) {
      this.finish(errorMessage(err), err);
    }
  }

  private async ensureAppServer(): Promise<void> {
    await this.retirement;
    if (this.closed) throw new Error('Codex session closed.');
    if (this.appServerReady) return;
    if (!this.cwd) throw new Error('No folder open.');
    const appServer = this.spawnAppServer(this.cwd);
    try {
      await appServer.initialize();
      this.appServerReady = true;
    } catch (err: unknown) {
      this.disposeAppServer();
      throw err;
    }
  }

  private spawnAppServer(cwd: string): CodexAppServerConnection {
    this.modelsWithoutMetadata.clear();
    // An update can replace the executable between generations.
    this.recordsClientIds = undefined;
    const processStartId = randomUUID();
    const proc = this.spawnProcess(cwd, {
      STASHBASE_WINDOW_ID: this.windowId,
      // Session identity for host-side MCP tools (create_project): request
      // attribution only, never a path-resolution channel.
      STASHBASE_AGENT_SESSION_ID: this.attributionId,
    }, { purpose: 'chat', processStartId });
    this.proc = proc;
    updateAgentDiagnosticContext(this.ws, { process_start_id: processStartId, process_generation: ++this.processGeneration,
      pending_rpc_methods: [], close_reason: undefined, close_initiator: undefined });
    const appServer = connectCodexAppServer(proc, {
      requestTimeoutMs: this.requestTimeoutMs,
      onRequest: ({ id, method, params }) => this.onServerRequest({ id, method, params }),
      onNotification: (method, params) => this.onNotification(method, params),
      onExit: (error) => {
        // A retired generation's exit belongs to nobody once a newer one exists.
        if (this.appServer !== appServer) return;
        this.appServer = null;
        this.proc = null;
        if (!this.closed) {
          updateAgentDiagnosticContext(this.ws, { pending_rpc_methods: appServer.pendingMethods(), close_initiator: 'server', close_reason: 'process_exit' });
          this.handleAppServerExit(error);
        }
      },
    });
    this.appServer = appServer;
    setAgentProcessSnapshot(this.ws, () => this.appServer ? { pending_rpc_methods: this.appServer.pendingMethods() } : {});
    return appServer;
  }

  private onMessage(text: string): void {
    let msg: AgentClientEvent;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg.t) {
      case 'prompt': {
        const body = typeof msg.text === 'string' ? msg.text : '';
        const titleHint = typeof msg.titleHint === 'string' ? msg.titleHint : '';
        const skill = typeof msg.skill === 'string' ? msg.skill : undefined;
        if (!body.trim() && !skill) return;
        if (!this.busy) beginAgentDiagnosticTurn(this.ws, msg.telemetryTurnId, { ...(this.activeModel ? { model: this.activeModel } : {}), ...(this.threadId ? { native_session_id: this.threadId } : {}) });
        void this.runTurn(body, titleHint, skill);
        break;
      }
      case 'refresh-skills': void this.publishSkills(true); break;
      case 'steer': {
        const id = typeof msg.id === 'string' ? msg.id : '';
        const body = typeof msg.text === 'string' ? msg.text : '';
        if (!id || !body.trim()) return;
        void this.steerTurn(id, body);
        break;
      }
      case 'permission-reply':
        this.onPermissionReply(msg);
        break;
      case 'interrupt':
        void this.interrupt();
        break;
      case 'close':
        this.dispose();
        break;
      case 'set-model':
        this.setModelForNextTurn(msg.model);
        break;
      case 'set-mode':
        if (!this.busy && isAgentAccessMode(msg.mode)) this.accessMode = msg.mode;
        break;
    }
  }

  /** Codex accepts a follow-up at once but reads it only at the turn's next
   *  step, when it records the user message under our id; that, not the
   *  acceptance, is when the renderer places it. An app-server that drops
   *  our ids is confirmed on acceptance instead, never sent twice. */
  private async steerTurn(clientId: string, prompt: string): Promise<void> {
    if (!this.busy) {
      this.send({ t: 'steer-result', id: clientId, ok: false, message: 'Codex is not ready to steer this turn.' });
      return;
    }
    if (!this.threadId || !this.activeTurnId || this.recordsClientIds === undefined) {
      this.earlySteers.push({ id: clientId, prompt });
      return;
    }
    const messageId = randomUUID();
    this.steers.set(messageId, clientId);
    try {
      await this.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.activeTurnId,
        clientUserMessageId: messageId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      });
      if (!this.recordsClientIds && this.steers.delete(messageId)) {
        this.send({ t: 'steer-result', id: clientId, ok: true });
      }
    } catch (err: unknown) {
      // A request that timed out may still have reached the turn; Codex's
      // record of it, or the turn's end, decides.
      if (err instanceof CodexRpcRequestTimeoutError) return;
      if (this.steers.delete(messageId)) {
        this.send({ t: 'steer-result', id: clientId, ok: false, message: errorMessage(err) });
      }
    }
  }

  /** Sends follow-ups held while the turn started; `steerTurn` holds them
   *  again until Codex has named the turn and recorded its prompt. */
  private flushEarlySteers(): void {
    if (this.interruptRequested) return;
    for (const steer of this.earlySteers.splice(0)) void this.steerTurn(steer.id, steer.prompt);
  }

  /** Codex drops a follow-up the turn ended or was stopped without reading,
   *  and one held while the turn started never reached it, so the renderer
   *  sends each next instead. */
  private returnSteers(): void {
    const message = 'Codex did not read this before the turn ended.';
    for (const id of [...this.steers.values(), ...this.earlySteers.map((steer) => steer.id)]) {
      this.send({ t: 'steer-result', id, ok: false, message });
    }
    this.steers.clear();
    this.earlySteers = [];
  }

  private async runTurn(prompt: string, titleHint = '', skillId?: string): Promise<void> {
    if (this.closed) return;
    if (!this.ready || !this.cwd) {
      this.send({ t: 'error', message: 'Codex is not ready yet.' });
      return;
    }
    if (this.busy) {
      this.send({ t: 'error', message: 'Codex is already working on a turn.' });
      return;
    }
    {
      const simulated = consumeAgentTurnFailure();
      if (simulated) { this.playSimulatedTurnFailure(simulated); return; }
    }

    this.busy = true;
    this.pendingTerminalError = null;
    this.interruptRequested = false;
    this.interruptingTurnId = null;
    this.send({ t: 'turn-start' });
    try {
      const skill = skillId ? this.skills.get(skillId) : undefined;
      if (skillId && !skill) throw new Error('That skill is no longer available. Type / to choose another.');
      const model = await this.resolveModel();
      this.throwIfInterruptedBeforeTurn();
      const threadId = await this.ensureThread(titleHint);
      this.throwIfInterruptedBeforeTurn();
      agentDiagnosticStage(this.ws, 'runtime_dispatched');
      // How Codex records this id shows how a follow-up can be confirmed.
      const turnMessageId = randomUUID();
      this.turnMessageId = turnMessageId;
      const accessMode = this.accessMode;
      const result = await this.request('turn/start', {
        threadId,
        clientUserMessageId: turnMessageId,
        cwd: this.activeCwd(),
        ...codexTurnAccessOptions(accessMode, this.cwd, this.threadAccessMode, this.workspaceSandboxPolicy),
        ...codexEffortOption(this.effort),
        ...(model ? { model } : {}),
        input: [{ type: 'text', text: skill ? `$${skill.name}${prompt ? ` ${prompt}` : ''}` : prompt, text_elements: [] }, ...(skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : [])],
      }) as JsonObject;
      this.threadAccessMode = accessMode;
      if (model && this.selectedModel === model) {
        this.activeModel = model;
        this.send({ t: 'models', models: this.models, activeModel: model });
      }
      const turn = result.turn as JsonObject | undefined;
      const id = stringValue(turn?.id);
      if (this.busy && id) {
        this.activeTurnId = id;
        if (this.interruptRequested) void this.requestInterruptForTurn(id);
        this.flushEarlySteers();
        const pendingError = this.takePendingTerminalError();
        if (pendingError && stringValue(pendingError.turnId) === id) this.onErrorNotification(pendingError);
      }
    } catch (err: unknown) {
      if (err instanceof CodexRpcRequestTimeoutError && err.method === 'turn/start') {
        this.fenceTimedOutTurnStart();
      }
      this.busy = false;
      this.activeTurnId = null;
      this.turnMessageId = null;
      this.pendingTerminalError = null;
      if (!this.closed) {
        this.returnSteers();
        if (!(err instanceof CodexTurnCancelledError)) {
          this.sendTurnError(errorMessage(err), err);
        }
        this.send({ t: 'turn-end', isError: !(err instanceof CodexTurnCancelledError) });
      }
    }
  }

  /** Turn-scoped runtime errors carry their classified failure kind so the
   * renderer can offer the matching recovery without parsing the message. */
  private sendTurnError(message: string, cause?: unknown): void {
    const event = agentTurnErrorEvent(message);
    if (event.failure?.kind === 'auth-expired') agentBootstrapCoordinator.requireSignIn('codex', message);
    if (!event.failure && this.isModelCompatibilityFailure(message)) {
      event.failure = { kind: 'runtime-outdated' };
    }
    this.send(event, cause);
  }

  private isModelCompatibilityFailure(message: string): boolean {
    const model = /The '([^'\r\n]+)' model is not supported when using Codex with a ChatGPT account\./i.exec(message)?.[1];
    return !!model && this.modelsWithoutMetadata.has(model);
  }

  /** Development-only: play the armed turn-failure script through the normal
   * event path so the renderer exercises the real turn lifecycle. The prompt
   * never reaches the app-server. */
  private playSimulatedTurnFailure(kind: Exclude<AgentTurnFailureSimulation, 'none'>): void {
    const script = simulatedTurnFailureScript(kind);
    if (script.fatal) {
      this.finish(script.message);
      return;
    }
    this.busy = true;
    this.send({ t: 'turn-start' });
    this.busy = false;
    this.sendTurnError(script.message);
    this.send({ t: 'turn-end', isError: true });
  }

  /**
   * `turn/start` mutates native state, so a timeout leaves its outcome
   * ambiguous. Retire that entire transport generation before allowing
   * another prompt; otherwise its late lifecycle notifications can overlap
   * with and clear a newer turn. The next prompt resumes the same thread
   * through a fresh app-server generation.
   */
  private fenceTimedOutTurnStart(): void {
    const threadId = this.threadId;
    updateAgentDiagnosticContext(this.ws, { close_initiator: 'server', close_reason: 'rpc_timeout' });
    this.disposeAppServer();
    if (threadId) {
      this.threadId = null;
      this.resumeThreadId = threadId;
    }
  }

  /** `model/list` is the source of truth, including custom providers and
   * their supported effort order. Do not substitute a product-maintained list. */
  private async resolveModel(): Promise<string | undefined> {
    if (this.modelResolved) return this.selectedModel;
    try {
      this.models = await this.loadModelCatalog();
    } catch (err: unknown) {
      // Discovery is not permission to replace an explicit choice. The turn
      // request remains authoritative, including when the catalog is unavailable.
      log.debug(`could not discover Codex models: ${errorMessage(err)}`);
    }
    // History clears new-chat preferences in the renderer. A model carried
    // on a reconnect is the reader's current choice, including a pick that
    // has not run yet. A held null explicitly clears the URL's selection.
    const selected = this.heldModel !== undefined ? this.heldModel ?? undefined : this.model;
    this.heldModel = undefined;
    this.send({
      t: 'models',
      models: this.models,
      ...(this.activeModel ? { activeModel: this.activeModel } : {}),
    });
    this.selectedModel = selected;
    this.modelResolved = true;
    return selected;
  }

  /** Apply an explicit renderer choice to the next turn without replacing
   * the Codex thread. WebSocket ordering makes a following prompt observe
   * this assignment; the busy guard is the server-side backstop for the
   * renderer's disabled picker. Missing model means native Default. */
  private setModelForNextTurn(value: unknown): void {
    if (this.busy || (value !== undefined && typeof value !== 'string')) return;
    const requested = typeof value === 'string' && value ? value : undefined;
    // Keep a pick made during discovery ahead of the connection-time choice.
    // The native turn validates availability; the catalog only fills the picker.
    if (!this.modelResolved) {
      this.heldModel = requested ?? null;
      return;
    }
    this.selectedModel = requested;
  }

  /** One reading of the catalog, shared with the runtime-level read that
   * needs no thread (`codex-model-catalog.ts`). What this session reads is
   * remembered for the runtime listing, so the next fresh Chat names its
   * default at once. */
  private async loadModelCatalog(): Promise<AgentModel[]> {
    const models = await loadCodexModelCatalog((method, params) => this.request(method, params));
    rememberAgentModels('codex', models);
    return models;
  }

  private async publishSkills(forceReload = false): Promise<void> {
    if (this.closed) return;
    const cwd = this.activeCwd();
    if (!cwd) return;
    try {
      const result = await this.request('skills/list', { cwds: [cwd], ...(forceReload ? { forceReload: true } : {}) }) as JsonObject;
      if (this.closed) return;
      const entries = Array.isArray(result.data) ? result.data : [];
      const entry = entries.find((item) => stringValue((item as JsonObject).cwd) === cwd) as JsonObject | undefined;
      const raw = Array.isArray(entry?.skills) ? entry.skills : [];
      this.skills.clear();
      const skills: AgentSkill[] = [];
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const value = item as JsonObject;
        const name = stringValue(value.name), path = stringValue(value.path);
        if (!name || !path || value.enabled === false) continue;
        const id = `skill-${++this.skillSequence}`;
        this.skills.set(id, { name, path });
        skills.push({ id, label: stringValue(value.displayName) || name, ...(stringValue(value.shortDescription) || stringValue(value.description) ? { description: stringValue(value.shortDescription) || stringValue(value.description) } : {}) });
      }
      this.send({ t: 'skills', skills, state: skills.length ? 'available' : 'empty' });
    } catch (err) {
      if (this.closed) return;
      this.skills.clear();
      this.send({ t: 'skills', skills: [], state: 'failed', error: errorMessage(err) });
      log.warn('load Codex skills failed:', err);
    }
  }

  private async ensureThread(titleHint = ''): Promise<string> {
    if (this.threadId) return this.threadId;
    const cwd = this.activeCwd();
    if (!cwd) throw new Error('No folder open.');
    await this.ensureAppServer();
    const isNewThread = !this.resumeThreadId;
    const access = codexAccessOptions(this.accessMode);
    const common = {
      cwd,
      approvalPolicy: access.approvalPolicy,
      approvalsReviewer: access.approvalsReviewer,
      sandbox: access.sandbox,
      // Keep the chosen Persona distinct from StashBase's internal
      // project-routing policy even though Codex receives their composition
      // through one native developer-instructions field.
      developerInstructions: resolveAgentRuntimeInstructions(this.persona, cwd),
    };
    const result = await this.request(
      this.resumeThreadId ? 'thread/resume' : 'thread/start',
      this.resumeThreadId
        ? { ...common, threadId: this.resumeThreadId }
        : { ...common, threadSource: 'user' },
    ) as JsonObject;
    const thread = result.thread as JsonObject | undefined;
    const id = stringValue(thread?.id);
    if (!id) throw new Error('Codex app-server did not return a thread id.');
    const shouldSendSessionId = this.threadId !== id;
    this.threadId = id;
    this.threadAccessMode = this.accessMode;
    const sandbox = result.sandbox as JsonObject | undefined;
    this.workspaceSandboxPolicy = sandbox?.type === 'workspaceWrite' ? sandbox : undefined;
    // The model catalog's suggested default is not the effort this native
    // thread runs with. Publish the resumed/configured value before ready.
    this.effort ??= stringValue(result.reasoningEffort) || undefined;
    const activeModel = codexThreadModel(thread, result);
    if (activeModel) {
      this.activeModel = activeModel;
      // With nothing chosen, the thread's model is the runtime's own default.
      if (!this.selectedModel) rememberAgentDefaultModel('codex', activeModel);
      if (!this.models.some((entry) => entry.id === activeModel)) {
        this.models = [...this.models, { id: activeModel, label: activeModel }];
      }
      // The renderer keeps explicit selections ahead of this native identity.
      this.send({ t: 'models', models: this.models, activeModel, ...(this.effort ? { effort: this.effort } : {}) });
    }
    this.resumeThreadId = null;
    if (shouldSendSessionId) this.send({ t: 'session-id', id });
    if (isNewThread) {
      const title = titleFromPrompt(titleHint);
      if (title) {
        this.send({ t: 'session-title', title });
        await this.request('thread/name/set', { threadId: id, name: title })
          .catch((err: unknown) => log.warn(`Codex title set failed for ${id}:`, err));
      }
    }
    return id;
  }

  private async interrupt(): Promise<void> {
    if (!this.busy) return;
    this.interruptRequested = true;
    if (!this.threadId || !this.activeTurnId) return;
    await this.requestInterruptForTurn(this.activeTurnId);
  }

  private throwIfInterruptedBeforeTurn(): void {
    if (this.interruptRequested && !this.activeTurnId) throw new CodexTurnCancelledError();
  }

  private async requestInterruptForTurn(turnId: string): Promise<void> {
    if (!this.threadId || this.interruptingTurnId === turnId) return;
    this.interruptingTurnId = turnId;
    try {
      await this.request('turn/interrupt', { threadId: this.threadId, turnId });
    } catch (err: unknown) {
      // The app-server can finish a turn just before it handles our Stop RPC.
      // It has no structured discriminator for this invalid-request case, so
      // normalize its stable compatibility message here at the Adapter
      // boundary. The requested outcome is already true: settle local state
      // as a successful stop and ignore a later duplicate terminal event.
      if (isAlreadyIdleInterruptError(err)) {
        this.settleActiveTurn(turnId, false);
        return;
      }
      if (!this.closed) this.sendTurnError(errorMessage(err), err);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return this.appServer?.rpc.request(method, params)
      ?? Promise.reject(new Error('Codex app-server is not running.'));
  }

  private respond(id: JsonRpcId, result: unknown): void {
    try {
      this.appServer?.rpc.respond(id, result);
    } catch (err: unknown) {
      log.warn(`failed responding to Codex app-server request:`, err);
    }
  }

  private rejectRequest(id: JsonRpcId, message: string, code = -32603): void {
    try {
      this.appServer?.rpc.reject(id, message, code);
    } catch (err: unknown) {
      log.warn(`failed rejecting Codex app-server request:`, err);
    }
  }

  private onServerRequest(msg: JsonObject): void {
    const method = msg.method as string;
    const id = msg.id as JsonRpcId;
    const params = (msg.params && typeof msg.params === 'object') ? msg.params as JsonObject : {};
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const approvalId = `codex-${String(id)}`;
        const itemId = stringValue(params.itemId) || approvalId;
        this.pendingApprovals.set(approvalId, { requestId: id, method, params });
        this.send({
          t: 'permission',
          id: approvalId,
          toolUseId: itemId,
          name: 'Bash',
          title: approvalTitle(params.reason, params.command, 'Allow Codex to run this command?'),
          input: commandApprovalInput(params),
          approvalScopes: commandCanRemember(params) ? ['session'] : [],
        });
        break;
      }
      case 'item/fileChange/requestApproval': {
        // Edit is deliberately narrow: ordinary changes within the opened
        // folder do not need a click per edit, but a broader filesystem grant
        // must stay on the shared approval-card path. Keeping the app-server
        // policy at on-request also leaves command, network, and sandbox
        // escalation approvals visible instead of making Edit a bypass.
        if (this.accessMode === 'acceptEdits' && isWorkspaceFileChange(params, this.activeCwd())) {
          this.respond(id, { decision: 'accept' });
          break;
        }
        const approvalId = `codex-${String(id)}`;
        const itemId = stringValue(params.itemId) || approvalId;
        this.pendingApprovals.set(approvalId, { requestId: id, method, params });
        this.send({
          t: 'permission',
          id: approvalId,
          toolUseId: itemId,
          name: 'File change',
          title: approvalTitle(params.reason, params.grantRoot, 'Allow Codex to change files?'),
          input: fileChangeApprovalInput(params),
          approvalScopes: ['session'],
        });
        break;
      }
      case 'item/permissions/requestApproval': {
        const approvalId = `codex-${String(id)}`;
        const itemId = stringValue(params.itemId) || approvalId;
        this.pendingApprovals.set(approvalId, { requestId: id, method, params });
        this.send({
          t: 'permission',
          id: approvalId,
          toolUseId: itemId,
          name: 'Permissions',
          approvalScopes: ['session'],
          title: approvalTitle(params.reason, params.cwd, 'Allow Codex to use requested permissions?'),
          input: {
            cwd: stringValue(params.cwd),
            reason: stringValue(params.reason),
            permissions: params.permissions ?? {},
          },
        });
        break;
      }
      case 'mcpServer/elicitation/request': {
        const approval = mcpToolApprovalFromElicitation(params);
        if (approval) {
          if (this.accessMode === 'acceptEdits' && isStashbaseWorkspaceEdit(approval, this.activeCwd())) {
            this.respond(id, { action: 'accept', content: {}, _meta: null });
            break;
          }
          const approvalId = `codex-${String(id)}`;
          this.pendingApprovals.set(approvalId, { requestId: id, method, params });
          this.send({
            t: 'permission',
            id: approvalId,
            toolUseId: approval.toolUseId || approvalId,
            name: approval.name,
            title: approval.title,
            input: approval.input,
            approvalScopes: approval.approvalScopes,
          });
          break;
        }
        this.respond(id, { action: 'cancel', content: null, _meta: null });
        this.sendThinking(protocolNoticeFromParams(params) || 'Codex requested MCP user input; StashBase cancelled that prompt. Send the requested details as a follow-up message if needed.');
        break;
      }
      case 'item/tool/requestUserInput':
        this.respond(id, { answers: {} });
        this.sendThinking(protocolNoticeFromParams(params) || 'Codex requested additional user input; send the details as a follow-up message if needed.');
        break;
      case 'item/tool/call':
        this.respond(id, { contentItems: [], success: false });
        this.sendThinking(`Codex requested unsupported dynamic tool ${toolNameFromRequest(params)}.`);
        break;
      case 'account/chatgptAuthTokens/refresh':
        this.respond(id, null);
        break;
      case 'attestation/generate':
        this.respond(id, null);
        break;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        this.rejectRequest(id, `StashBase does not support Codex app-server request ${method}.`, -32601);
        break;
      default:
        this.rejectRequest(id, `StashBase does not support Codex app-server request ${method}.`, -32601);
        break;
    }
  }

  private onPermissionReply(msg: { [k: string]: unknown }): void {
    const id = typeof msg.id === 'string' ? msg.id : '';
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    const allow = msg.allow === true;
    const always = msg.scope === 'session' || msg.always === true;
    if (pending.method === 'item/commandExecution/requestApproval') {
      this.respond(pending.requestId, { decision: allow ? (always && commandCanRemember(pending.params ?? {}) ? 'acceptForSession' : 'accept') : 'decline' });
      return;
    }
    if (pending.method === 'item/fileChange/requestApproval') {
      this.respond(pending.requestId, { decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline' });
      return;
    }
    if (pending.method === 'item/permissions/requestApproval') {
      this.respond(pending.requestId, {
        permissions: allow ? requestedPermissions(pending.params) : {},
        scope: always ? 'session' : 'turn',
      });
      return;
    }
    if (pending.method === 'mcpServer/elicitation/request') {
      const scope = msg.scope ?? (msg.always === true ? 'session' : undefined);
      const supported = scope === undefined || mcpApprovalScopes(pending.params ?? {}).some(value => value === scope);
      this.respond(pending.requestId, {
        action: allow && supported ? 'accept' : 'decline',
        content: null,
        _meta: allow && supported && scope ? { persist: scope } : null,
      });
      if (allow && !supported) this.send({ t: 'notice', message: 'Codex does not support that approval duration for this request. The action was not allowed.' });
      return;
    }
    this.rejectRequest(pending.requestId, 'Unsupported approval request.');
  }

  private onNotification(method: string, params: JsonObject): void {
    switch (method) {
      case 'skills/changed': void this.publishSkills(true); break;
      case 'thread/started': {
        const threadId = stringValue(params.threadId) || stringValue((params.thread as JsonObject | undefined)?.id);
        if (threadId && !this.threadId) {
          this.threadId = threadId;
          this.send({ t: 'session-id', id: threadId });
        }
        break;
      }
      case 'turn/started': {
        const turn = params.turn as JsonObject | undefined;
        const turnId = stringValue(turn?.id);
        if (this.busy && turnId) {
          this.activeTurnId = turnId;
          if (this.interruptRequested) void this.requestInterruptForTurn(turnId);
          this.flushEarlySteers();
        }
        break;
      }
      case 'item/agentMessage/delta':
        this.sendText(params.delta);
        break;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/plan/delta':
        this.sendThinking(params.delta);
        break;
      case 'item/started':
        this.onItemStarted(params.item);
        break;
      case 'item/completed':
        this.onItemCompleted(params.item);
        break;
      case 'item/commandExecution/outputDelta':
      case 'item/process/outputDelta':
      case 'item/tool/outputDelta':
        this.onToolOutputDelta(params);
        break;
      case 'turn/completed':
        this.onTurnCompleted(params);
        break;
      case 'item/autoApprovalReview/completed': {
        const message = autoApprovalReviewNotice(params);
        if (message) this.send({ t: 'notice', message });
        break;
      }
      case 'error':
        this.onErrorNotification(params);
        break;
      case 'warning':
      case 'guardianWarning':
      case 'configWarning': {
        const message = notificationMessage(params);
        const model = /Model metadata for `([^`\r\n]+)` not found\./i.exec(message)?.[1];
        if (model) this.modelsWithoutMetadata.add(model);
        if (message) this.send({ t: 'notice', message });
        break;
      }
      default:
        break;
    }
  }

  private onItemStarted(item: unknown): void {
    if (!item || typeof item !== 'object') return;
    const recorded = item as ThreadItem & { clientId?: unknown };
    if (recorded.type === 'userMessage') {
      const clientId = typeof recorded.clientId === 'string' ? recorded.clientId : '';
      // The turn's own prompt is recorded first; whether it kept its id says
      // how follow-ups held for that are confirmed.
      if (this.turnMessageId) {
        this.recordsClientIds = clientId === this.turnMessageId;
        this.turnMessageId = null;
        this.flushEarlySteers();
        return;
      }
      const steer = this.steers.get(clientId);
      if (steer && this.steers.delete(clientId)) this.send({ t: 'steer-result', id: steer, ok: true });
      return;
    }
    const tool = toolStartFromItem(item as ThreadItem);
    if (tool) this.send({ t: 'tool', id: tool.id, name: tool.name, input: tool.input });
  }

  private onItemCompleted(item: unknown): void {
    if (!item || typeof item !== 'object') return;
    const result = toolResultFromItem(item as ThreadItem);
    if (result) this.send({ t: 'tool-result', id: result.id, content: result.content, isError: result.isError });
  }

  private onTurnCompleted(params: JsonObject): void {
    const turn = params.turn as JsonObject | undefined;
    const id = stringValue(turn?.id);

    if (!this.isActiveTurn(id)) return;

    const status = codexTurnStatus(turn?.status);
    const error = turn?.error as JsonObject | undefined;
    let message = usefulMessage(error?.message);

    const isInterrupted = status === 'interrupted'
      || this.interruptRequested
      || this.interruptingTurnId === id;
    if (isInterrupted) {
      this.settleActiveTurn(id, false);
      return;
    }

    if (status === 'failed' && !message) {
      message = 'Codex failed before completing the turn.';
    }

    if (message) this.sendTurnError(message, error);
    this.settleActiveTurn(id, status === 'failed' || !!message);
  }

  private onErrorNotification(params: JsonObject): void {
    const turnId = stringValue(params.turnId);
    if (this.busy && !this.activeTurnId && turnId && params.willRetry !== true) {
      this.pendingTerminalError = params;
      return;
    }
    if (!this.isActiveTurn(turnId)) return;

    if (params.willRetry === true) {
      log.info(`Codex reported a retryable error: ${notificationMessage(params)}`);
      return;
    }

    const isInterrupted = this.interruptRequested || this.interruptingTurnId === turnId;
    if (isInterrupted) {
      this.settleActiveTurn(turnId, false);
      return;
    }

    const message = notificationMessage(params) || 'Codex reported an error.';
    this.sendTurnError(message, params.error);
    this.settleActiveTurn(turnId, true);
  }

  private takePendingTerminalError(): JsonObject | null {
    const pending = this.pendingTerminalError;
    this.pendingTerminalError = null;
    return pending;
  }

  private isActiveTurn(turnId: string): boolean {
    return this.busy && !!this.activeTurnId && turnId === this.activeTurnId;
  }

  private settleActiveTurn(turnId: string, isError: boolean): boolean {
    if (!this.isActiveTurn(turnId)) return false;
    this.busy = false;
    this.activeTurnId = null;
    this.turnMessageId = null;
    this.pendingTerminalError = null;
    this.interruptRequested = false;
    this.interruptingTurnId = null;
    this.returnSteers();
    this.send({ t: 'turn-end', isError });
    return true;
  }

  private onToolOutputDelta(params: JsonObject): void {
    const delta = toolOutputDeltaFromParams(params);
    if (delta) this.send({ t: 'tool-delta', id: delta.id, delta: delta.delta });
  }

  private sendText(delta: unknown): void {
    if (typeof delta === 'string' && delta) this.send({ t: 'text', delta });
  }

  private sendThinking(delta: unknown): void {
    if (typeof delta === 'string' && delta) this.send({ t: 'thinking', delta });
  }

  private send(obj: AgentServerEvent, cause?: unknown): void {
    if (this.closed) return;
    reportAgentRuntimeError('codex', obj, this.ws, cause);
    if (this.ws.readyState !== 1 /* OPEN */) return;
    try { this.ws.send(JSON.stringify(obj)); } catch { /* ws gone */ }
  }

  private finish(message?: string, cause?: unknown): void {
    if (this.closed) return;
    const event = agentSessionExitEvent(message);
    if (message && event.failure?.kind === 'auth-expired') agentBootstrapCoordinator.requireSignIn('codex', message);
    this.send(event, cause);
    this.dispose();
  }

  dispose(termination?: AgentSessionTermination): void {
    if (this.closed) return;
    if (termination?.kind === 'scope-removed') {
      this.send({ t: 'exit', reason: 'scope-removed', folder: termination.folder });
    }
    markAgentDiagnosticClosing(this.ws, termination?.kind === 'scope-removed' ? 'scope_removed' : 'session_disposed');
    this.closed = true;
    unregisterAttributedAgentSession(this.attributionId);
    this.onDispose?.(this);
    for (const [, pending] of this.pendingApprovals) {
      this.respond(pending.requestId, { decision: 'cancel' });
    }
    this.pendingApprovals.clear();
    this.disposeAppServer();
    try { this.ws.close(AGENT_SESSION_CLOSE.code, AGENT_SESSION_CLOSE.reason); } catch { /* already closed */ }
  }

  private disposeAppServer(): void {
    this.appServerReady = false;
    const appServer = this.appServer;
    const proc = this.proc;
    this.appServer = null;
    this.proc = null;
    if (appServer) updateAgentDiagnosticContext(this.ws, { pending_rpc_methods: appServer.pendingMethods() });
    appServer?.close(new Error('Codex session closed.'));
    if (proc) this.retirement = retireAgentProcess(proc);
  }

  private handleAppServerExit(error: Error): void {
    this.appServerReady = false;
    // The renderer returns follow-ups to its queue when the session exits.
    this.steers.clear();
    this.earlySteers = [];
    this.busy = false;
    this.activeTurnId = null;
    this.turnMessageId = null;
    this.pendingTerminalError = null;
    this.interruptRequested = false;
    this.interruptingTurnId = null;
    // The terminal exit owns this cause whether startup completed or not.
    // Sending a pre-ready `error` first races the renderer's state commit
    // against the immediate socket close and can replace this detail with a
    // generic connection-closed message.
    this.finish(error.message, error);
  }
}


function toolOutputDeltaFromParams(params: JsonObject): { id: string; delta: string } | null {
  const id = stringValue(params.itemId)
    || stringValue(params.item_id)
    || stringValue(params.toolUseId)
    || stringValue(params.tool_use_id)
    || stringValue(params.id);
  if (!id) return null;
  const delta = outputDeltaText(params.delta)
    || outputDeltaText(params.output)
    || outputDeltaText(params.text)
    || outputDeltaText(params.chunk);
  if (!delta) return null;
  const stream = stringValue(params.stream);
  return { id, delta: stream && stream !== 'stdout' ? `[${stream}] ${delta}` : delta };
}

function outputDeltaText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const obj = value as JsonObject;
  return stringValue(obj.text) || stringValue(obj.content) || stringValue(obj.output);
}

function autoApprovalReviewNotice(params: JsonObject): string {
  const review = params.review;
  if (!review || typeof review !== 'object') return '';
  const value = review as JsonObject;
  const status = stringValue(value.status);
  if (status === 'approved' || status === 'inProgress') return '';

  const title = status === 'denied'
    ? 'Automatic approval blocked an action.'
    : status === 'timedOut'
      ? 'Automatic approval review timed out.'
      : status === 'aborted'
        ? 'Automatic approval review was interrupted.'
        : 'Automatic approval review needs attention.';
  const rationale = usefulMessage(value.rationale);
  return rationale ? `${title}\n\n${rationale}` : title;
}

function isAlreadyIdleInterruptError(err: unknown): boolean {
  return errorMessage(err).trim().toLowerCase() === 'no active turn to interrupt';
}

function toolNameFromRequest(params: JsonObject): string {
  return [stringValue(params.namespace), stringValue(params.tool)].filter(Boolean).join(':') || 'tool';
}

/** Thread metadata differs slightly across app-server releases and providers.
 * Prefer its persisted model identity; never infer from the current default. */
function codexThreadModel(thread: JsonObject | undefined, response?: JsonObject): string | undefined {
  if (!thread) return stringValue(response?.model);
  const config = thread.config && typeof thread.config === 'object' ? thread.config as JsonObject : undefined;
  return stringValue(response?.model) || stringValue(thread.model) || stringValue(thread.modelId) || stringValue(config?.model) || undefined;
}

function codexEffortOption(effort: string | undefined): { effort?: string } {
  return effort ? { effort } : {};
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  if (!firstLine) return '';
  const compact = firstLine.replace(/\s+/g, ' ');
  return compact.length > 60 ? `${compact.slice(0, 60).trimEnd()}…` : compact;
}

const sessions = liveSessionSet<CodexSession>();

export function attachCodexWebSocket(ws: WebSocket, options: AgentConnectionOptions): void {
  const session = new CodexSession(ws, options.windowId, options.effort, options.resume, options.access, options.model, options.folder, (s) => sessions.delete(s));
  session.persona = options.persona;
  sessions.add(session);
  session.begin();
}

/** Kill live Codex sessions (optionally for one window). Called on window
 * close / retire and app shutdown. */
export const killActiveCodex = sessions.killWindow;

/** Kill the live Codex sessions bound to one member folder, across all
 * windows, so a removed folder cannot keep running sessions. */
export const killCodexSessionsForFolder = sessions.killFolder;
