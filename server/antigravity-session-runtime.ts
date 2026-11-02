import { AGENT_SESSION_CLOSE } from '../shared/agent-protocol.ts';
import { agentDiagnosticStage, beginAgentDiagnosticTurn, markAgentDiagnosticClosing, reportAgentRuntimeError } from './error-reporting.ts';
import { retireAgentProcess, ownAgentProcess, type AgentStopReason } from './agent-process.ts';
/**
 * Live Antigravity WebSocket session runtime.
 *
 * One instance owns one chat: an `agy` stream-json process, the native
 * conversation id, turn lifecycle, the approval cards its `PreToolUse` hook
 * raises, and the conversation's StashBase history record.
 *
 * The process starts with the first prompt and carries the chat's mode, model
 * and effort as launch flags, so a later change restarts it on the same
 * conversation (`--conversation`). Stop interrupts the process and retires it;
 * the next prompt resumes the conversation in a fresh one. Antigravity takes
 * no system prompt from its caller, so the routing policy and persona ride
 * ahead of the first message each process receives.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { projectMathMode, resolveAgentRuntimeInstructions } from './agent-runtime-instructions.ts';
import {
  consumeAgentTurnFailure,
  simulatedTurnFailureScript,
  type AgentTurnFailureSimulation,
} from './agent-runtime-paths.ts';
import { agentSessionExitEvent, agentTurnErrorEvent } from './agent-turn-failure.ts';
import { agentBootstrapCoordinator } from './agent-runtime-installer.ts';
import {
  resolveSessionBinding,
  type AgentAccessMode,
  type AgentConnectionOptions,
  type AgentModel,
  type AgentClientEvent,
  type AgentServerEvent,
  type AgentSessionTermination,
} from './agent-contract.ts';
import { agentCliEnv, commandDir, resolveAgentCli } from './agent-cli.ts';
import { agentCliLaunch } from './agent-cli-launch.ts';
import { ensureAgentModelCatalog, recallAgentModels, rememberAgentDefaultModel } from './agent-model-catalog.ts';
import {
  ANTIGRAVITY_ACCESS_MODES,
  antigravityApprovalTitle,
  antigravityArgs,
  antigravityErrorFromStderr,
  antigravityPromptWithInstructions,
  antigravityToolDecision,
  antigravityToolDisplay,
  antigravityUserMessage,
  classifyAntigravityTool,
  objectValue,
  parseAntigravityLine,
  stringValue,
  type AntigravityLaunch,
  type AntigravityResult,
  type AntigravityStep,
  type JsonObject,
} from './antigravity-protocol.ts';
import { antigravityHistory, type AntigravityHistoryBlock, type AntigravityHistoryStore } from './antigravity-history.ts';
import { nativeAgentCliSpec } from './native-agents.ts';
import {
  liveSessionSet,
  registerAttributedAgentSession,
  unregisterAttributedAgentSession,
  type AttributedAgentSession,
} from './agent-session-registry.ts';
import { getCurrentFolder, normalizeWindowId, runWithWindowId } from './folder.ts';
import { errorMessage, logger } from './log.ts';

const log = logger('antigravity-agent');

/** Stop waits this long for `agy` to report the interrupted turn before the
 * process is retired outright. */
const INTERRUPT_GRACE_MS = 5_000;
/** An approval card is answered before the hook's own deadline
 * (`ANTIGRAVITY_HOOK_TIMEOUT_SECONDS`), so `agy` sees a decision rather than a
 * hook failure. */
const APPROVAL_DEADLINE_MS = 58 * 60_000;

export interface AntigravityHookDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

interface PendingApproval {
  toolUseId: string;
  alwaysKey: string;
  resolve(decision: AntigravityHookDecision): void;
}

interface TurnState {
  /** Prefixes this turn's tool ids: `agy` numbers steps per process, so a
   * resumed conversation can reuse an earlier turn's step numbers. */
  key: string;
  prompt: string;
  streamedText: boolean;
  assistantText: string;
  blocks: AntigravityHistoryBlock[];
  tools: Map<number, { id: string; name: string; input: JsonObject; done: boolean }>;
  stepError: string;
  titleHint: string;
}

export type AntigravityProcessSpawner = (
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => ChildProcessWithoutNullStreams;

function spawnAntigravityProcess(cwd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const command = resolveAgentCli(nativeAgentCliSpec('antigravity'), (message) => log.warn(message));
  if (!command) {
    throw Object.assign(new Error('Antigravity CLI not found. Install Antigravity in Settings → Agents to use it.'), {
      status: 412,
      code: 'AGENT_NOT_INSTALLED',
    });
  }
  log.info(`spawning Antigravity via ${command}`);
  const launch = agentCliLaunch(command, args);
  return ownAgentProcess(spawn(launch.command, launch.args, {
    cwd,
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: agentCliEnv(env, [commandDir(command)]),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  }), { runtime: 'antigravity', purpose: 'chat' });
}

export class AntigravitySession implements AttributedAgentSession {
  readonly agentId = 'antigravity' as const;
  readonly windowId: string;
  /** Private per-session attribution id. Rides the `agy` environment to the
   *  StashBase MCP host and the approval hook, which present it to the host. */
  readonly attributionId = randomUUID();
  /** The library persona this Chat runs under, composed into its instructions. */
  persona: string | undefined;

  private closed = false;
  private ready = false;
  private cwd: string | null = null;
  private accessMode: AgentAccessMode;
  private conversationId: string | null;
  private readonly resumed: boolean;
  private models: AgentModel[] = [];
  private selectedModel: string | undefined;
  private activeModel: string | undefined;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private launchedWith: AntigravityLaunch | null = null;
  private instructionsSent = false;
  private stdoutBuffer = '';
  private stderrTail = '';
  private retirement: Promise<void> = Promise.resolve();

  private busy = false;
  private interruptRequested = false;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private turn: TurnState | null = null;
  private approvalSequence = 0;
  private turnSequence = 0;
  private pendingApprovals = new Map<string, PendingApproval>();
  /** "Always" answers hold for this session and mode only. */
  private alwaysAllowed = new Set<string>();

  constructor(
    private ws: WebSocket,
    windowId: string,
    private effort: string | undefined,
    resume: string | undefined,
    access: string | undefined,
    private requestedModel: string | undefined,
    private folder: string | undefined,
    private onDispose?: (session: AntigravitySession) => void,
    private spawnProcess: AntigravityProcessSpawner = spawnAntigravityProcess,
    private history: AntigravityHistoryStore = antigravityHistory,
    private catalog: AntigravityCatalogSource = rememberedThenFreshCatalog,
  ) {
    this.windowId = normalizeWindowId(windowId);
    this.accessMode = antigravityAccessMode(access);
    this.conversationId = typeof resume === 'string' && resume.trim() ? resume.trim() : null;
    this.resumed = this.conversationId !== null;
    registerAttributedAgentSession(this.attributionId, this);
    antigravitySessions.set(this.attributionId, this);
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
  }

  boundFolder(): string | null {
    return this.cwd ?? this.folder ?? null;
  }

  turnInFlight(): boolean {
    return this.busy;
  }

  begin(): void {
    runWithWindowId(this.windowId, () => { void this.start(); });
  }

  private async start(): Promise<void> {
    if (this.closed) return;
    try {
      this.cwd = resolveSessionBinding({ folder: this.folder, currentFolder: getCurrentFolder() }).cwd;
    } catch (error) {
      this.finish(errorMessage(error), error);
      return;
    }
    this.publishRememberedModels();
    if (this.conversationId) this.send({ t: 'session-id', id: this.conversationId });
    this.ready = true;
    this.send({ t: 'ready' });
    void this.refreshModels();
  }

  /** Like a Claude session, each chat reads the runtime's current models when
   * it starts. One `agy` read takes 10–20 seconds, so the chat opens on the
   * remembered list and the fresh one replaces it when it lands. */
  private publishRememberedModels(): void {
    this.models = this.catalog.remembered();
    const requested = this.resumed ? undefined : this.requestedModel;
    // A pick the remembered list cannot confirm yet waits for the fresh one.
    this.selectedModel = requested && (!this.models.length || this.models.some((model) => model.id === requested))
      ? requested
      : undefined;
    this.send({
      t: 'models',
      models: this.models,
      ...(requested && !this.selectedModel ? { fallback: 'That model is no longer available; using the runtime default.' } : {}),
    });
  }

  private async refreshModels(): Promise<void> {
    let models: AgentModel[];
    try {
      models = await this.catalog.fresh();
    } catch (error) {
      log.debug(`could not read Antigravity models: ${errorMessage(error)}`);
      return;
    }
    if (this.closed || models.length === 0) return;
    const changed = JSON.stringify(models) !== JSON.stringify(this.models);
    this.models = models;
    // A process already running on the model keeps it; the next one cannot.
    const withdrawn = !!this.selectedModel && !this.busy && !models.some((model) => model.id === this.selectedModel);
    if (withdrawn) this.selectedModel = undefined;
    if (!changed && !withdrawn) return;
    this.send({
      t: 'models',
      models,
      ...(this.activeModel ? { activeModel: this.activeModel } : {}),
      ...(withdrawn ? { fallback: 'That model is no longer available; using the runtime default.' } : {}),
    });
  }

  private onMessage(text: string): void {
    let msg: AgentClientEvent;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg.t) {
      case 'prompt': {
        const body = typeof msg.text === 'string' ? msg.text : '';
        if (!body.trim()) return;
        if (!this.busy) beginAgentDiagnosticTurn(this.ws, msg.telemetryTurnId, {
          ...(this.activeModel ? { model: this.activeModel } : {}),
          ...(this.conversationId ? { native_session_id: this.conversationId } : {}),
        });
        void this.runTurn(body, typeof msg.titleHint === 'string' ? msg.titleHint : '');
        break;
      }
      case 'permission-reply':
        this.onPermissionReply(msg);
        break;
      case 'interrupt':
        this.interrupt();
        break;
      case 'close':
        this.dispose();
        break;
      case 'set-model':
        this.setModelForNextTurn(msg.model);
        break;
      case 'set-mode': {
        const mode = antigravityAccessMode(msg.mode);
        if (mode !== this.accessMode) this.alwaysAllowed.clear();
        this.accessMode = mode;
        break;
      }
      default:
        break;
    }
  }

  private setModelForNextTurn(value: unknown): void {
    if (this.busy || (value !== undefined && typeof value !== 'string')) return;
    const requested = typeof value === 'string' && value ? value : undefined;
    if (requested && this.models.length && !this.models.some((model) => model.id === requested)) {
      this.send({
        t: 'models',
        models: this.models,
        ...(this.activeModel ? { activeModel: this.activeModel } : {}),
        fallback: 'That model is no longer available; keeping the current model.',
      });
      return;
    }
    this.selectedModel = requested;
  }

  private async runTurn(prompt: string, titleHint: string): Promise<void> {
    if (this.closed) return;
    if (!this.ready || !this.cwd) {
      this.send({ t: 'error', message: 'Antigravity is not ready yet.' });
      return;
    }
    if (this.busy) {
      this.send({ t: 'error', message: 'Antigravity is already working on a turn.' });
      return;
    }
    const simulated = consumeAgentTurnFailure();
    if (simulated) { this.playSimulatedTurnFailure(simulated); return; }

    this.busy = true;
    this.interruptRequested = false;
    this.turn = {
      key: `${Date.now().toString(36)}-${++this.turnSequence}`,
      prompt,
      streamedText: false,
      assistantText: '',
      blocks: [{ kind: 'user', id: `u${Date.now()}`, text: prompt, at: Date.now() }],
      tools: new Map(),
      stepError: '',
      titleHint,
    };
    this.send({ t: 'turn-start' });
    try {
      const proc = await this.ensureProcess();
      if (this.interruptRequested || this.closed) {
        this.settleTurn(false);
        return;
      }
      const text = this.instructionsSent
        ? prompt
        : antigravityPromptWithInstructions(
            resolveAgentRuntimeInstructions(this.persona, projectMathMode(this.cwd)),
            prompt,
          );
      this.instructionsSent = true;
      agentDiagnosticStage(this.ws, 'runtime_dispatched');
      proc.stdin.write(antigravityUserMessage(text));
    } catch (error) {
      if (!this.closed) this.sendTurnError(errorMessage(error), error);
      this.settleTurn(true);
    }
  }

  /** The live process when it was launched for the chat's current choices;
   * otherwise a fresh one on the same conversation. */
  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    const launch: AntigravityLaunch = {
      mode: this.accessMode,
      ...(this.selectedModel ? { model: this.selectedModel } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
    };
    if (this.proc && this.launchedWith && sameLaunch(this.launchedWith, launch)) return this.proc;
    this.retireProcess();
    await this.retirement;
    if (this.closed) throw new Error('Antigravity session closed.');
    const args = antigravityArgs({ ...launch, ...(this.conversationId ? { conversation: this.conversationId } : {}) });
    const proc = this.spawnProcess(this.cwd!, args, {
      STASHBASE_WINDOW_ID: this.windowId,
      // Request attribution for StashBase MCP and the approval hook; never a
      // path-resolution channel.
      STASHBASE_AGENT_SESSION_ID: this.attributionId,
    });
    this.proc = proc;
    this.launchedWith = launch;
    this.instructionsSent = false;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => { if (this.proc === proc) this.onStdout(chunk); });
    proc.stderr.on('data', (chunk: string) => {
      if (this.proc === proc) this.stderrTail = (this.stderrTail + chunk).slice(-8_000);
    });
    proc.stdin.on('error', (error) => log.debug(`Antigravity stdin closed: ${error.message}`));
    proc.once('error', (error) => { if (this.proc === proc) this.onProcessExit(proc, null, error.message); });
    // `close` follows the last stdout data, so a result printed just before
    // exiting is read before the exit is judged.
    proc.once('close', (code) => { if (this.proc === proc) this.onProcessExit(proc, code); });
    return proc;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) this.onLine(line);
  }

  private onLine(line: string): void {
    const event = parseAntigravityLine(line);
    if (!event) return;
    // `init` names the chat's conversation. A step may come from a subagent's
    // own conversation, so it only fills an id the process has not named.
    if (event.conversationId && (event.kind === 'init' || !this.conversationId)) {
      this.adoptConversation(event.conversationId);
    }
    if (event.kind === 'init') this.onInit(event.model);
    else if (event.kind === 'step') this.onStep(event);
    else this.onResult(event);
  }

  private adoptConversation(id: string): void {
    if (this.conversationId === id) return;
    this.conversationId = id;
    this.send({ t: 'session-id', id });
    const title = titleFromPrompt(this.turn?.titleHint || this.turn?.prompt || '');
    if (!this.resumed && title) this.send({ t: 'session-title', title });
  }

  private onInit(model: string | undefined): void {
    if (!model) return;
    this.activeModel = model;
    if (!this.selectedModel) rememberAgentDefaultModel('antigravity', model);
    if (this.models.some((entry) => entry.id === model)) {
      this.send({ t: 'models', models: this.models, activeModel: model });
    }
  }

  private onStep(step: AntigravityStep): void {
    const turn = this.turn;
    if (!this.busy || !turn) return;
    if (step.type === 'error_message') {
      turn.stepError = step.textDelta || step.tool?.error || turn.stepError;
      return;
    }
    if (step.tool) {
      const id = toolId(turn, step.index);
      let tool = turn.tools.get(step.index);
      if (!tool) {
        this.flushAssistantText();
        const display = antigravityToolDisplay({ name: step.tool.name, args: step.tool.parameters });
        tool = { id, name: display.name, input: display.input, done: false };
        turn.tools.set(step.index, tool);
        this.send({ t: 'tool', id, name: tool.name, input: tool.input });
      }
      if (step.state === 'done' && !tool.done) {
        tool.done = true;
        const isError = !!step.tool.error;
        const content = step.tool.output || step.tool.error;
        this.send({ t: 'tool-result', id, content, isError });
        turn.blocks.push({ kind: 'tool', id, name: tool.name, input: tool.input, status: isError ? 'error' : 'done', ...(content ? { result: content } : {}) });
      }
      return;
    }
    if (step.type === 'user_input' || !step.textDelta) return;
    turn.streamedText = true;
    turn.assistantText += step.textDelta;
    this.send({ t: 'text', delta: step.textDelta });
  }

  private onResult(result: AntigravityResult): void {
    const turn = this.turn;
    if (!this.busy || !turn) return;
    if (this.interruptRequested || result.status === 'CANCELED' || result.status === 'INTERRUPTED') {
      // A Stop the reader asked for is a normal end; one they did not ask for
      // still stopped the turn before its answer.
      if (!this.interruptRequested) this.sendTurnError(result.error || 'Antigravity stopped the turn before it finished.');
      const requested = this.interruptRequested;
      this.settleTurn(!requested);
      if (requested) this.retireProcess('interrupted');
      return;
    }
    if (result.status === 'SUCCESS') {
      if (!turn.streamedText && result.response) {
        turn.streamedText = true;
        turn.assistantText += result.response;
        this.send({ t: 'text', delta: result.response });
      }
      if (result.deniedActions.length) {
        this.send({ t: 'notice', message: `Antigravity did not run: ${result.deniedActions.join(', ')}.` });
      }
      // The CLI can report success for a turn that produced nothing; that
      // turn did not answer the reader.
      if (!turn.streamedText && turn.tools.size === 0) {
        this.sendTurnError(turn.stepError || 'Antigravity ended the turn without a response. Try sending it again.');
        this.settleTurn(true);
        return;
      }
      this.settleTurn(false);
      return;
    }
    const message = result.error || turn.stepError || antigravityErrorFromStderr(this.stderrTail)
      || `Antigravity ended the turn with status ${result.status}.`;
    this.sendTurnError(message);
    this.settleTurn(true);
  }

  private onProcessExit(proc: ChildProcessWithoutNullStreams, code: number | null, spawnError?: string): void {
    const unterminated = this.stdoutBuffer;
    this.stdoutBuffer = '';
    if (unterminated.trim()) this.onLine(unterminated);
    this.proc = null;
    this.launchedWith = null;
    void retireAgentProcess(proc, 'process_exit').catch(() => {});
    this.denyPendingApprovals('The Antigravity process ended.');
    if (!this.busy || this.closed) return;
    if (this.interruptRequested) {
      this.settleTurn(false);
      return;
    }
    const message = spawnError
      || antigravityErrorFromStderr(this.stderrTail)
      || this.turn?.stepError
      || lastLines(this.stderrTail)
      || `Antigravity exited unexpectedly (code ${code ?? 'unknown'}).`;
    this.sendTurnError(message);
    this.settleTurn(true);
  }

  private interrupt(): void {
    if (!this.busy || this.interruptRequested) return;
    this.interruptRequested = true;
    this.denyPendingApprovals('The reader stopped this turn.');
    const proc = this.proc;
    if (!proc) return; // The turn settles once its process start returns.
    try { proc.kill('SIGINT'); } catch { /* already gone */ }
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.busy && this.interruptRequested && this.proc === proc) this.retireProcess('interrupted');
    }, INTERRUPT_GRACE_MS);
    this.interruptTimer.unref?.();
  }

  /** Retire the live process; a turn it was running settles as stopped. */
  private retireProcess(reason: AgentStopReason = 'configuration_changed'): void {
    const proc = this.proc;
    this.proc = null;
    this.launchedWith = null;
    if (!proc) return;
    try { proc.stdin.end(); } catch { /* already closed */ }
    this.retirement = retireAgentProcess(proc, reason).catch(() => {});
    if (this.busy && this.interruptRequested) this.settleTurn(false);
  }

  private settleTurn(isError: boolean): void {
    if (!this.busy) return;
    const turn = this.turn;
    this.busy = false;
    this.turn = null;
    this.interruptRequested = false;
    if (this.interruptTimer) { clearTimeout(this.interruptTimer); this.interruptTimer = null; }
    this.denyPendingApprovals('The turn ended.');
    if (turn) this.recordTurn(turn);
    this.send({ t: 'turn-end', isError });
  }

  private flushAssistantText(): void {
    const turn = this.turn;
    if (!turn?.assistantText.trim()) return;
    turn.blocks.push({ kind: 'assistant', id: `a${Date.now()}-${turn.blocks.length}`, text: turn.assistantText, at: Date.now() });
    turn.assistantText = '';
  }

  private recordTurn(turn: TurnState): void {
    if (turn.assistantText.trim()) {
      turn.blocks.push({ kind: 'assistant', id: `a${Date.now()}-${turn.blocks.length}`, text: turn.assistantText, at: Date.now() });
      turn.assistantText = '';
    }
    const id = this.conversationId;
    const folder = this.cwd;
    if (!id || !folder) return;
    const title = this.resumed ? undefined : titleFromPrompt(turn.titleHint || turn.prompt) || undefined;
    void this.history.appendTurn(id, folder, turn.blocks, title).catch((error) => {
      log.warn(`could not record Antigravity turn for ${id}:`, error);
    });
  }

  // --- Approval gate (PreToolUse hook) ----------------------------------

  /** Decide one tool call Antigravity is about to make. Reads pass, the mode
   * settles what it can, and the rest waits for the reader's answer. */
  async reviewToolCall(payload: unknown, signal: AbortSignal): Promise<AntigravityHookDecision> {
    if (this.closed) return { decision: 'deny', reason: 'This StashBase chat has ended.' };
    const hook = objectValue(payload);
    const conversation = stringValue(hook.conversationId) || stringValue(hook.conversation_id);
    if (conversation && this.conversationId && conversation !== this.conversationId) {
      return { decision: 'deny', reason: 'This action does not belong to the StashBase chat that started Antigravity.' };
    }
    if (!this.busy || this.interruptRequested) return { decision: 'deny', reason: 'No turn is running in this StashBase chat.' };
    const call = objectValue(hook.toolCall ?? hook.tool_call);
    const name = stringValue(call.name);
    if (!name) return { decision: 'deny', reason: 'StashBase could not identify this action.' };
    const args = objectValue(call.args ?? call.arguments);
    const classified = classifyAntigravityTool({ name, args });
    const decision = antigravityToolDecision(this.accessMode, classified, this.cwd);
    if (decision === 'allow') return { decision: 'allow' };
    if (decision === 'deny') {
      return {
        decision: 'deny',
        reason: 'Plan mode is read-only in StashBase. Describe the change instead of making it.',
      };
    }
    const display = antigravityToolDisplay({ name, args });
    const alwaysKey = display.name === 'Bash' ? `Bash:${stringValue(display.input.command)}` : display.name;
    if (this.alwaysAllowed.has(alwaysKey)) return { decision: 'allow' };
    const stepIndex = typeof hook.stepIdx === 'number' ? hook.stepIdx : typeof hook.step_idx === 'number' ? hook.step_idx : null;
    const approvalId = `antigravity-${++this.approvalSequence}`;
    const toolUseId = stepIndex !== null && this.turn ? toolId(this.turn, stepIndex) : approvalId;
    return new Promise<AntigravityHookDecision>((resolve) => {
      let settled = false;
      const finish = (result: AntigravityHookDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal.removeEventListener('abort', abandon);
        this.pendingApprovals.delete(approvalId);
        resolve(result);
      };
      const abandon = () => finish({ decision: 'deny', reason: 'The approval request was withdrawn.' });
      const deadline = setTimeout(
        () => finish({ decision: 'deny', reason: 'No one answered the approval request in time.' }),
        APPROVAL_DEADLINE_MS,
      );
      deadline.unref?.();
      signal.addEventListener('abort', abandon, { once: true });
      this.pendingApprovals.set(approvalId, {
        toolUseId,
        alwaysKey,
        resolve: finish,
      });
      this.send({
        t: 'permission',
        id: approvalId,
        toolUseId,
        name: display.name,
        title: antigravityApprovalTitle(classified, display),
        input: display.input,
      });
      if (signal.aborted) abandon();
    });
  }

  private onPermissionReply(msg: { [key: string]: unknown }): void {
    const id = typeof msg.id === 'string' ? msg.id : '';
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    if (msg.allow === true) {
      if (msg.always === true) this.alwaysAllowed.add(pending.alwaysKey);
      pending.resolve({ decision: 'allow' });
    } else {
      pending.resolve({ decision: 'deny', reason: 'The reader declined this action.' });
    }
  }

  private denyPendingApprovals(reason: string): void {
    for (const pending of [...this.pendingApprovals.values()]) pending.resolve({ decision: 'deny', reason });
    this.pendingApprovals.clear();
  }

  // --- Events -------------------------------------------------------------

  private sendTurnError(message: string, cause?: unknown): void {
    // A model the runtime refuses (an entitlement or catalog change since the
    // list was read) must not fail every later turn: the next one runs on the
    // runtime default, as the picker now says.
    if (this.selectedModel && isModelSelectionError(message)) {
      this.selectedModel = undefined;
      this.send({
        t: 'models',
        models: this.models,
        ...(this.activeModel ? { activeModel: this.activeModel } : {}),
        fallback: 'That model could not be used; the next message uses the runtime default.',
      });
    }
    const event = agentTurnErrorEvent(message);
    if (event.failure?.kind === 'auth-expired') agentBootstrapCoordinator.requireSignIn('antigravity', message);
    this.send(event, cause);
  }

  private playSimulatedTurnFailure(kind: Exclude<AgentTurnFailureSimulation, 'none'>): void {
    const script = simulatedTurnFailureScript(kind);
    if (script.fatal) {
      this.finish(script.message);
      return;
    }
    this.send({ t: 'turn-start' });
    this.sendTurnError(script.message);
    this.send({ t: 'turn-end', isError: true });
  }

  private send(event: AgentServerEvent, cause?: unknown): void {
    if (this.closed) return;
    reportAgentRuntimeError('antigravity', event, this.ws, cause);
    if (this.ws.readyState !== 1 /* OPEN */) return;
    try { this.ws.send(JSON.stringify(event)); } catch { /* ws gone */ }
  }

  private finish(message?: string, cause?: unknown): void {
    if (this.closed) return;
    const event = agentSessionExitEvent(message);
    if (message && event.failure?.kind === 'auth-expired') agentBootstrapCoordinator.requireSignIn('antigravity', message);
    this.send(event, cause);
    this.dispose();
  }

  dispose(termination?: AgentSessionTermination): void {
    if (this.closed) return;
    markAgentDiagnosticClosing(this.ws, termination?.kind === 'scope-removed' ? 'scope_removed' : 'session_disposed');
    if (termination?.kind === 'scope-removed') {
      this.send({ t: 'exit', reason: 'scope-removed', folder: termination.folder });
    }
    if (this.busy && this.turn) this.recordTurn(this.turn);
    this.closed = true;
    this.busy = false;
    this.turn = null;
    if (this.interruptTimer) { clearTimeout(this.interruptTimer); this.interruptTimer = null; }
    unregisterAttributedAgentSession(this.attributionId);
    antigravitySessions.delete(this.attributionId);
    this.onDispose?.(this);
    this.denyPendingApprovals('This StashBase chat has ended.');
    const proc = this.proc;
    this.proc = null;
    if (proc) void retireAgentProcess(proc, termination?.kind === 'scope-removed' ? 'scope_removed' : 'session_closed').catch(() => {});
    try { this.ws.close(AGENT_SESSION_CLOSE.code, AGENT_SESSION_CLOSE.reason); } catch { /* already closed */ }
  }
}

export function antigravityAccessMode(value: unknown): AgentAccessMode {
  return (ANTIGRAVITY_ACCESS_MODES as readonly unknown[]).includes(value) ? value as AgentAccessMode : 'default';
}

function toolId(turn: TurnState, stepIndex: number): string {
  return `step-${turn.key}-${stepIndex}`;
}

function sameLaunch(a: AntigravityLaunch, b: AntigravityLaunch): boolean {
  return a.mode === b.mode && a.model === b.model && a.effort === b.effort;
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  if (!firstLine) return '';
  const compact = firstLine.replace(/\s+/g, ' ');
  return compact.length > 60 ? `${compact.slice(0, 60).trimEnd()}…` : compact;
}

function isModelSelectionError(message: string): boolean {
  return /\bmodel\b/i.test(message)
    && /(unknown|unavailable|not available|not found|unsupported|invalid|not permitted|does not exist)/i.test(message);
}

function lastLines(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join('\n').slice(-1_000);
}

/** Where a chat's model list comes from: what the runtime listing remembers,
 * and a read of `agy` itself. */
export interface AntigravityCatalogSource {
  remembered(): AgentModel[];
  fresh(): Promise<AgentModel[]>;
}

/** Chats opened within a minute of each other share one `agy` read. */
const CATALOG_REFRESH_MS = 60_000;

const rememberedThenFreshCatalog: AntigravityCatalogSource = {
  remembered: () => recallAgentModels('antigravity')?.models ?? [],
  fresh: async () => (await ensureAgentModelCatalog('antigravity', { maxAgeMs: CATALOG_REFRESH_MS }))?.models ?? [],
};

const sessions = liveSessionSet<AntigravitySession>();
const antigravitySessions = new Map<string, AntigravitySession>();

/** The live Antigravity chat a hook request names by its attribution id. */
export function antigravitySessionForHook(attributionId: string | null | undefined): AntigravitySession | null {
  return typeof attributionId === 'string' ? antigravitySessions.get(attributionId.trim()) ?? null : null;
}

export function attachAntigravityWebSocket(ws: WebSocket, options: AgentConnectionOptions): void {
  const session = new AntigravitySession(
    ws, options.windowId, options.effort, options.resume, options.access, options.model, options.folder,
    (s) => sessions.delete(s),
  );
  session.persona = options.persona;
  sessions.add(session);
  session.begin();
}

/** Kill live Antigravity sessions (optionally for one window). */
export const killActiveAntigravity = sessions.killWindow;

/** Kill the live Antigravity sessions bound to one member folder. */
export const killAntigravitySessionsForFolder = sessions.killFolder;
