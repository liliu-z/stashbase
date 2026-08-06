/**
 * Structured-agent sidecar. Where `terminal.ts` bridges a raw PTY to an
 * xterm, this bridges the **Claude Agent SDK** to a WebSocket as a
 * stream of structured panel events (text / thinking / tool calls /
 * permission prompts), so the renderer can paint a VSCode-style chat
 * panel instead of a terminal. One session per chat tab; switching
 * folders tears every session down (the SDK's cwd is then stale).
 *
 * Auth: the SDK reads the same credential store the user's `claude`
 * login populated (Keychain / `~/.claude`), so a Pro/Max subscription
 * works with no API key.
 *
 * Wire protocol (line-delimited JSON over one ws):
 *   client → server:
 *     { t: "prompt", text }
 *     { t: "permission-reply", id, allow, always? }
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
 *     { t: "error", message }
 *     { t: "exit" }                                    // session ended
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
import { getCurrentFolder, memberRootForAbs, runWithWindowId } from './folder.ts';
import { buildStashbasePreamble } from './agent-preamble.ts';
import { agentCliEnv, agentCliNeedsShell, commandDir, resolveAgentCli } from './agent-cli.ts';
import { ensureClaudeBridgeFile } from './agent-rules.ts';
import { noteTreeChanged } from './watcher.ts';
import { isAgentAccessMode, reportAgentRuntimeFailure, type AgentAccessMode } from './agent-contract.ts';
import type { AgentClientEvent, AgentModel, AgentServerEvent, AgentSkill } from './agent-contract.ts';
import { detectViewerFormat } from './format.ts';
import { isAgentReadableDerivedTextReady } from './library-file-reader.ts';

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

export function claudeSkillsFromCommands(commands: Array<{ name: string; description: string }>): AgentSkill[] {
  return commands.filter((command) => command.name.trim()).map((command) => ({ id: command.name, name: command.name, description: command.description || 'Claude Code skill' }));
}

export function claudeSkillPrompt(prompt: string, skill?: AgentSkill): string { return skill ? `/${skill.name} ${prompt}` : prompt; }

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
class AgentSession {
  private input = new Pushable<SDKUserMessage>();
  private q: Query | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private nativeDerivedReadRedirected = new Set<string>();
  /** The SDK session_id, captured from the init message. Sent to the
   *  client so the history dropdown can mark this session active. */
  private sessionId: string | null = null;
  private models: AgentModel[] = [];
  private skills: AgentSkill[] = [];
  private skillsGeneration = 0;
  private commandsChanged = false;

  constructor(
    private ws: WebSocket,
    windowId: string,
    private effort?: EffortLevel,
    private resume?: string,
    private access: PermissionMode = 'default',
    private model?: string,
    private onDispose?: (session: AgentSession) => void,
  ) {
    this.windowId = normalizeAgentWindowId(windowId);
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
  }

  readonly windowId: string;

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
    if (this.closed) return;
    if (this.resume && !(await resumeMatchesCwd(this.resume, cwd))) {
      if (this.closed) return;
      this.send({ t: 'error', message: 'That session belongs to a different folder.' });
      this.finish();
      return;
    }
    if (this.closed) return;
    const claudeCodeExecutable = resolveClaudeBinary();
    if (!claudeCodeExecutable) {
      this.send({ t: 'error', message: missingClaudeMessage() });
      this.finish();
      return;
    }
    if (ensureClaudeBridgeFile(cwd)) noteTreeChanged();
    try {
      this.q = query({
        prompt: this.input,
        options: {
          cwd,
          includePartialMessages: true,
          // Apply the shared Access choice when the native session starts.
          // Later changes still use the SDK's live setPermissionMode API.
          permissionMode: this.access,
          // Orient the panel inside StashBase. settingSources below loads
          // CLAUDE.md / skills / MCP, but nothing tells the model it's in a
          // StashBase folder, what search_library/reindex are for, or the house
          // rules (those reach the model only via the advisory MCP
          // `instructions` field + an optional library_info call). Inject that
          // deterministically as a system-prompt append. See
          // agent-preamble.ts and architecture.md §8.4.
          systemPrompt: { type: 'preset', preset: 'claude_code', append: buildStashbasePreamble(cwd) },
          // Resuming a past session loads its conversation history so the
          // user can continue it. The transcript itself is rendered from
          // getSessionMessages on the client; `resume` only primes the SDK
          // to append to the same session_id rather than start a new one.
          ...(this.resume ? { resume: this.resume } : {}),
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
          } as NodeJS.ProcessEnv,
          spawnClaudeCodeProcess,
          canUseTool: (name, input, opts) => this.onPermission(name, input, opts),
          stderr: (d: string) => log.debug(d),
        },
      });
    } catch (err: unknown) {
      reportAgentRuntimeFailure('claude', err);
      this.send({ t: 'error', message: errorMessage(err) });
      this.finish();
      return;
    }
    if (this.closed) {
      void this.q?.interrupt().catch(() => { /* already disposed */ });
      return;
    }
    await this.publishModels();
    this.send({ t: 'ready' });
    void this.refreshSkills();
    void this.pump();
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

  /** Drain the SDK message stream until it ends or errors. */
  private async pump(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const msg of this.q) this.onSdkMessage(msg);
    } catch (err: unknown) {
      if (!this.closed) {
        reportAgentRuntimeFailure('claude', err);
        this.send({ t: 'error', message: errorMessage(err) });
      }
    }
    this.finish();
  }

  private onSdkMessage(msg: SDKMessage): void {
    // Every SDK message carries the session_id; capture + surface it the
    // first time we see one (the init `system` message) so the history
    // dropdown can mark the live session active and resume targets it.
    const sid = (msg as { session_id?: unknown }).session_id;
    if (!this.sessionId && typeof sid === 'string' && sid) {
      this.sessionId = sid;
      this.send({ t: 'session-id', id: sid });
    }
    if (msg.type === 'system' && msg.subtype === 'init' && msg.model) {
      this.send(claudeActiveModelEvent(this.models, msg.model));
    }
    if (msg.type === 'system' && msg.subtype === 'commands_changed') this.setSkills(msg.commands, true);
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
        this.send({ t: 'turn-end', isError: msg.is_error === true });
        break;
      }
      default:
        break;
    }
  }

  /** SDK permission callback. Auto-allow reads; round-trip writes/exec to
   *  the client and await the user's approve/reject. */
  private onPermission(
    name: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID: string; title?: string },
  ): Promise<PermissionResult> {
    const cwd = getCurrentFolder();
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

  private onMessage(text: string): void {
    let msg: AgentClientEvent;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg.t) {
      case 'prompt': {
        const body = typeof msg.text === 'string' ? msg.text : '';
        if (!body.trim()) return;
        const selected = msg.skill && typeof msg.skill.id === 'string' ? this.skills.find((skill) => skill.id === msg.skill!.id) : undefined;
        if (msg.skill && !selected) { this.send({ t: 'error', message: 'That Claude skill is no longer available. Refresh skills and try again.' }); this.send({ t: 'turn-end', isError: true }); return; }
        this.send({ t: 'turn-start' });
        this.input.push({
          type: 'user',
          message: { role: 'user', content: claudeSkillPrompt(body, selected) },
          parent_tool_use_id: null,
        } as SDKUserMessage);
        break;
      }
      case 'skills-refresh': void this.refreshSkills(); break;
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
          void this.q?.setPermissionMode(msg.mode).catch((err) => log.debug(errorMessage(err)));
        }
        break;
      }
      case 'interrupt':
        void this.q?.interrupt().catch(() => { /* not streaming yet */ });
        break;
      case 'close':
        this.dispose();
        break;
    }
  }

  private async refreshSkills(): Promise<void> {
    this.send({ t: 'skills', skills: [], loading: true });
    if (this.commandsChanged) { this.send({ t: 'skills', skills: this.skills }); return; }
    const generation = this.skillsGeneration;
    try { const commands = await this.q?.supportedCommands() ?? []; if (!this.commandsChanged && generation === this.skillsGeneration) this.setSkills(commands); }
    catch (err: unknown) { if (!this.commandsChanged && generation === this.skillsGeneration) this.send({ t: 'skills', skills: [], error: `Could not load Claude skills: ${errorMessage(err)}` }); }
  }

  private setSkills(commands: Array<{ name: string; description: string }>, changed = false): void {
    if (changed) this.commandsChanged = true;
    this.skills = claudeSkillsFromCommands(commands); this.skillsGeneration += 1; this.send({ t: 'skills', skills: this.skills });
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
    // Resolve any dangling permission prompts so the SDK loop unwinds.
    for (const [, p] of this.pending) {
      p.cleanup?.();
      p.resolve({ behavior: 'deny', message: 'Session closed.' });
    }
    this.pending.clear();
    void this.q?.interrupt().catch(() => { /* already gone */ });
    this.input.end();
    try { this.ws.close(); } catch { /* already closed */ }
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

/** Live agent sessions — one per structured chat tab. Folder switch tears
 *  them all down (the SDK cwd is then meaningless). */
const sessions = new Set<AgentSession>();

export function attachAgentWebSocket(
  ws: WebSocket,
  windowId = 'default',
  effort?: string,
  resume?: string,
  access?: AgentAccessMode,
  model?: string,
): void {
  const session = new AgentSession(
    ws,
    windowId,
    effort as EffortLevel | undefined,
    resume,
    claudePermissionMode(access),
    model,
    (s) => sessions.delete(s),
  );
  sessions.add(session);
  session.begin();
}

/** Kill every live agent session (optionally for one window). Called on
 *  folder switch / close — the session's cwd no longer makes sense. */
export function killActiveAgent(windowId?: string): void {
  for (const session of [...sessions]) {
    if (!windowId || session.windowId === windowId) {
      session.dispose();
      sessions.delete(session);
    }
  }
}

function normalizeAgentWindowId(windowId: string | null | undefined): string {
  const raw = typeof windowId === 'string' ? windowId.trim() : '';
  return raw ? raw.slice(0, 128) : 'default';
}
