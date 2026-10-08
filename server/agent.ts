/**
 * Structured-agent sidecar. Where `terminal.ts` bridges a raw PTY to an
 * xterm, this bridges the **Claude Agent SDK** to a WebSocket as a
 * stream of structured panel events (text / thinking / tool calls /
 * permission prompts), so the renderer can paint a VSCode-style chat
 * panel instead of a terminal. One session per chat tab. Every session
 * is pinned to its project at connection time. Navigation preserves it;
 * window close, project removal, and app quit retire it.
 *
 * Auth: the SDK reads the same credential store the user's `claude`
 * login populated (Keychain / `~/.claude`), so a Pro/Max subscription
 * works with no API key.
 *
 * Wire protocol (line-delimited JSON over one ws):
 *   client → server:
 *     { t: "prompt", text }
 *     { t: "permission-reply", id, allow, always?, answers? }  // answers = clarifying-question replies
 *     { t: "set-model", model? }                      // next-turn model where supported
 *     { t: "set-mode", mode }                           // switch permission mode live
 *     { t: "interrupt" }
 *     { t: "close" }
 *   server → client:
 *     { t: "ready" }                                   // SDK session up
 *     { t: "session-id", id }                          // SDK session_id (for history/resume)
 *     { t: "turn-start" }                              // prompt accepted
 *     { t: "text", delta }                             // streaming assistant text
 *     { t: "thinking", delta }                         // streaming thinking
 *     { t: "tool", id, name, input }                   // tool call began
 *     { t: "tool-result", id, content, isError }       // its result
 *     { t: "permission", id, toolUseId, name, title, input }  // needs approve/reject
 *     { t: "turn-end", isError }                       // result message
 *     { t: "error", message, failure? }                // failure = classified turn-failure kind
 *     { t: "exit", message? }                          // normal or fatal session end
 */
import { isStashbaseWorkspaceEdit } from './agent-file-permissions.ts';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { filesystemPath } from './filesystem-path.ts';
import type { WebSocket } from 'ws';
import {
  getSessionInfo,
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
  type PermissionMode,
  type EffortLevel,
  type SpawnOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { logger, errorMessage } from './log.ts';
import { getCurrentFolder, registeredRootForAbs, runWithWindowId } from './folder.ts';
import { resolveAgentRuntimeInstructions } from './agent-runtime-instructions.ts';
import { agentCliEnv, agentCliNeedsShell, commandDir, resolveAgentCli } from './agent-cli.ts';
import { ensureClaudeFolderTrust } from './agent-rules.ts';
import { disposeSessionsBoundToFolder, isAgentAccessMode, resolveSessionBinding, type AgentAccessMode, type AgentSessionTermination } from './agent-contract.ts';
import { rememberAgentDefaultModel, rememberAgentModels } from './agent-model-catalog.ts';
import { claudeCatalog, readClaudeUserSettings } from './claude-model-catalog.ts';
import type { AgentClientEvent, AgentModel, AgentServerEvent, AgentSkill } from './agent-contract.ts';
import {
  registerAttributedAgentSession,
  unregisterAttributedAgentSession,
  type AttributedAgentSession,
} from './agent-session-registry.ts';
import {
  consumeAgentTurnFailure,
  simulatedTurnFailureScript,
  type AgentTurnFailureSimulation,
} from './agent-runtime-paths.ts';
import { agentTurnErrorEvent } from './agent-turn-failure.ts';
import { detectViewerFormat } from './format.ts';
import { currentPreparedTextPathAsync } from './conversion-dispatch.ts';

type ClaudeSkillCommand = { name: string; description: string; argumentHint: string };
type ClaudeResultMessage = Extract<SDKMessage, { type: 'result' }>;

export function claudeSkillCatalogEvent(commands: readonly ClaudeSkillCommand[]): Extract<AgentServerEvent, { t: 'skills' }> {
  const skills: AgentSkill[] = commands.filter((command) => Boolean(command.name)).map((command) => ({ id: command.name, label: command.name, ...(command.description ? { description: command.description } : {}), ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}) }));
  return { t: 'skills', skills, state: skills.length ? 'available' : 'empty' };
}

export function claudeSkillPrompt(body: string, skill?: string): string {
  return skill ? `/${skill}${body.trim() ? ` ${body}` : ''}` : body;
}

const log = logger('agent');

function resolveClaudeBinary(): string | null {
  return resolveAgentCli({
    name: 'claude',
    envNames: ['STASHBASE_CLAUDE_BIN', 'CLAUDE_CODE_BIN'],
    logLabel: 'Claude',
  }, (message) => log.warn(message));
}

function missingClaudeMessage(): string {
  return 'Claude CLI not found. Install Claude or set STASHBASE_CLAUDE_BIN to the claude executable.';
}

/** Map the Shared Agent Contract's Access value to the native Claude SDK
 * permission mode. Keep the validation at this adapter boundary so callers
 * cannot turn an arbitrary WebSocket query value into a native setting. */
export function claudePermissionMode(access?: string): AgentAccessMode {
  return isAgentAccessMode(access) ? access : 'default';
}

/** Validate and apply a requested model at the SDK boundary. The caller must
 * still wait for the SDK init event before presenting it as the active model.
 * With nothing requested the runtime is left alone: it starts on the model the
 * user's own Claude settings name, and the SDK's `setModel(undefined)` does
 * not keep that but replaces it with the CLI's built-in default. */
export async function selectClaudeModel(
  requested: string | undefined,
  models: AgentModel[],
  setModel: (model: string) => Promise<void>,
  resume: boolean,
): Promise<{ fallback?: string }> {
  if (resume || !requested) return {};
  if (!models.some((entry) => entry.id === requested)) return { fallback: 'That model is no longer available; using the runtime default.' };
  try {
    await setModel(requested);
    return {};
  } catch (err: unknown) {
    return { fallback: 'That model could not be selected; using the runtime default.' };
  }
}

/** A model id without the context-window suffix the CLI's aliases carry
 * (`opus[1m]`) and its reported release names may drop. */
function claudeModelBaseName(id: string): string {
  return id.replace(/\[[^\]]*\]$/, '');
}

/** The catalog entry the runtime's reported model names. The init event
 * carries a resolved release name (`claude-fable-5-1`) where the catalog lists
 * aliases and context variants (`claude-fable-5-1[1m]`), so an exact id wins,
 * then the same name without its suffix; a name the catalog cannot place
 * stays visible under its own id. */
export function claudeActiveModelEvent(models: AgentModel[], reported: string): Extract<AgentServerEvent, { t: 'models' }> {
  const listed =
    models.find((entry) => entry.id === reported) ??
    models.find((entry) => claudeModelBaseName(entry.id) === claudeModelBaseName(reported));
  return {
    t: 'models',
    models: listed ? models : [...models, { id: reported, label: reported }],
    activeModel: listed?.id ?? reported,
  };
}

export function claudeModelCatalogFailureEvent(
  requested: string | undefined,
  resume: boolean,
): Extract<AgentServerEvent, { t: 'models' }> {
  return {
    t: 'models',
    models: [],
    ...(requested && !resume
      ? { fallback: 'This Claude runtime cannot verify that model; using the runtime default.' }
      : {}),
  };
}

function spawnClaudeCodeProcess(options: SpawnOptions): SpawnedProcess {
  const command = resolveClaudeBinary() ?? options.command;
  if (command !== options.command) {
    log.info(`spawning Claude via ${command}`);
  }
  return spawn(command, options.args, {
    cwd: options.cwd,
    env: agentCliEnv(options.env as NodeJS.ProcessEnv, [commandDir(command)]),
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: options.signal,
    shell: agentCliNeedsShell(command),
  });
}

const LOW_RISK_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'ToolSearch',
  'ListMcpResourcesTool', 'ReadMcpResourceTool',
  ...['list_projects', 'list_directory', 'read_file', 'search_project', 'reindex']
    .map((name) => `mcp__stashbase__${name}`),
]);

function needsPrompt(name: string): boolean {
  return !LOW_RISK_TOOLS.has(name);
}

/** The SDK's clarifying-question tool: its `canUseTool` round trip is how the
 *  reader's answers reach the model. */
const QUESTION_TOOL = 'AskUserQuestion';

/** Answers ride the allow reply as the question tool's updated input, keyed
 *  by question text the way the SDK reads them. Only that tool takes them;
 *  a reply carrying answers for any other tool runs it on its original input. */
function answeredInput(p: Pending, answers: unknown): Record<string, unknown> {
  if (p.name !== QUESTION_TOOL || !answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return p.input;
  }
  return { ...p.input, answers };
}

type AgentReadableDerivedFormat = 'pdf' | 'docx';

function agentReadableDerivedFormat(format: string | null): AgentReadableDerivedFormat | null {
  return format === 'pdf' || format === 'docx' ? format : null;
}

function nativeReadPath(input: Record<string, unknown>, cwd: string): string | null {
  const raw = typeof input.file_path === 'string'
    ? input.file_path
    : typeof input.path === 'string'
      ? input.path
      : '';
  if (!raw.trim()) return null;
  try {
    return filesystemPath.absolute(raw.trim(), cwd);
  } catch {
    return null;
  }
}

async function nativeDerivedReadRedirect(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  alreadyRedirected: Set<string>,
): Promise<PermissionResult | null> {
  if (name !== 'Read') return null;
  const abs = nativeReadPath(input, cwd);
  if (!abs || filesystemPath.relative(cwd, abs) == null) return null;
  const folderRoot = registeredRootForAbs(abs);
  if (!folderRoot) return null;
  const rel = filesystemPath.relative(folderRoot, abs);
  if (!rel) return null;
  const sourceFormat = agentReadableDerivedFormat(detectViewerFormat(rel));
  if (!sourceFormat || !await currentPreparedTextPathAsync(abs)) return null;
  const key = filesystemPath.identity(abs);
  if (alreadyRedirected.has(key)) return null;
  alreadyRedirected.add(key);
  const textKind = sourceFormat === 'docx'
    ? 'derived HTML'
      : 'extracted Markdown';
  return {
    behavior: 'deny',
    message: `StashBase has ${textKind} ready for this ${sourceFormat.toUpperCase()}. Use mcp__stashbase__read_file with {"path":"${abs}"} to read that Agent-readable text. Use native Read only if you specifically need the original source file.`,
  };
}

/** Minimal pushable async-iterable — the streaming-input channel the SDK
 *  consumes. We `push()` a user message per prompt; the generator the SDK
 *  awaits yields them as they arrive, and stays open (so the session is
 *  long-lived) until `end()`. */
class Pushable<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(v: T): void {
    const r = this.resolvers.shift();
    if (r) r({ value: v, done: false });
    else this.values.push(v);
  }

  end(): void {
    this.done = true;
    let r: ((r: IteratorResult<T>) => void) | undefined;
    while ((r = this.resolvers.shift())) r({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift() as T, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

interface Pending {
  resolve: (r: PermissionResult) => void;
  name: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  cleanup?: () => void;
}

/** One live Agent-SDK session bridged to one WebSocket. */
export class AgentSession implements AttributedAgentSession {
  private input = new Pushable<SDKUserMessage>();
  private q: Query | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private turnActive = false;
  private turnGeneration = 0;
  private nativeSessionStateSeen = false;
  private pendingResult: ClaudeResultMessage | null = null;
  private interruptRequested = false;
  private interruptTask: Promise<void> | null = null;
  private nativeDerivedReadRedirected = new Set<string>();
  /** The SDK session_id, captured from the init message. Sent to the
   *  client so the history dropdown can mark this session active. */
  private sessionId: string | null = null;
  /** The folder this session is bound to, captured at start. */
  private cwd: string | null = null;
  /** The library persona this Chat runs under, read when the native
   *  session starts. */
  persona: string | undefined;
  private models: AgentModel[] = [];
  /** Whether publishModels has run, so a model picked earlier is held for it
   *  rather than refused against a catalog that is not read yet. */
  private catalogPublished = false;
  private skills = new Set<string>();
  private pumpTask: Promise<void> | null = null;
  private retirementTask: Promise<void> | null = null;

  constructor(
    private ws: WebSocket,
    windowId: string,
    private effort?: EffortLevel,
    private resume?: string,
    private access: PermissionMode = 'default',
    private model?: string,
    private onDispose?: (session: AgentSession, retirement: Promise<void>) => void,
    private queryFactory: typeof query = query,
    private resolveBinary: () => string | null = resolveClaudeBinary,
    private resumeBelongsToFolder: typeof resumeMatchesCwd = resumeMatchesCwd,
    /** Explicit, membership-validated session folder. Undefined with no
     *  follows the window folder before startup. */
    private folder?: string,
  ) {
    this.windowId = normalizeAgentWindowId(windowId);
    registerAttributedAgentSession(this.attributionId, this);
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
  }

  readonly windowId: string;
  readonly agentId = 'claude' as const;
  /** Private per-session attribution id. Rides the session env
   *  (`STASHBASE_AGENT_SESSION_ID`) → stdio MCP host → request header, so
   *  host-side MCP tools can find the live calling session. */
  readonly attributionId = randomUUID();

  /** The project pinned at startup, or its explicit connection-time folder. */
  boundFolder(): string | null {
    return this.cwd ?? this.folder ?? null;
  }

  turnInFlight(): boolean {
    return this.turnActive;
  }

  get isClosed(): boolean { return this.closed; }
  retirement(): Promise<void> {
    return this.retirementTask ?? Promise.resolve();
  }

  begin(beforeNativeStart?: () => Promise<boolean>): void {
    runWithWindowId(this.windowId, () => { void this.start(beforeNativeStart); });
  }

  private async start(beforeNativeStart?: () => Promise<boolean>): Promise<void> {
    if (this.closed) return;
    let cwd: string;
    try { cwd = resolveSessionBinding({ folder: this.folder, currentFolder: getCurrentFolder() }).cwd; }
    catch (error) { this.finish(errorMessage(error)); return; }
    this.cwd = cwd;
    if (this.closed) return;
    if (this.resume && !(await this.resumeBelongsToFolder(this.resume, cwd))) {
      if (this.closed) return;
      this.finish('That session belongs to a different folder.');
      return;
    }
    if (this.closed) return;
    if (beforeNativeStart) {
      let mayStart = false;
      try { mayStart = await beforeNativeStart(); }
      catch (err: unknown) {
        this.finish(errorMessage(err));
        return;
      }
      if (!mayStart || this.closed) return;
      // Legacy clients inherit the window folder at connect time, so a
      // folder switch during ownership handoff invalidates that start.
      // Explicit project scopes are pinned independently of later
      // window navigation and must survive it.
      if (!this.folder) {
        const activeFolder = getCurrentFolder();
        if (!activeFolder || !filesystemPath.equal(activeFolder, cwd)) {
          this.finish('The folder changed before the session started.');
          return;
        }
      }
    }
    const claudeCodeExecutable = this.resolveBinary();
    if (!claudeCodeExecutable) {
      this.finish(missingClaudeMessage());
      return;
    }
    // Pre-accept Claude's folder-trust gate for the session cwd (project
    // sessions run in the folder home — same gate). Without this a NEW
    // folder's headless session hangs at "working" with no visible prompt.
    ensureClaudeFolderTrust(cwd);
    try {
      this.q = this.createNativeQuery(cwd, this.resume, claudeCodeExecutable);
    } catch (err: unknown) {

      this.finish(errorMessage(err));
      return;
    }
    if (this.closed) {
      void this.q?.interrupt().catch(() => { /* already disposed */ });
      return;
    }
    await this.publishModels();
    await this.publishSkills();
    this.send({ t: 'ready' });
    this.pumpTask = this.pump(this.q);
  }

  private createNativeQuery(
    cwd: string,
    resume: string | undefined,
    claudeCodeExecutable: string,
  ): Query {
    return this.queryFactory({
        prompt: this.input,
        options: {
          cwd,
          includePartialMessages: true,
          // Apply the shared Access choice when the native session starts.
          // Later changes still use the SDK's live setPermissionMode API.
          permissionMode: this.access,
          // Project documents use StashBase transactions and their version checks.
          disallowedTools: ['Edit', 'MultiEdit', 'Write'],
          // Preserve Claude's native preset, then append the Chat's chosen
          // Persona plus StashBase's internal project routing policy. The
          // policy is never stored in the Persona.
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: resolveAgentRuntimeInstructions(this.persona),
          },
          // Resuming a past session loads its conversation history so the
          // user can continue it. The transcript itself is rendered from
          // getSessionMessages on the client; `resume` only primes the SDK
          // to append to the same session_id rather than start a new one.
          ...(resume ? { resume } : {}),
          // Thinking depth (low … max). The SDK has no live setter for this
          // (unlike permissionMode), so it's fixed for the session's lifetime
          // — the renderer reconnects to change it. Omit → SDK default ('high').
          ...(this.effort ? { effort: this.effort } : {}),
          // Packaged builds may not include the SDK's optional native binary.
          // Point the SDK at the user's installed CLI before it tries its own
          // optional dependency lookup, then keep a repaired PATH for wrappers
          // that use `/usr/bin/env node`.
          pathToClaudeCodeExecutable: claudeCodeExecutable,
          // Load the user's global config + the folder's project/local
          // settings so the panel sees the same CLAUDE.md, skills, and
          // MCP servers the terminal Claude does (incl. StashBase's project
          // MCP wired into ~/.claude.json). Without this the SDK runs
          // bare — no project context, no MCP.
          settingSources: ['user', 'project', 'local'],
          env: {
            ...agentCliEnv({}, [commandDir(claudeCodeExecutable)]),
            // A result can precede background-agent completion. Ask the CLI
            // for its authoritative idle transition after all continuations.
            CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
            // Route this session's MCP tools back to this window's host.
            STASHBASE_WINDOW_ID: this.windowId,
            // Session identity for host-side MCP tools (create_project):
            // request attribution only, never a path-resolution channel.
            STASHBASE_AGENT_SESSION_ID: this.attributionId,
          } as NodeJS.ProcessEnv,
          spawnClaudeCodeProcess,
          canUseTool: (name, input, opts) => this.onPermission(name, input, opts),
          stderr: (d: string) => log.debug(d),
        },
      });
  }

  /** Ask the SDK rather than encoding Claude aliases or release names here.
   * Do this before `ready`, so a fresh session cannot race its first prompt
   * ahead of the requested model. A resumed transcript always stays native. */
  private async publishModels(): Promise<void> {
    if (!this.q) return;
    try {
      const available = await this.q.supportedModels();
      // The same reading the runtime listing makes: the CLI's own settings
      // name the default model and effort the handshake leaves unsaid.
      const reading = claudeCatalog(available, readClaudeUserSettings());
      this.models = reading.models;
      rememberAgentModels('claude', this.models);
      if (reading.defaultModel) rememberAgentDefaultModel('claude', reading.defaultModel);
      const selection = await selectClaudeModel(this.model, this.models, (model) => this.q!.setModel(model), Boolean(this.resume));
      // A refused choice is not this session's model: the init event then
      // names what the runtime runs, and the memory may learn it as the default.
      if (selection.fallback) this.model = undefined;
      // A resume is intentionally never reconfigured, even if a stale UI
      // parameter appears on the URL. It preserves the runtime's session model.
      this.send({ t: 'models', models: this.models, ...(selection.fallback ? { fallback: selection.fallback } : {}) });
    } catch (err: unknown) {
      // Catalog discovery is optional runtime capability. The chat remains
      // usable on older CLIs, with their configured default untouched.
      this.send(claudeModelCatalogFailureEvent(this.model, Boolean(this.resume)));
      log.debug(`could not discover Claude models: ${errorMessage(err)}`);
    } finally {
      this.catalogPublished = true;
    }
  }

  private async publishSkills(): Promise<void> {
    if (!this.q) return;
    try { this.publishSkillCommands(await this.q.supportedCommands()); }
    catch { this.skills.clear(); this.send({ t: 'skills', skills: [], state: 'failed', error: 'Could not load skills. Try again.' }); }
  }
  private publishSkillCommands(commands: Array<{ name: string; description: string; argumentHint: string }>): void {
    this.skills = new Set(commands.map((command) => command.name).filter(Boolean));
    this.send(claudeSkillCatalogEvent(commands));
  }

  /** Drain the SDK message stream until it ends or errors. */
  private async pump(query: Query): Promise<void> {
    let failure: string | undefined;
    try {
      for await (const msg of query) this.onSdkMessage(msg);
      if (!this.closed) failure = 'Claude session ended unexpectedly.';
    } catch (err: unknown) {
      if (!this.closed && query === this.q) {

        failure = errorMessage(err);
      }
    }
    if (query !== this.q) return;
    this.finish(failure);
  }

  private onSdkMessage(msg: SDKMessage): void {
    // Every SDK message carries the session_id; capture + surface it the
    // first time we see one (the init `system` message) so the history
    // dropdown can mark the live session active and resume targets it.
    const sid = (msg as { session_id?: unknown }).session_id;
    if (!this.sessionId && typeof sid === 'string' && sid) {
      this.sessionId = sid;
      nativeOwnership.register(sid, this);
      this.send({ t: 'session-id', id: sid });
    }
    if (msg.type === 'system' && msg.subtype === 'init' && msg.model) {
      // With nothing chosen, the model the SDK started is the runtime's own
      // default, which its catalog does not flag.
      const active = claudeActiveModelEvent(this.models, msg.model);
      if (!this.model) rememberAgentDefaultModel('claude', active.activeModel ?? msg.model);
      this.send(active);
    }
    if (msg.type === 'system' && msg.subtype === 'commands_changed') this.publishSkillCommands(msg.commands);
    if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
      this.nativeSessionStateSeen = true;
      if (msg.state === 'idle' && this.pendingResult) {
        const result = this.pendingResult;
        this.pendingResult = null;
        this.completeClaudeTurn(result);
      }
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'api_retry') {
      log.info(`Claude SDK is retrying: attempt ${msg.attempt} of ${msg.max_retries} (delay ${msg.retry_delay_ms}ms)`);
      return;
    }
    switch (msg.type) {
      case 'stream_event': {
        // Partial deltas → typewriter streaming for text + thinking.
        const ev = msg.event as { type: string; delta?: { type: string; text?: string; thinking?: string } };
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && ev.delta.text) {
            this.send({ t: 'text', delta: ev.delta.text });
          } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
            this.send({ t: 'thinking', delta: ev.delta.thinking });
          }
        }
        break;
      }
      case 'assistant': {
        // Text/thinking already streamed via stream_event; here we only
        // surface the complete tool_use blocks (which carry the id we
        // match tool-result + permission against).
        const content = (msg.message.content ?? []) as unknown as Array<Record<string, unknown>>;
        for (const block of content) {
          if (block.type === 'tool_use') {
            this.send({
              t: 'tool', id: String(block.id ?? ''), name: String(block.name ?? ''),
              input: (block.input as Record<string, unknown>) ?? {},
            });
          }
        }
        break;
      }
      case 'user': {
        // Tool results come back as a user-role message of tool_result blocks.
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content as unknown as Array<Record<string, unknown>>) {
            if (block.type === 'tool_result') {
              this.send({
                t: 'tool-result',
                id: String(block.tool_use_id ?? ''),
                content: stringifyToolResult(block.content),
                isError: block.is_error === true,
              });
            }
          }
        }
        break;
      }
      case 'result': {
        if (!this.turnActive) break;
        // Streaming input stays open across turns. Claude can emit a success
        // result while a subagent still runs, then another for its continuation.
        // CLIs that do not publish session state retain their result boundary.
        if (this.nativeSessionStateSeen) this.pendingResult = msg;
        else this.completeClaudeTurn(msg);
        break;
      }
      default:
        break;
    }
  }

  private completeClaudeTurn(msg: ClaudeResultMessage): void {
    const pendingInterrupt = this.interruptTask;
    if (pendingInterrupt) {
      const resultGeneration = this.turnGeneration;
      void pendingInterrupt.then(() => {
        if (!this.closed && this.turnGeneration === resultGeneration) this.onClaudeResult(msg);
      });
    } else {
      this.onClaudeResult(msg);
    }
  }

  private onClaudeResult(msg: ClaudeResultMessage): void {
    // Idle (or result for a CLI without state events) closes one active turn.
    // Ignore duplicate or late terminal messages before they can append another
    // persistent error or settle a queued follow-up twice.
    if (!this.turnActive) return;
    const isError = msg.is_error === true;
    const wasCancelled = this.interruptRequested;
    this.turnActive = false;
    this.pendingResult = null;
    this.interruptRequested = false;
    this.interruptTask = null;

    if (isError && !wasCancelled) {
      const errorsField = (msg as { errors?: unknown }).errors;
      const rawErrors = Array.isArray(errorsField)
        ? errorsField.flatMap((entry: unknown) => {
            if (typeof entry !== 'string') return [];
            const trimmed = entry.trim();
            return trimmed ? [trimmed] : [];
          })
        : [];

      const uniqueErrors = Array.from(new Set(rawErrors));
      let finalMessage = '';

      if (uniqueErrors.length > 0) {
        finalMessage = uniqueErrors.join('; ');
        if (finalMessage.length > 2000) {
          finalMessage = finalMessage.slice(0, 2000);
        }
      } else {
        // A signed-out or API-refused run reports `is_error` with NO errors
        // array and a non-error subtype ('success'): the only provider text
        // is the `result` string (e.g. "Not logged in · Please run /login").
        // Surface it so classification can name the real recovery instead of
        // the generic fallback.
        const resultText = typeof (msg as { result?: unknown }).result === 'string'
          ? ((msg as { result: string }).result).trim()
          : '';
        const subtype = msg.subtype;
        if (subtype === 'error_max_turns') {
          finalMessage = 'Claude stopped after reaching the maximum number of turns.';
        } else if (subtype === 'error_max_budget_usd') {
          finalMessage = 'Claude stopped after reaching the configured budget.';
        } else if (subtype === 'error_max_structured_output_retries') {
          finalMessage = 'Claude could not produce the requested structured response.';
        } else if (resultText) {
          finalMessage = resultText.slice(0, 2000);
        } else {
          finalMessage = 'Claude failed before completing the turn.';
        }
      }

      if (finalMessage) {
        this.sendTurnError(finalMessage);
      }
    }

    this.send({ t: 'turn-end', isError: isError && !wasCancelled });
  }

  /** SDK permission callback. Auto-allow reads; round-trip writes/exec to
   *  the client and await the user's approve/reject. */
  private async onPermission(
    name: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID: string; title?: string },
  ): Promise<PermissionResult> {
    // Use the session's bound folder, not the window's possibly-different
    // current folder — the redirect must reflect the cwd the agent runs in.
    const cwd = this.cwd ?? getCurrentFolder();
    if (cwd) {
      const redirect = await nativeDerivedReadRedirect(name, input, cwd, this.nativeDerivedReadRedirected);
      if (redirect) return redirect;
    }
    if (opts.signal.aborted || this.closed) return { behavior: 'deny', message: 'Interrupted.' };
    const projectEdit = name.startsWith('mcp__stashbase__') && isStashbaseWorkspaceEdit({
      input: { server: 'stashbase', tool: name.slice('mcp__stashbase__'.length), arguments: input },
    }, cwd ?? null);
    if (!needsPrompt(name) || (this.access === 'acceptEdits' && projectEdit)) {
      return { behavior: 'allow', updatedInput: input };
    }
    return new Promise<PermissionResult>((resolve) => {
      const id = randomUUID();
      const onAbort = () => {
        const p = this.pending.get(id);
        if (!p) return;
        p.cleanup?.();
        if (this.pending.delete(id)) resolve({ behavior: 'deny', message: 'Interrupted.' });
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve,
        name,
        input,
        suggestions: opts.suggestions,
        cleanup: () => opts.signal.removeEventListener('abort', onAbort),
      });
      this.send({ t: 'permission', id, toolUseId: opts.toolUseID, name, title: opts.title ?? null, input });
    });
  }

  private enqueuePrompt(body: string, skill?: string): void {
    this.input.push({
      type: 'user',
      message: { role: 'user', content: claudeSkillPrompt(body, skill) },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  private onMessage(text: string): void {
    let msg: AgentClientEvent;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg.t) {
      case 'prompt': {
        const body = typeof msg.text === 'string' ? msg.text : '';
        const skill = typeof msg.skill === 'string' ? msg.skill : undefined;
        if (skill && !this.skills.has(skill)) { this.send({ t: 'error', message: 'That skill is no longer available. Type / to choose another.' }); return; }
        if (!body.trim() && !skill) return;
        // The renderer queues follow-ups and sends them only after the active
        // terminal event. Refuse an out-of-contract concurrent prompt rather
        // than letting one SDK result settle the wrong turn.
        if (this.turnActive) return;
        {
          const simulated = consumeAgentTurnFailure();
          if (simulated) { this.playSimulatedTurnFailure(simulated); break; }
        }
        this.turnActive = true;
        this.pendingResult = null;
        this.turnGeneration += 1;
        this.interruptRequested = false;
        this.send({ t: 'turn-start' });
        this.enqueuePrompt(body, skill);
        break;
      }
      case 'refresh-skills': void this.publishSkills(); break;
      case 'permission-reply': {
        const id = typeof msg.id === 'string' ? msg.id : '';
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.cleanup?.();
        if (msg.allow) {
          p.resolve({
            behavior: 'allow',
            updatedInput: answeredInput(p, msg.answers),
            ...(msg.always && p.suggestions ? { updatedPermissions: p.suggestions } : {}),
          });
        } else {
          p.resolve({ behavior: 'deny', message: 'User rejected this action.' });
        }
        break;
      }
      case 'set-mode': {
        // Live permission-mode switch from the composer's Modes dropdown.
        // 'default' = ask before edits, 'acceptEdits' = auto-apply edits
        // (Bash still prompts via canUseTool), 'plan' = read-only planning,
        // 'auto' = model classifier decides. We don't expose the dangerous
        // 'bypassPermissions' / 'dontAsk'.
        if (isAgentAccessMode(msg.mode)) {
          this.access = msg.mode;
          void this.q?.setPermissionMode(msg.mode).catch((err) => log.debug(errorMessage(err)));
        }
        break;
      }
      case 'set-model': {
        // Claude can change the model only before a fresh conversation has
        // content. Resumed/populated sessions keep their native model.
        if (this.turnActive || this.resume) break;
        const requested = typeof msg.model === 'string' && msg.model ? msg.model : undefined;
        // A pick made while the runtime is still starting waits for
        // publishModels, which applies it against the catalog before `ready`.
        // Refusing it against a catalog not read yet would drop the choice.
        if (!this.q || !this.catalogPublished) {
          this.model = requested;
          break;
        }
        void selectClaudeModel(requested, this.models, (model) => this.q!.setModel(model), false)
          .then(({ fallback }) => {
            if (this.closed) return;
            if (fallback) {
              this.send({
                t: 'models',
                models: this.models,
                fallback,
              });
              return;
            }
            this.model = requested;
            this.send({
              t: 'models',
              models: this.models,
              ...(requested ? { activeModel: requested } : {}),
            });
          });
        break;
      }
      case 'interrupt': {
        if (!this.turnActive || !this.q || this.interruptRequested) break;
        const interruptedGeneration = this.turnGeneration;
        let nativeInterrupt: Promise<void>;
        try {
          nativeInterrupt = this.q.interrupt();
        } catch (err: unknown) {
          log.debug(`Claude interrupt request failed: ${errorMessage(err)}`);
          break;
        }
        this.interruptRequested = true;
        const trackedInterrupt = nativeInterrupt.then(
          () => {
            if (this.interruptTask === trackedInterrupt) this.interruptTask = null;
          },
          (err: unknown) => {
            // A rejected native interrupt did not cancel the turn. Clear only
            // the matching active generation so a late rejection cannot alter
            // a later prompt's cancellation state.
            if (this.interruptTask === trackedInterrupt) this.interruptTask = null;
            if (this.turnActive && this.turnGeneration === interruptedGeneration) {
              this.interruptRequested = false;
            }
            log.debug(`Claude interrupt request failed: ${errorMessage(err)}`);
          },
        );
        this.interruptTask = trackedInterrupt;
        break;
      }
      case 'close':
        this.dispose();
        break;
    }
  }

  private send(obj: AgentServerEvent): void {
    if (this.ws.readyState !== 1 /* OPEN */) return;
    try { this.ws.send(JSON.stringify(obj)); } catch { /* ws gone */ }
  }

  /** Turn-scoped runtime errors carry their classified failure kind so the
   * renderer can offer the matching recovery without parsing the message. */
  private sendTurnError(message: string): void {
    this.send(agentTurnErrorEvent(message));
  }

  /** Development-only: play the armed turn-failure script through the normal
   * event path so the renderer exercises the real turn lifecycle. The prompt
   * never reaches the native runtime. */
  private playSimulatedTurnFailure(kind: Exclude<AgentTurnFailureSimulation, 'none'>): void {
    const script = simulatedTurnFailureScript(kind);
    if (script.fatal) {
      this.finish(script.message);
      return;
    }
    this.turnActive = true;
    this.turnGeneration += 1;
    this.interruptRequested = false;
    this.send({ t: 'turn-start' });
    this.turnActive = false;
    this.sendTurnError(script.message);
    this.send({ t: 'turn-end', isError: true });
  }

  private finish(message?: string): void {
    if (this.closed) return;
    this.send({ t: 'exit', ...(message ? { message } : {}) });
    this.dispose();
  }

  dispose(termination?: AgentSessionTermination): void {
    if (this.closed) return;
    if (termination?.kind === 'scope-removed') {
      this.send({ t: 'exit', reason: 'scope-removed', folder: termination.folder });
    }
    this.closed = true;
    unregisterAttributedAgentSession(this.attributionId);
    // Closing input prevents another prompt from entering this query. The
    // retirement task then waits beyond interrupt acknowledgement until the
    // SDK iterator/query has actually finished its process cleanup.
    this.input.end();
    this.retirementTask = this.retireNativeQuery();
    this.onDispose?.(this, this.retirementTask);
    // Resolve any dangling permission prompts so the SDK loop unwinds.
    for (const [, p] of this.pending) {
      p.cleanup?.();
      p.resolve({ behavior: 'deny', message: 'Session closed.' });
    }
    this.pending.clear();
    try { this.ws.close(); } catch { /* already closed */ }
  }

  private async retireNativeQuery(): Promise<void> {
    const query = this.q;
    if (!query) return;
    try { await query.interrupt(); } catch { /* continue through cleanup */ }
    if (this.pumpTask) {
      await this.pumpTask.catch(() => { /* pump already reported the cause */ });
    } else {
      // Disposal can race startup before pump begins. AsyncGenerator.return()
      // waits for the SDK query's generator-finally/process cleanup.
      try { await query.return(undefined); } catch { /* already gone */ }
    }
  }
}

export async function resumeMatchesCwd(sessionId: string, cwd: string): Promise<boolean> {
  try {
    const info = await getSessionInfo(sessionId);
    return sessionInfoMatchesCwd(info, cwd);
  } catch {
    return false;
  }
}

export function sessionInfoMatchesCwd(info: { cwd?: unknown } | null | undefined, cwd: string): boolean {
  return !!(info
    && typeof info.cwd === 'string'
    && info.cwd.trim()
    && filesystemPath.equal(info.cwd, cwd));
}

/** Stringify a tool_result `content` (string, or an array of text/other
 *  blocks) into something renderable. */
function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/** Live agent sessions — one per structured chat tab. Each is pinned to a
 *  member folder; a window-folder switch leaves them running. */
const sessions = new Set<AgentSession>();

/** Serializes ownership of one persisted Claude transcript. After folder
 * validation, active ownership is registered before a resumed query starts so
 * a reconnect cannot race ahead of the old WebSocket close event. */
export class ClaudeNativeSessionOwnership {
  private active = new Map<string, AgentSession>();
  private ownedIds = new Map<AgentSession, Set<string>>();
  private tails = new Map<string, Promise<void>>();

  register(id: string, session: AgentSession): void {
    if (!this.active.has(id)) this.claim(id, session);
  }

  async acquire(id: string, session: AgentSession): Promise<boolean> {
    const previousTail = this.tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const queued = previousTail.then(() => tail);
    this.tails.set(id, queued);
    await previousTail;
    try {
      if (session.isClosed) return false;
      const previous = this.active.get(id);
      if (previous && previous !== session) {
        previous.dispose();
        await previous.retirement();
      }
      if (session.isClosed) return false;
      this.claim(id, session);
      return true;
    } finally {
      release();
      if (this.tails.get(id) === queued) this.tails.delete(id);
    }
  }

  release(session: AgentSession): void {
    const ids = this.ownedIds.get(session);
    if (!ids) return;
    for (const id of ids) {
      if (this.active.get(id) === session) this.active.delete(id);
    }
    this.ownedIds.delete(session);
  }

  private claim(id: string, session: AgentSession): void {
    const previous = this.active.get(id);
    if (previous === session) return;
    if (previous) {
      const previousIds = this.ownedIds.get(previous);
      previousIds?.delete(id);
      if (previousIds?.size === 0) this.ownedIds.delete(previous);
    }
    this.active.set(id, session);
    const ids = this.ownedIds.get(session) ?? new Set<string>();
    ids.add(id);
    this.ownedIds.set(session, ids);
  }
}

const nativeOwnership = new ClaudeNativeSessionOwnership();

export function attachAgentWebSocket(
  ws: WebSocket,
  windowId = 'default',
  effort?: string,
  resume?: string,
  access?: AgentAccessMode,
  model?: string,
  folder?: string,
  persona?: string,
): void {
  const session = new AgentSession(
    ws,
    windowId,
    effort as EffortLevel | undefined,
    resume,
    claudePermissionMode(access),
    model,
    (s, retirement) => {
      sessions.delete(s);
      void retirement.finally(() => nativeOwnership.release(s));
    },
    undefined,
    undefined,
    undefined,
    folder,
  );
  session.persona = persona;
  sessions.add(session);
  if (resume) session.begin(() => nativeOwnership.acquire(resume, session));
  else session.begin();
}

/** Kill every live agent session (optionally for one window). Called on
 *  window close / retire and app shutdown — never on a folder switch;
 *  sessions are folder-bound and survive the window moving elsewhere. */
export function killActiveAgent(windowId?: string): void {
  for (const session of [...sessions]) {
    if (!windowId || session.windowId === windowId) {
      session.dispose();
      sessions.delete(session);
    }
  }
}

/** Kill the live agent sessions bound to one member folder, across all
 *  windows. Project removal calls this so a removed folder cannot
 *  keep running sessions. */
export function killAgentSessionsForFolder(folderAbs: string): void {
  disposeSessionsBoundToFolder(sessions, folderAbs);
}

function normalizeAgentWindowId(windowId: string | null | undefined): string {
  const raw = typeof windowId === 'string' ? windowId.trim() : '';
  return raw ? raw.slice(0, 128) : 'default';
}
