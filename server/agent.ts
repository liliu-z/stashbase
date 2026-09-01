/**
 * Structured-agent sidecar. Where `terminal.ts` bridges a raw PTY to an
 * xterm, this bridges the **Claude Agent SDK** to a WebSocket as a
 * stream of structured panel events (text / thinking / tool calls /
 * permission prompts), so the renderer can paint a VSCode-style chat
 * panel instead of a terminal. One session per chat tab. Every session
 * is pinned to an explicit scope at connect time — a member folder (its
 * cwd) or the whole library (cwd = the folder home) — so a window-folder
 * switch leaves it running. The one deliberate scope transition is an
 * attributed Library Chat creating a project; its next native prompt resumes
 * from that project cwd. Teardown happens on window close, library folder
 * removal (folder-bound sessions only), and app quit.
 *
 * Auth: the SDK reads the same credential store the user's `claude`
 * login populated (Keychain / `~/.claude`), so a Pro/Max subscription
 * works with no API key.
 *
 * Wire protocol (line-delimited JSON over one ws):
 *   client → server:
 *     { t: "prompt", text }
 *     { t: "permission-reply", id, allow, always? }
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
import { getCurrentFolder, getFolderHome, memberRootForAbs, runWithWindowId } from './folder.ts';
import { resolveAgentInstructions } from './agent-instructions.ts';
import { agentCliEnv, agentCliNeedsShell, commandDir, resolveAgentCli } from './agent-cli.ts';
import { ensureClaudeFolderTrust } from './agent-rules.ts';
import { disposeSessionsBoundToFolder, isAgentAccessMode, reportAgentRuntimeFailure, resolveSessionBinding, type AgentAccessMode, type AgentSessionTermination } from './agent-contract.ts';
import type { AgentClientEvent, AgentModel, AgentServerEvent, AgentSkill } from './agent-contract.ts';
import {
  registerAttributedAgentSession,
  unregisterAttributedAgentSession,
  type AttributedAgentSession,
} from './agent-session-registry.ts';
import { agentSessionFolderOverride } from './agent-session-folders.ts';
import {
  consumeAgentTurnFailure,
  simulatedTurnFailureScript,
  type AgentTurnFailureSimulation,
} from './agent-runtime-paths.ts';
import { agentTurnErrorEvent } from './agent-turn-failure.ts';
import { detectViewerFormat } from './format.ts';
import { isAgentReadableDerivedTextReady } from './library-file-reader.ts';

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
    logLabel: 'Claude Code',
  }, (message) => log.warn(message));
}

function missingClaudeMessage(): string {
  return 'Claude CLI not found. Install Claude Code or set STASHBASE_CLAUDE_BIN to the claude executable.';
}

/** Map the Shared Agent Contract's Access value to the native Claude SDK
 * permission mode. Keep the validation at this adapter boundary so callers
 * cannot turn an arbitrary WebSocket query value into a native setting. */
export function claudePermissionMode(access?: string): AgentAccessMode {
  return isAgentAccessMode(access) ? access : 'default';
}

/** Validate and apply a requested model at the SDK boundary. The caller must
 * still wait for the SDK init event before presenting it as the active model. */
export async function selectClaudeModel(
  requested: string | undefined,
  models: AgentModel[],
  setModel: (model?: string) => Promise<void>,
  resume: boolean,
): Promise<{ fallback?: string }> {
  if (resume) return {};
  const selected = requested && models.some((entry) => entry.id === requested) ? requested : undefined;
  if (requested && !selected) return { fallback: 'That model is no longer available; using the runtime default.' };
  try {
    await setModel(selected);
    return {};
  } catch (err: unknown) {
    return { fallback: 'That model could not be selected; using the runtime default.' };
  }
}

export function claudeActiveModelEvent(models: AgentModel[], activeModel: string): Extract<AgentServerEvent, { t: 'models' }> {
  return {
    t: 'models',
    models: models.some((entry) => entry.id === activeModel) ? models : [...models, { id: activeModel, label: activeModel }],
    activeModel,
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
    log.info(`spawning Claude Code via ${command}`);
  }
  return spawn(command, options.args, {
    cwd: options.cwd,
    env: agentCliEnv(options.env as NodeJS.ProcessEnv, [commandDir(command)]),
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: options.signal,
    shell: agentCliNeedsShell(command),
  });
}

/** Tools we run without prompting — reads, searches, listings. Anything
 *  that writes (Edit / Write / Bash / MCP mutations) falls through to a
 *  permission prompt so the user sees a diff and approves. Keeping the
 *  prompt set small is what makes the panel pleasant instead of a
 *  click-through wall. */
function needsPrompt(name: string): boolean {
  if (['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return true;
  // MCP mutations: mcp__stashbase__write_file / delete_file / rename_file / …
  if (/^mcp__/.test(name) && /(write|delete|rename|update|set_|create)/i.test(name)) return true;
  return false;
}

type AgentReadableDerivedFormat = 'pdf' | 'docx' | 'audio';

function agentReadableDerivedFormat(format: string | null): AgentReadableDerivedFormat | null {
  return format === 'pdf' || format === 'docx' || format === 'audio' ? format : null;
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

function nativeDerivedReadRedirect(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  alreadyRedirected: Set<string>,
): PermissionResult | null {
  if (name !== 'Read') return null;
  const abs = nativeReadPath(input, cwd);
  if (!abs) return null;
  const folderRoot = memberRootForAbs(abs);
  if (!folderRoot) return null;
  const rel = filesystemPath.relative(folderRoot, abs);
  if (!rel) return null;
  const sourceFormat = agentReadableDerivedFormat(detectViewerFormat(rel));
  if (!sourceFormat || !isAgentReadableDerivedTextReady(abs, sourceFormat)) return null;
  const key = filesystemPath.identity(abs);
  if (alreadyRedirected.has(key)) return null;
  alreadyRedirected.add(key);
  const textKind = sourceFormat === 'docx'
    ? 'derived HTML'
    : sourceFormat === 'audio'
      ? 'transcript Markdown'
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
  private interruptRequested = false;
  private interruptTask: Promise<void> | null = null;
  private nativeDerivedReadRedirected = new Set<string>();
  /** The SDK session_id, captured from the init message. Sent to the
   *  client so the history dropdown can mark this session active. */
  private sessionId: string | null = null;
  /** The folder this session is bound to, captured at start. */
  private cwd: string | null = null;
  /** True for a library-wide session: cwd is the folder home and the
   *  session is NOT bound to any member folder — member-folder removal
   *  never tears it down (window close / app quit still do). */
  private libraryScoped = false;
  /** Member folder this LIBRARY session was migrated to by `create_project`.
   *  The next prompt resumes the same native session from this cwd; binding,
   *  teardown scope, and history move immediately. */
  private rebound: string | null = null;
  private models: AgentModel[] = [];
  private skills = new Set<string>();
  private similaritySearch = true;
  private pumpTask: Promise<void> | null = null;
  private nativeMigrationTask: Promise<void> | null = null;
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
     *  library scope follows the window's current folder at connect time
     *  (legacy clients), else the library. */
    private folder?: string,
    /** Explicit library-wide scope (`scope=library` on the connect URL). */
    private scope?: 'library',
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

  /** The member folder this session is (or will be) bound to. `cwd` is the
   *  authoritative binding once the session started; before that, the
   *  explicit connect-time folder is the best answer. A library-scoped
   *  session is bound to no member folder and reports null — unless
   *  `create_project` rebound it to the new project. */
  boundFolder(): string | null {
    if (this.rebound) return this.rebound;
    if (this.libraryScoped || this.scope === 'library') return null;
    return this.cwd ?? this.folder ?? null;
  }

  turnInFlight(): boolean {
    return this.turnActive;
  }

  isLibraryScoped(): boolean {
    return !this.rebound && (this.libraryScoped || this.scope === 'library');
  }

  nativeSessionId(): string | null {
    return this.sessionId;
  }

  similaritySearchEnabled(): boolean {
    return this.similaritySearch;
  }

  /** Migrate this LIBRARY-scoped session to a member folder (create_project).
   *  The current turn finishes in the library process; the next prompt
   *  resumes the same native session from the project cwd. */
  rebindToFolder(folderAbs: string): boolean {
    if (this.closed || !this.isLibraryScoped()) return false;
    this.rebound = folderAbs;
    this.send({ t: 'scope-changed', scope: { kind: 'folder', path: folderAbs } });
    return true;
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
      // Explicit folder/library scopes are pinned independently of later
      // window navigation and must survive it.
      if (!this.folder && this.scope !== 'library') {
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
    // Pre-accept Claude's folder-trust gate for the session cwd (library
    // sessions run in the folder home — same gate). Without this a NEW
    // folder's headless session hangs at "working" with no visible prompt.
    ensureClaudeFolderTrust(cwd);
    try {
      this.q = this.createNativeQuery(cwd, this.resume, this.libraryScoped ? 'library' : 'folder', claudeCodeExecutable);
    } catch (err: unknown) {
      reportAgentRuntimeFailure('claude', err);
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
    scope: 'library' | 'folder',
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
          // Agent Instructions are the only StashBase-owned prompt. Preserve
          // Claude Code's native preset and append the resolved working-folder
          // text (or the packaged default for a Library Chat) without an
          // Adapter-specific preamble or wrapper.
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: resolveAgentInstructions(scope === 'library' ? null : cwd),
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
          // MCP servers the terminal Claude does (incl. StashBase's library
          // MCP wired into ~/.claude.json). Without this the SDK runs
          // bare — no project context, no MCP.
          settingSources: ['user', 'project', 'local'],
          env: {
            ...agentCliEnv({}, [commandDir(claudeCodeExecutable)]),
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
      this.models = available.map((entry) => ({
        id: entry.value,
        label: entry.displayName || entry.value,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.supportedEffortLevels ? { supportedEfforts: entry.supportedEffortLevels } : {}),
      }));
      const selection = await selectClaudeModel(this.model, this.models, (model) => this.q!.setModel(model), Boolean(this.resume));
      // A resume is intentionally never reconfigured, even if a stale UI
      // parameter appears on the URL. It preserves the runtime's session model.
      this.send({ t: 'models', models: this.models, ...(selection.fallback ? { fallback: selection.fallback } : {}) });
    } catch (err: unknown) {
      // Catalog discovery is optional runtime capability. The chat remains
      // usable on older CLIs, with their configured default untouched.
      this.send(claudeModelCatalogFailureEvent(this.model, Boolean(this.resume)));
      log.debug(`could not discover Claude models: ${errorMessage(err)}`);
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
        reportAgentRuntimeFailure('claude', err);
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
      this.send(claudeActiveModelEvent(this.models, msg.model));
    }
    if (msg.type === 'system' && msg.subtype === 'commands_changed') this.publishSkillCommands(msg.commands);
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
        const pendingInterrupt = this.interruptTask;
        if (pendingInterrupt) {
          const resultGeneration = this.turnGeneration;
          void pendingInterrupt.then(() => {
            if (this.turnGeneration === resultGeneration) this.onClaudeResult(msg);
          });
        } else {
          this.onClaudeResult(msg);
        }
        break;
      }
      default:
        break;
    }
  }

  private onClaudeResult(msg: ClaudeResultMessage): void {
    // The SDK result is terminal authority for one active turn. Ignore
    // duplicate or late terminal messages before they can append another
    // persistent error or settle a queued follow-up twice.
    if (!this.turnActive) return;
    const isError = msg.is_error === true;
    const wasCancelled = this.interruptRequested;
    this.turnActive = false;
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
  private onPermission(
    name: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID: string; title?: string },
  ): Promise<PermissionResult> {
    // Use the session's bound folder, not the window's possibly-different
    // current folder — the redirect must reflect the cwd the agent runs in.
    const cwd = this.cwd ?? getCurrentFolder();
    if (cwd) {
      const redirect = nativeDerivedReadRedirect(name, input, cwd, this.nativeDerivedReadRedirected);
      if (redirect) return Promise.resolve(redirect);
    }
    if (!needsPrompt(name)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
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

  private async migrateAndEnqueuePrompt(body: string, skill?: string): Promise<void> {
    try {
      const target = this.rebound;
      const resume = this.sessionId;
      if (!target || !resume) throw new Error('The project scope is not ready yet. Try again.');

      const previousQuery = this.q;
      const previousPump = this.pumpTask;
      this.q = null;
      this.pumpTask = null;
      this.input.end();
      if (previousPump) {
        await previousPump;
      } else if (previousQuery) {
        try { await previousQuery.return(undefined); } catch { /* already retired */ }
      }
      if (this.closed) return;

      const claudeCodeExecutable = this.resolveBinary();
      if (!claudeCodeExecutable) throw new Error(missingClaudeMessage());
      ensureClaudeFolderTrust(target);

      this.input = new Pushable<SDKUserMessage>();
      const nextQuery = this.createNativeQuery(target, resume, 'folder', claudeCodeExecutable);
      this.q = nextQuery;
      this.cwd = target;
      this.libraryScoped = false;
      await this.publishSkills();
      if (this.closed || this.q !== nextQuery) return;
      this.pumpTask = this.pump(nextQuery);
      this.enqueuePrompt(body, skill);
    } catch (err: unknown) {
      if (this.closed) return;
      reportAgentRuntimeFailure('claude', err);
      this.turnActive = false;
      this.sendTurnError(errorMessage(err));
      this.send({ t: 'turn-end', isError: true });
    }
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
        this.turnGeneration += 1;
        this.interruptRequested = false;
        this.send({ t: 'turn-start' });
        if (this.rebound && (!this.cwd || !filesystemPath.equal(this.cwd, this.rebound))) {
          const migration = this.migrateAndEnqueuePrompt(body, skill);
          this.nativeMigrationTask = migration;
          void migration.finally(() => {
            if (this.nativeMigrationTask === migration) this.nativeMigrationTask = null;
          });
        } else {
          this.enqueuePrompt(body, skill);
        }
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
            updatedInput: p.input,
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
      case 'set-similarity-search': {
        if (typeof msg.enabled === 'boolean') this.similaritySearch = msg.enabled;
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
    const migration = this.nativeMigrationTask;
    if (migration) await migration.catch(() => { /* migration already reported */ });
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
  // A library session migrated to a project by create_project keeps its
  // native cwd (the folder home) while its history lists under the project
  // (the persisted override). Resuming it from that project's History must
  // therefore accept the override folder as a match.
  try {
    const override = agentSessionFolderOverride('claude', sessionId);
    if (override && filesystemPath.equal(override, cwd)) return true;
  } catch {
    // Fall through to the native cwd check.
  }
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
  scope?: 'library',
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
    scope,
  );
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
 *  windows. Library folder removal calls this so a removed folder cannot
 *  keep running sessions. */
export function killAgentSessionsForFolder(folderAbs: string): void {
  disposeSessionsBoundToFolder(sessions, folderAbs);
}

function normalizeAgentWindowId(windowId: string | null | undefined): string {
  const raw = typeof windowId === 'string' ? windowId.trim() : '';
  return raw ? raw.slice(0, 128) : 'default';
}
