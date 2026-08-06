/**
 * Live Codex WebSocket session runtime.
 *
 * One instance owns one app-server process, one persistent thread, turn
 * lifecycle, JSON-RPC correlation, and renderer event normalization.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { WebSocket } from 'ws';
import { buildStashbasePreamble } from './agent-preamble.ts';
import {
  isAgentAccessMode,
  reportAgentRuntimeFailure,
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
  stringValue,
  toolResultFromItem,
  toolStartFromItem,
  type JsonObject,
  type JsonRpcId,
  type ThreadItem,
} from './codex-protocol.ts';
import { CodexRpcPeer } from './codex-rpc-transport.ts';
import { getCurrentFolder, runWithWindowId } from './folder.ts';
import { ensureAgentsFile } from './agent-rules.ts';
import { errorMessage, logger } from './log.ts';
import { noteTreeChanged } from './watcher.ts';

const log = logger('codex-agent');

interface CodexResolvedSkill extends AgentSkill { path: string }
function codexSkillInput(prompt: string, skill?: CodexResolvedSkill): JsonObject[] { return [{ type: 'text', text: skill ? `$${skill.name} ${prompt}` : prompt, text_elements: [] }, ...(skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : [])]; }

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

export class CodexSession {
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
  private models: AgentModel[] = [];
  private skills: CodexResolvedSkill[] = [];
  private skillIds = new Map<string, string>();
  private nextSkillId = 0;
  private skillsRefreshGeneration = 0;

  readonly windowId: string;

  constructor(
    private ws: WebSocket,
    windowId: string,
    private effort?: string,
    resume?: string,
    private accessMode?: AgentAccessMode,
    private model?: string,
    private onDispose?: (session: CodexSession) => void,
    private spawnProcess: typeof spawnCodexAppServerProcess = spawnCodexAppServerProcess,
  ) {
    this.windowId = normalizeWindowId(windowId);
    this.resumeThreadId = typeof resume === 'string' && resume.trim() ? resume.trim() : null;
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
  }

  begin(): void {
    runWithWindowId(this.windowId, () => { void this.start(); });
  }

  private async start(): Promise<void> {
    if (this.closed) return;
    const cwd = getCurrentFolder();
    if (!cwd) {
      this.send({ t: 'error', message: 'No folder open.' });
      this.finish();
      return;
    }
    if (ensureAgentsFile(cwd)) noteTreeChanged();
    this.cwd = cwd;
    // Model choice belongs to the first turn, so publish the native catalog
    // before the renderer enables its composer. Otherwise a fresh Codex chat
    // cannot select a model for that first turn.
    try {
      await this.ensureAppServer();
      await this.resolveModel();
      // Loading a historic thread is what lets the native app-server return
      // its persisted model metadata before the panel becomes interactive.
      if (this.resumeThreadId) await this.ensureThread();
      this.ready = true;
      this.send({ t: 'ready' });
      void this.refreshSkills();
    } catch (err: unknown) {
      this.send({ t: 'error', message: errorMessage(err) });
      this.finish();
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
    const proc = this.spawnProcess(cwd, { STASHBASE_WINDOW_ID: this.windowId });
    this.proc = proc;
    const rpc = new CodexRpcPeer((line) => {
      if (!proc.stdin.writable) throw new Error('Codex app-server is not running.');
      proc.stdin.write(`${line}\n`);
    }, {
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
      if (!this.closed) {
        this.send({ t: 'error', message: errorMessage(err) });
        this.handleAppServerExit(true);
      }
    });
    proc.once('close', (code, signal) => {
      const error = new Error(`Codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`);
      rpc.close(error);
      if (!this.releaseAppServerGeneration(proc, rpc, stdout, stderr)) return;
      if (!this.closed) {
        reportAgentRuntimeFailure('codex', error);
        this.send({ t: 'error', message: error.message });
        this.handleAppServerExit(true);
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
        if (!body.trim()) return;
        const skill = msg.skill && typeof msg.skill.id === 'string' ? this.skills.find((candidate) => candidate.id === msg.skill!.id) : undefined;
        if (msg.skill && !skill) { this.send({ t: 'error', message: 'That Codex skill is no longer available. Refresh skills and try again.' }); this.send({ t: 'turn-end', isError: true }); return; }
        void this.runTurn(body, titleHint, skill);
        break;
      }
      case 'skills-refresh': void this.refreshSkills(true); break;
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

  private async runTurn(prompt: string, titleHint = '', skill?: CodexResolvedSkill): Promise<void> {
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
    this.interruptRequested = false;
    this.interruptingTurnId = null;
    this.send({ t: 'turn-start' });
    try {
      const model = await this.resolveModel();
      this.throwIfInterruptedBeforeTurn();
      const threadId = await this.ensureThread(titleHint);
      this.throwIfInterruptedBeforeTurn();
      const startTurn = (override: string | undefined) => this.request('turn/start', {
        threadId,
        cwd: this.cwd,
        ...codexEffortOption(this.effort),
        ...(override ? { model: override } : {}),
        input: codexSkillInput(prompt, skill),
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
      }
    } catch (err: unknown) {
      this.busy = false;
      this.activeTurnId = null;
      if (!this.closed) {
        if (!(err instanceof CodexTurnCancelledError)) {
          this.send({ t: 'error', message: errorMessage(err) });
        }
        this.send({ t: 'turn-end', isError: !(err instanceof CodexTurnCancelledError) });
      }
    }
  }

  private async refreshSkills(forceReload = false): Promise<void> {
    if (!this.cwd || this.closed) return;
    const generation = ++this.skillsRefreshGeneration;
    this.send({ t: 'skills', skills: [], loading: true });
    try {
      await this.ensureAppServer();
      const result = await this.request('skills/list', { cwds: [this.cwd], ...(forceReload ? { forceReload: true } : {}) }) as JsonObject;
      const rows = Array.isArray(result.data) ? result.data : [];
      const row = rows.find((value) => value && typeof value === 'object' && stringValue((value as JsonObject).cwd) === this.cwd) as JsonObject | undefined;
      if (this.closed || generation !== this.skillsRefreshGeneration) return;
      this.skills = (Array.isArray(row?.skills) ? row!.skills : []).flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const raw = value as JsonObject;
        if (raw.enabled === false) return [];
        const name = stringValue(raw.name), path = stringValue(raw.path), scope = typeof raw.scope === 'string' ? raw.scope : JSON.stringify(raw.scope ?? '');
        if (!name || !path) return [];
        const key = `${scope}\0${path}`;
        let id = this.skillIds.get(key); if (!id) { id = `skill-${++this.nextSkillId}`; this.skillIds.set(key, id); }
        return [{ id, name, path, description: stringValue(raw.description) || 'Codex skill' }];
      });
      this.send({ t: 'skills', skills: this.skills.map(({ id, name, description }) => ({ id, name, description })) });
    } catch (err: unknown) { if (!this.closed && generation === this.skillsRefreshGeneration) this.send({ t: 'skills', skills: [], error: `Could not load Codex skills: ${errorMessage(err)}` }); }
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
    this.send({ t: 'models', models: this.models, ...(this.model && !selected ? { fallback: 'That model is no longer available; using the runtime default.' } : {}) });
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
        }
      }
      const nextCursor = stringValue(result.nextCursor);
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return models;
  }

  private async ensureThread(titleHint = ''): Promise<string> {
    if (this.threadId) return this.threadId;
    if (!this.cwd) throw new Error('No folder open.');
    await this.ensureAppServer();
    const isNewThread = !this.resumeThreadId;
    const access = codexAccessOptions(this.accessMode);
    const common = {
      cwd: this.cwd,
      approvalPolicy: access.approvalPolicy,
      approvalsReviewer: access.approvalsReviewer,
      sandbox: access.sandbox,
      developerInstructions: buildStashbasePreamble(this.cwd),
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
        if (this.accessMode === 'acceptEdits' && isWorkspaceFileChange(params, this.cwd)) {
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
          if (this.accessMode === 'acceptEdits' && isStashbaseWorkspaceEdit(approval, this.cwd)) {
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
        if (turnId) {
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
      case 'skills/changed':
        void this.refreshSkills(true);
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
    const status = stringValue(turn?.status);
    const error = turn?.error as JsonObject | undefined;
    const message = stringValue(error?.message);
    if (message) this.send({ t: 'error', message });
    this.busy = false;
    this.activeTurnId = null;
    this.interruptRequested = false;
    this.interruptingTurnId = null;
    this.send({ t: 'turn-end', isError: status === 'failed' || !!message });
  }

  private onErrorNotification(params: JsonObject): void {
    const message = notificationMessage(params) || 'Codex reported an error.';
    this.send({ t: 'error', message });
    if (params.willRetry === false) {
      this.busy = false;
      this.activeTurnId = null;
      this.interruptRequested = false;
      this.interruptingTurnId = null;
      this.send({ t: 'turn-end', isError: true });
    }
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

  private finish(): void {
    if (this.closed) return;
    this.send({ t: 'exit' });
    this.dispose();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
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

  private handleAppServerExit(isError: boolean): void {
    this.appServerReady = false;
    if (this.busy) {
      this.busy = false;
      this.activeTurnId = null;
      this.interruptRequested = false;
      this.interruptingTurnId = null;
      this.send({ t: 'turn-end', isError });
      return;
    }
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
  const direct = stringValue(params.message);
  if (direct) return direct;
  const error = params.error;
  if (error && typeof error === 'object') {
    const fromError = stringValue((error as JsonObject).message);
    if (fromError) return fromError;
  }
  return '';
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

export function attachCodexWebSocket(ws: WebSocket, windowId = 'default', effort?: string, resume?: string, access?: AgentAccessMode, model?: string): void {
  const session = new CodexSession(ws, windowId, effort, resume, access, model, (s) => sessions.delete(s));
  sessions.add(session);
  session.begin();
}

export function killActiveCodex(windowId?: string): void {
  for (const session of [...sessions]) {
    if (!windowId || session.windowId === windowId) {
      session.dispose();
      sessions.delete(session);
    }
  }
}

function normalizeWindowId(windowId: string | null | undefined): string {
  const raw = typeof windowId === 'string' ? windowId.trim() : '';
  return raw ? raw.slice(0, 128) : 'default';
}
