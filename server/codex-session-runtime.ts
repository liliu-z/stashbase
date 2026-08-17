/**
 * Live Codex WebSocket session runtime.
 *
 * One instance owns one app-server process, one persistent thread, turn
 * lifecycle, JSON-RPC correlation, and renderer event normalization.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type { WebSocket } from 'ws';
import { buildStashbasePreamble } from './agent-preamble.ts';
import {
  disposeSessionsBoundToFolder,
  isAgentAccessMode,
  reportAgentRuntimeFailure,
  resolveSessionBinding,
  type AgentAccessMode,
  type AgentModel,
  type AgentSkill,
  type AgentClientEvent,
  type AgentServerEvent,
} from './agent-contract.ts';
import {
  approvalTitle,
  codexAccessOptions,
  commandApprovalInput,
  fileChangeApprovalInput,
  isStashbaseWorkspaceEdit,
  isWorkspaceFileChange,
  mcpToolApprovalFromElicitation,
  requestedPermissions,
} from './codex-approval.ts';
import { appVersion, spawnCodexAppServerProcess } from './codex-app-server-process.ts';
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
  CodexRpcPeer,
  CodexRpcRequestTimeoutError,
  CODEX_RPC_REQUEST_TIMEOUT_MS,
} from './codex-rpc-transport.ts';
import {
  registerAttributedAgentSession,
  unregisterAttributedAgentSession,
  type AttributedAgentSession,
} from './agent-session-registry.ts';
import { getCurrentFolder, getFolderHome, runWithWindowId } from './folder.ts';
import { ensureAgentsFile } from './agent-rules.ts';
import { errorMessage, logger } from './log.ts';
import { noteTreeChanged } from './watcher.ts';

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
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdout: readline.Interface | null = null;
  private stderr: readline.Interface | null = null;
  private cwd: string | null = null;
  private threadId: string | null = null;
  private resumeThreadId: string | null = null;
  private activeTurnId: string | null = null;
  // An app-server can report a terminal notification in the same stdout
  // batch as its turn/start response. Keep it until that response gives us
  // the authoritative turn id, rather than dropping a matching failure.
  private pendingTerminalError: JsonObject | null = null;
  private busy = false;
  private interruptRequested = false;
  private interruptingTurnId: string | null = null;
  private rpc: CodexRpcPeer | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  /** Model selection is resolved exactly once, before a new thread's first
   * turn. Re-checking later could silently change an existing session when a
   * runtime catalog is refreshed or a model is withdrawn. */
  private modelResolved = false;
  /** Explicit override for a new thread only. Never derive this from the
   * model the runtime reports for a resumed/default session. */
  private selectedModel: string | undefined;
  private activeModel: string | undefined;
  /** The catalog's `isDefault` entry — what a NEW thread will run when no
   * explicit model is selected. Surfaced as the session identity so the
   * renderer can show a concrete model name instead of "Default". */
  private catalogDefaultModel: string | undefined;
  private models: AgentModel[] = [];
  private skills = new Map<string, { name: string; path: string }>();
  private skillSequence = 0;

  readonly windowId: string;
  readonly agentId = 'codex' as const;
  /** Private per-session attribution id. Rides the app-server env
   * (`STASHBASE_AGENT_SESSION_ID`) → stdio MCP host → request header, so
   * host-side MCP tools can find the live calling session. */
  readonly attributionId = randomUUID();

  /** True for a library-wide session: cwd is the folder home and the
   * session is NOT bound to any member folder — member-folder removal
   * never tears it down (window close / app quit still do). */
  private libraryScoped = false;

  /** Member folder this LIBRARY session was migrated to by `create_project`.
   * The native thread identity stays intact while future turns, workspace
   * approvals, skills, teardown scope, and history follow this folder. */
  private rebound: string | null = null;

  private activeCwd(): string | null {
    return this.rebound ?? this.cwd;
  }

  /** The member folder this session is (or will be) bound to. `cwd` is the
   * authoritative binding once the session started; before that, the explicit
   * connect-time folder is the best answer. A library-scoped session is
   * bound to no member folder and reports null — unless `create_project`
   * rebound it to the new project. */
  boundFolder(): string | null {
    if (this.rebound) return this.rebound;
    if (this.libraryScoped || this.scope === 'library') return null;
    return this.cwd ?? this.folder ?? null;
  }

  turnInFlight(): boolean {
    return this.busy;
  }

  isLibraryScoped(): boolean {
    return !this.rebound && (this.libraryScoped || this.scope === 'library');
  }

  nativeSessionId(): string | null {
    return this.threadId;
  }

  /** Migrate this LIBRARY-scoped session to a member folder (create_project).
   * The native thread identity stays intact, but subsequent turns use the
   * project cwd. A folder-bound chat is never rebound. */
  rebindToFolder(folderAbs: string): boolean {
    if (this.closed || !this.isLibraryScoped()) return false;
    this.rebound = folderAbs;
    this.send({ t: 'scope-changed', scope: { kind: 'folder', path: folderAbs } });
    return true;
  }

  constructor(
    private ws: WebSocket,
    windowId: string,
    private effort?: string,
    resume?: string,
    private accessMode?: AgentAccessMode,
    private model?: string,
    /** Explicit, membership-validated session folder. Undefined with no
     *  library scope follows the window's current folder at connect time
     *  (legacy clients), else the library. */
    private folder?: string,
    /** Explicit library-wide scope (`scope=library` on the connect URL). */
    private scope?: 'library',
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
    // An explicit folder pins the session; an explicit library scope (or
    // no folder anywhere) binds the folder home as the reserved library
    // cwd. Ordinary window navigation never changes it; an attributed
    // create_project transition is the one deliberate exception.
    const binding = resolveSessionBinding({
      scope: this.scope,
      folder: this.folder,
      currentFolder: getCurrentFolder(),
      folderHome: getFolderHome(),
    });
    const cwd = binding.cwd;
    this.libraryScoped = binding.libraryScoped;
    // Instruction files belong to member folders; a library-wide session
    // must not write them into the folder home container.
    if (!this.libraryScoped && ensureAgentsFile(cwd)) noteTreeChanged();
    this.cwd = cwd;
    // Model choice belongs to the first turn, so publish the native catalog
    // before the renderer enables its composer. Otherwise a fresh Codex chat
    // cannot select a model for that first turn.
    try {
      await this.ensureAppServer();
      await this.resolveModel();
      await this.publishSkills();
      // Loading a historic thread is what lets the native app-server return
      // its persisted model metadata before the panel becomes interactive.
      if (this.resumeThreadId) await this.ensureThread();
      this.ready = true;
      this.send({ t: 'ready' });
    } catch (err: unknown) {
      this.finish(errorMessage(err));
    }
  }

  private async ensureAppServer(): Promise<void> {
    if (this.appServerReady) return;
    if (!this.cwd) throw new Error('No folder open.');
    this.spawnAppServer(this.cwd);
    try {
      await this.request('initialize', {
        clientInfo: { name: 'StashBase', title: null, version: appVersion() },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: null,
        },
      });
      this.appServerReady = true;
    } catch (err: unknown) {
      this.disposeAppServer();
      throw err;
    }
  }

  private spawnAppServer(cwd: string): void {
    const proc = this.spawnProcess(cwd, {
      STASHBASE_WINDOW_ID: this.windowId,
      // Session identity for host-side MCP tools (create_project): request
      // attribution only, never a path-resolution channel.
      STASHBASE_AGENT_SESSION_ID: this.attributionId,
    });
    this.proc = proc;
    const rpc = new CodexRpcPeer((line) => {
      if (!proc.stdin.writable) throw new Error('Codex app-server is not running.');
      proc.stdin.write(`${line}\n`);
    }, {
      requestTimeoutMs: this.requestTimeoutMs,
      onRequest: ({ id, method, params }) => this.onServerRequest({ id, method, params }),
      onNotification: (method, params) => this.onNotification(method, params),
    });
    this.rpc = rpc;

    const stdout = readline.createInterface({ input: proc.stdout });
    this.stdout = stdout;
    stdout.on('line', (line) => rpc.receiveLine(line));

    const stderr = readline.createInterface({ input: proc.stderr });
    this.stderr = stderr;
    stderr.on('line', (line) => {
      const clean = line.trim();
      if (clean) log.debug(clean);
    });

    proc.once('error', (err) => {
      rpc.close(err);
      if (!this.releaseAppServerGeneration(proc, rpc, stdout, stderr)) return;
      reportAgentRuntimeFailure('codex', err);
      if (!this.closed) this.handleAppServerExit(errorMessage(err));
    });
    proc.once('close', (code, signal) => {
      const error = new Error(`Codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`);
      rpc.close(error);
      if (!this.releaseAppServerGeneration(proc, rpc, stdout, stderr)) return;
      if (!this.closed) {
        reportAgentRuntimeFailure('codex', error);
        this.handleAppServerExit(error.message);
      }
    });
  }

  private releaseAppServerGeneration(
    proc: ChildProcessWithoutNullStreams,
    rpc: CodexRpcPeer,
    stdout: readline.Interface,
    stderr: readline.Interface,
  ): boolean {
    if (this.proc !== proc || this.rpc !== rpc) return false;
    this.proc = null;
    this.rpc = null;
    if (this.stdout === stdout) this.stdout = null;
    if (this.stderr === stderr) this.stderr = null;
    stdout.close();
    stderr.close();
    return true;
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
      case 'set-mode':
        this.accessMode = isAgentAccessMode(msg.mode) ? msg.mode : this.accessMode;
        break;
    }
  }

  private async steerTurn(clientId: string, prompt: string): Promise<void> {
    if (!this.busy || !this.threadId || !this.activeTurnId) {
      this.send({ t: 'steer-result', id: clientId, ok: false, message: 'Codex is not ready to steer this turn.' });
      return;
    }
    try {
      await this.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.activeTurnId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      });
      this.send({ t: 'steer-result', id: clientId, ok: true });
    } catch (err: unknown) {
      this.send({ t: 'steer-result', id: clientId, ok: false, message: errorMessage(err) });
    }
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
      const startTurn = (override: string | undefined) => this.request('turn/start', {
        threadId,
        cwd: this.activeCwd(),
        ...codexEffortOption(this.effort),
        ...(override ? { model: override } : {}),
        input: [{ type: 'text', text: skill ? `$${skill.name}${prompt ? ` ${prompt}` : ''}` : prompt, text_elements: [] }, ...(skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : [])],
      }) as Promise<JsonObject>;
      let result: JsonObject;
      try {
        result = await startTurn(model);
      } catch (err: unknown) {
        if (!model || !isCodexModelSelectionError(err)) throw err;
        // A runtime can reject a catalogued model because its entitlement or
        // availability changed after discovery. Clear the override and retry
        // this first turn with Default while the picker is still recoverable.
        this.selectedModel = undefined;
        this.send({
          t: 'models',
          models: this.models,
          ...(this.activeModel ? { activeModel: this.activeModel } : {}),
          fallback: 'That model could not be used; retrying with the runtime default.',
        });
        result = await startTurn(undefined);
      }
      if (model && this.selectedModel === model) {
        this.activeModel = model;
        this.send({ t: 'models', models: this.models, activeModel: model });
      }
      const turn = result.turn as JsonObject | undefined;
      const id = stringValue(turn?.id);
      if (this.busy && id) {
        this.activeTurnId = id;
        if (this.interruptRequested) void this.requestInterruptForTurn(id);
        const pendingError = this.takePendingTerminalError();
        if (pendingError && stringValue(pendingError.turnId) === id) this.onErrorNotification(pendingError);
      }
    } catch (err: unknown) {
      if (err instanceof CodexRpcRequestTimeoutError && err.method === 'turn/start') {
        this.fenceTimedOutTurnStart();
      }
      this.busy = false;
      this.activeTurnId = null;
      this.pendingTerminalError = null;
      if (!this.closed) {
        if (!(err instanceof CodexTurnCancelledError)) {
          this.send({ t: 'error', message: errorMessage(err) });
        }
        this.send({ t: 'turn-end', isError: !(err instanceof CodexTurnCancelledError) });
      }
    }
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
      // Older app-servers can still run a normal default session even when
      // they do not expose the optional catalog method.
      this.modelResolved = true;
      this.send({ t: 'models', models: [], ...(this.model ? { fallback: 'This Codex runtime cannot verify that model; using the runtime default.' } : {}) });
      log.debug(`could not discover Codex models: ${errorMessage(err)}`);
      return undefined;
    }
    if (this.resumeThreadId) {
      this.send({ t: 'models', models: this.models });
      this.modelResolved = true;
      return undefined;
    }
    const selected = this.model && this.models.some((entry) => entry.id === this.model) ? this.model : undefined;
    // With no explicit selection the new thread will run the catalog's
    // default — report that concrete identity up front; the thread-start
    // metadata later confirms (or corrects) it.
    if (!selected && this.catalogDefaultModel) this.activeModel = this.catalogDefaultModel;
    this.send({
      t: 'models',
      models: this.models,
      ...(this.activeModel ? { activeModel: this.activeModel } : {}),
      ...(this.model && !selected ? { fallback: 'That model is no longer available; using the runtime default.' } : {}),
    });
    this.selectedModel = selected;
    this.modelResolved = true;
    return selected;
  }

  /** Model catalogs are paginated by the native app-server. A valid selected
   * model can appear on a later page, so validate only after collecting all
   * pages. */
  private async loadModelCatalog(): Promise<AgentModel[]> {
    const models: AgentModel[] = [];
    const seenModels = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const result = await this.request('model/list', cursor ? { cursor } : {}) as JsonObject;
      const entries = Array.isArray(result.data) ? result.data : Array.isArray(result.models) ? result.models : [];
      for (const entry of entries) {
        const model = codexCatalogModel(entry);
        if (model && !seenModels.has(model.id)) {
          seenModels.add(model.id);
          models.push(model);
          if ((entry as JsonObject).isDefault === true) this.catalogDefaultModel ??= model.id;
        }
      }
      const nextCursor = stringValue(result.nextCursor);
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return models;
  }

  private async publishSkills(forceReload = false): Promise<void> {
    const cwd = this.activeCwd();
    if (!cwd) return;
    try {
      const result = await this.request('skills/list', { cwds: [cwd], ...(forceReload ? { forceReload: true } : {}) }) as JsonObject;
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
    } catch (err) { this.skills.clear(); this.send({ t: 'skills', skills: [], state: 'failed', error: 'Could not load skills. Try again.' }); log.debug(errorMessage(err)); }
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
      developerInstructions: buildStashbasePreamble(cwd, this.rebound || !this.libraryScoped ? 'folder' : 'library'),
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
    const activeModel = codexThreadModel(thread, result);
    if (activeModel) {
      this.activeModel = activeModel;
      if (!this.models.some((entry) => entry.id === activeModel)) {
        this.models = [...this.models, { id: activeModel, label: activeModel }];
      }
      // A new thread is still on its native Default until the first selected
      // turn succeeds. Do not let that temporary identity overwrite the
      // pending selection in the renderer.
      if (!isNewThread || !this.selectedModel) {
        this.send({ t: 'models', models: this.models, activeModel });
      }
    }
    this.resumeThreadId = null;
    if (shouldSendSessionId) this.send({ t: 'session-id', id });
    if (isNewThread) {
      const title = titleFromPrompt(titleHint);
      if (title) {
        this.send({ t: 'session-title', title });
        await this.request('thread/name/set', { threadId: id, name: title })
          .catch((err: unknown) => log.warn(`Codex title set failed for ${id}: ${errorMessage(err)}`));
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
      if (!this.closed) this.send({ t: 'error', message: errorMessage(err) });
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return this.rpc?.request(method, params)
      ?? Promise.reject(new Error('Codex app-server is not running.'));
  }

  private respond(id: JsonRpcId, result: unknown): void {
    try {
      this.rpc?.respond(id, result);
    } catch (err: unknown) {
      log.warn(`failed responding to Codex app-server request: ${errorMessage(err)}`);
    }
  }

  private rejectRequest(id: JsonRpcId, message: string, code = -32603): void {
    try {
      this.rpc?.reject(id, message, code);
    } catch (err: unknown) {
      log.warn(`failed rejecting Codex app-server request: ${errorMessage(err)}`);
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
    const always = msg.always === true;
    if (pending.method === 'item/commandExecution/requestApproval') {
      this.respond(pending.requestId, { decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline' });
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
      this.respond(pending.requestId, {
        action: allow ? 'accept' : 'decline',
        content: allow ? {} : null,
        _meta: null,
      });
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
      case 'error':
        this.onErrorNotification(params);
        break;
      case 'warning':
      case 'guardianWarning':
      case 'configWarning': {
        const message = notificationMessage(params);
        if (message) this.send({ t: 'error', message });
        break;
      }
      default:
        break;
    }
  }

  private onItemStarted(item: unknown): void {
    if (!item || typeof item !== 'object') return;
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

    if (message) this.send({ t: 'error', message });
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
    this.send({ t: 'error', message });
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
    this.pendingTerminalError = null;
    this.interruptRequested = false;
    this.interruptingTurnId = null;
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

  private send(obj: AgentServerEvent): void {
    if (this.ws.readyState !== 1 /* OPEN */) return;
    try { this.ws.send(JSON.stringify(obj)); } catch { /* ws gone */ }
  }

  private finish(message?: string): void {
    if (this.closed) return;
    this.send({ t: 'exit', ...(message ? { message } : {}) });
    this.dispose();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    unregisterAttributedAgentSession(this.attributionId);
    this.onDispose?.(this);
    for (const [, pending] of this.pendingApprovals) {
      this.respond(pending.requestId, { decision: 'cancel' });
    }
    this.pendingApprovals.clear();
    this.disposeAppServer();
    try { this.ws.close(); } catch { /* already closed */ }
  }

  private disposeAppServer(): void {
    this.appServerReady = false;
    const rpc = this.rpc;
    const proc = this.proc;
    const stdout = this.stdout;
    const stderr = this.stderr;
    this.rpc = null;
    this.proc = null;
    this.stdout = null;
    this.stderr = null;
    rpc?.close(new Error('Codex session closed.'));
    stdout?.close();
    stderr?.close();
    if (proc) try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  }

  private handleAppServerExit(message: string): void {
    this.appServerReady = false;
    this.busy = false;
    this.activeTurnId = null;
    this.pendingTerminalError = null;
    this.interruptRequested = false;
    this.interruptingTurnId = null;
    // The terminal exit owns this cause whether startup completed or not.
    // Sending a pre-ready `error` first races the renderer's state commit
    // against the immediate socket close and can replace this detail with a
    // generic connection-closed message.
    this.finish(message);
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

function protocolNoticeFromParams(params: JsonObject): string {
  const message = notificationMessage(params);
  if (message) return message;
  const prompt = stringValue(params.prompt) || stringValue(params.message);
  return prompt;
}

function notificationMessage(params: JsonObject): string {
  const direct = usefulMessage(params.message);
  if (direct) return direct;
  const error = params.error;
  if (error && typeof error === 'object') {
    const fromError = usefulMessage((error as JsonObject).message);
    if (fromError) return fromError;
  }
  return '';
}

function usefulMessage(value: unknown): string {
  const message = stringValue(value);
  return message.trim() ? message : '';
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

/** Normalize the app-server catalog while retaining its advertised effort
 * order. Codex returns effort entries as objects, unlike the Claude SDK. */
function codexCatalogModel(entry: unknown): AgentModel | null {
  if (!entry || typeof entry !== 'object') return null;
  const value = entry as JsonObject;
  const id = stringValue(value.id) ?? stringValue(value.model);
  if (!id) return null;
  const supportedEfforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts.flatMap((effort): string[] => {
      if (typeof effort === 'string') return [effort];
      if (!effort || typeof effort !== 'object') return [];
      const id = stringValue((effort as JsonObject).reasoningEffort);
      return id ? [id] : [];
    })
    : [];
  return {
    id,
    label: stringValue(value.displayName) ?? stringValue(value.name) ?? id,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(supportedEfforts.length ? { supportedEfforts } : {}),
  };
}

function codexEffortOption(effort: string | undefined): { effort?: string } {
  return effort ? { effort } : {};
}

function isCodexModelSelectionError(err: unknown): boolean {
  const message = errorMessage(err);
  return /\bmodel\b/i.test(message)
    && /(unavailable|not available|not found|unsupported|unauthori[sz]ed|not permitted|access denied|does not exist)/i.test(message);
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




const sessions = new Set<CodexSession>();

export function attachCodexWebSocket(ws: WebSocket, windowId = 'default', effort?: string, resume?: string, access?: AgentAccessMode, model?: string, folder?: string, scope?: 'library'): void {
  const session = new CodexSession(ws, windowId, effort, resume, access, model, folder, scope, (s) => sessions.delete(s));
  sessions.add(session);
  session.begin();
}

/** Kill live Codex sessions (optionally for one window). Called on window
 * close / retire and app shutdown — never on a folder switch; sessions are
 * folder-bound and survive the window moving elsewhere. */
export function killActiveCodex(windowId?: string): void {
  for (const session of [...sessions]) {
    if (!windowId || session.windowId === windowId) {
      session.dispose();
      sessions.delete(session);
    }
  }
}

/** Kill the live Codex sessions bound to one member folder, across all
 * windows. Library folder removal calls this so a removed folder cannot keep
 * running sessions. */
export function killCodexSessionsForFolder(folderAbs: string): void {
  disposeSessionsBoundToFolder(sessions, folderAbs);
}

function normalizeWindowId(windowId: string | null | undefined): string {
  const raw = typeof windowId === 'string' ? windowId.trim() : '';
  return raw ? raw.slice(0, 128) : 'default';
}
