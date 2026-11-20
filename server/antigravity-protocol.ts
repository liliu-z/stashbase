/**
 * Antigravity CLI wire protocol and tool policy.
 *
 * A chat runs one `agy` process in stream-json mode: each stdin line is a user
 * message, and stdout carries newline-delimited `init`, `step_update` and
 * `result` events. Field spellings follow the CLI's headless documentation;
 * the readers below accept the nested and flat forms the CLI has printed so a
 * cosmetic change cannot drop a turn's outcome.
 *
 * Headless `agy` cannot ask the reader for approval, so StashBase runs it with
 * every tool permitted and gates each call in its `PreToolUse` hook instead
 * (`antigravity-approval.ts`). The policy that hook applies lives here.
 */
import path from 'node:path';
import type { AgentAccessMode } from './agent-contract.ts';
import { isPathWithinWorkspace, isStashbaseWorkspaceEdit } from './agent-file-permissions.ts';

export type JsonObject = Record<string, unknown>;

/** The permission promises this adapter keeps. Auto is StashBase's own rule
 * set, applied in the approval hook: Antigravity's native Auto decides inside
 * the CLI, where it refuses StashBase's MCP tools and asks no one. */
export const ANTIGRAVITY_ACCESS_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const satisfies readonly AgentAccessMode[];

export interface AntigravityLaunch {
  mode?: AgentAccessMode;
  model?: string;
  effort?: string;
  conversation?: string;
}

export function antigravityArgs(launch: AntigravityLaunch): string[] {
  const nativeMode = launch.mode === 'plan'
    ? 'plan'
    : launch.mode === 'acceptEdits' || launch.mode === 'auto' ? 'accept-edits' : undefined;
  return [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    // Every call still passes the StashBase approval hook, which denies what
    // the chat's mode does not allow; this only stops headless `agy` from
    // silently refusing what the reader would approve.
    '--dangerously-skip-permissions',
    ...(nativeMode ? ['--mode', nativeMode] : []),
    ...(launch.model ? ['--model', launch.model] : []),
    ...(launch.effort ? ['--effort', launch.effort] : []),
    ...(launch.conversation ? ['--conversation', launch.conversation] : []),
  ];
}

export function antigravityUserMessage(text: string): string {
  return `${JSON.stringify({ event: 'user', message: { role: 'user', content: text } })}\n`;
}

/** The role and routing policy ride ahead of the first message a process
 * sends, because `agy` takes no system prompt from its caller. */
export function antigravityPromptWithInstructions(instructions: string, prompt: string): string {
  return `<stashbase_session_instructions>\n${instructions}\n</stashbase_session_instructions>\n\n${prompt}`;
}

export type AntigravityEvent =
  | { kind: 'init'; conversationId: string; model?: string }
  | AntigravityStep
  | AntigravityResult;

export interface AntigravityStep {
  kind: 'step';
  conversationId: string;
  index: number;
  state: 'active' | 'done' | 'error' | 'unknown';
  type: string;
  textDelta: string;
  tool: { name: string; parameters: JsonObject; output: string; error: string } | null;
}

export interface AntigravityResult {
  kind: 'result';
  conversationId: string;
  status: string;
  response: string;
  error: string;
  finishedReason: string;
  deniedActions: string[];
}

export function parseAntigravityLine(line: string): AntigravityEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let raw: unknown;
  try { raw = JSON.parse(trimmed); } catch { return null; }
  const event = objectValue(raw);
  const name = stringValue(event.event) || stringValue(event.type);
  if (name === 'init') {
    const init = { ...event, ...objectValue(event.init) };
    return {
      kind: 'init',
      conversationId: conversationIdOf(init),
      ...(stringValue(init.model) ? { model: stringValue(init.model) } : {}),
    };
  }
  if (name === 'step_update') {
    const step = { ...event, ...objectValue(event.step_update ?? event.stepUpdate) };
    const info = objectValue(step.tool_info ?? step.toolInfo);
    const type = (stringValue(step.step_type) || stringValue(step.stepType)).toLowerCase();
    const toolName = stringValue(info.name) || stringValue(step.tool_name) || stringValue(step.toolName);
    const isTool = type === 'tool' || (!!toolName && type !== 'agent_response');
    // A tool also ends in ERROR, but only DONE confirms a completed reply.
    const state = (stringValue(step.state) || 'ACTIVE').toUpperCase();
    return {
      kind: 'step',
      conversationId: conversationIdOf(step),
      index: numberValue(step.step_index ?? step.stepIndex),
      state: state === 'ACTIVE' ? 'active' : state === 'DONE' ? 'done' : state === 'ERROR' ? 'error' : 'unknown',
      type,
      textDelta: stringValue(step.text_delta ?? step.textDelta),
      tool: isTool
        ? {
            name: toolName || 'tool',
            parameters: jsonObjectValue(info.parameters ?? info.args ?? info.arguments),
            output: textOf(info.output),
            error: errorText(info.error) || (state === 'ERROR' ? 'The tool failed.' : ''),
          }
        : null,
    };
  }
  if (name === 'result') {
    const result = { ...event, ...objectValue(event.result) };
    const denied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
    return {
      kind: 'result',
      conversationId: conversationIdOf(result),
      status: (stringValue(result.status) || 'SUCCESS').toUpperCase(),
      response: textOf(result.response),
      error: errorText(result.error),
      finishedReason: stringValue(result.finished_reason ?? result.finishedReason).toLowerCase(),
      deniedActions: denied
        .map((item) => stringValue(objectValue(item).display_name) || stringValue(objectValue(item).action) || stringValue(item))
        .filter(Boolean),
    };
  }
  return null;
}

/** The structured `AGY_ERROR: {...}` line the CLI prints on stderr for a model
 * or agent failure, or its stable `error:` line. */
export function antigravityErrorFromStderr(stderr: string): string {
  const lines = stderr.split(/\r?\n/);
  for (const line of [...lines].reverse()) {
    const marker = /AGY_ERROR:\s*(\{.*\})\s*$/.exec(line);
    if (!marker) continue;
    try {
      const detail = objectValue(JSON.parse(marker[1]));
      const message = stringValue(detail.short_error) || stringValue(detail.message) || stringValue(detail.error);
      if (message) return message;
    } catch {
      return marker[1];
    }
  }
  const fatal = [...lines].reverse().find((line) => /^\s*error:\s*\S/i.test(line));
  return fatal ? fatal.replace(/^\s*error:\s*/i, '').trim() : '';
}

// --- Tool presentation ----------------------------------------------------

/** StashBase's own MCP tools, which the routing policy names. */
const STASHBASE_TOOLS = new Set([
  'list_projects', 'list_directory', 'read_file', 'write_file', 'edit_file',
  'move_file', 'delete_file', 'search_project', 'create_project', 'create_interactive_note', 'reindex',
]);
const STASHBASE_READ_TOOLS = new Set(['list_projects', 'list_directory', 'read_file', 'search_project', 'reindex']);
const STASHBASE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create_interactive_note']);

/** Native tools that only read the filesystem, report progress, or end the
 * turn. Names as `agy` 1.4.0 lists them in its `init` event. */
const NATIVE_READ_TOOLS = new Set([
  'view_file', 'view_file_outline', 'view_code_item', 'view_content_chunk',
  'list_dir', 'find_by_name', 'grep_search', 'codebase_search', 'code_search',
  'read_resource', 'list_resources', 'command_status', 'read_terminal',
  'list_permissions', 'list_plugin_accounts',
  'task_boundary', 'notify_user', 'update_plan', 'finish', 'wait', 'wait_5_seconds',
  // Questions to the reader: headless runs answer them without the reader.
  'ask_question', 'ask_permission', 'ask_custom_permission',
]);
const NATIVE_WRITE_TOOLS = new Set([
  'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit',
]);
const NATIVE_COMMAND_TOOLS = new Set(['run_command', 'send_command_input']);
const NATIVE_NETWORK_TOOLS = new Set(['read_url_content', 'search_web']);

export type AntigravityToolKind =
  | 'read'
  | 'stashbase-read'
  | 'stashbase-write'
  | 'stashbase-other'
  | 'file-write'
  | 'command'
  | 'network'
  | 'other';

export interface AntigravityToolCall {
  name: string;
  args: JsonObject;
}

export interface ClassifiedTool {
  kind: AntigravityToolKind;
  /** The StashBase tool and its own arguments, for an MCP call to StashBase. */
  stashbase?: { tool: string; arguments: JsonObject };
  /** The file a native write targets. */
  path?: string;
  /** The command line a shell tool runs. */
  command?: string;
  /** What a web tool does, and the address it reads. */
  web?: { kind: 'search' | 'url' | 'browser'; url?: string };
}

export function classifyAntigravityTool(call: AntigravityToolCall): ClassifiedTool {
  const stashbase = stashbaseToolCall(call);
  if (stashbase) {
    const kind = STASHBASE_READ_TOOLS.has(stashbase.tool)
      ? 'stashbase-read'
      : STASHBASE_WRITE_TOOLS.has(stashbase.tool) ? 'stashbase-write' : 'stashbase-other';
    return { kind, stashbase };
  }
  const name = call.name.toLowerCase();
  if (NATIVE_READ_TOOLS.has(name)) return { kind: 'read' };
  if (NATIVE_WRITE_TOOLS.has(name)) {
    const target = nativeTargetPath(call.args);
    return { kind: 'file-write', ...(target ? { path: target } : {}) };
  }
  if (name === 'run_command') {
    return { kind: 'command', command: stringValue(call.args.CommandLine ?? call.args.commandLine ?? call.args.command) };
  }
  if (NATIVE_COMMAND_TOOLS.has(name)) return { kind: 'command' };
  if (name === 'search_web') return { kind: 'network', web: { kind: 'search' } };
  if (name === 'read_url_content') {
    const url = stringValue(call.args.Url ?? call.args.url ?? call.args.URL);
    return { kind: 'network', web: { kind: 'url', ...(url ? { url } : {}) } };
  }
  if (NATIVE_NETWORK_TOOLS.has(name) || name.startsWith('browser_')) return { kind: 'network', web: { kind: 'browser' } };
  return { kind: 'other' };
}

export type AntigravityHookDecision = 'allow' | 'ask' | 'deny';

/** What the chat's mode lets a tool call do without the reader. Reads always
 * pass; Edit passes ordinary writes inside the bound project; Auto also
 * passes read-only commands, web searches and plain page reads; Plan refuses
 * anything that could change the project; everything else asks. */
export function antigravityToolDecision(
  mode: AgentAccessMode,
  tool: ClassifiedTool,
  cwd: string | null,
): AntigravityHookDecision {
  const edits = mode === 'acceptEdits' || mode === 'auto';
  switch (tool.kind) {
    case 'read':
    case 'stashbase-read':
      return 'allow';
    case 'network':
      return mode === 'auto' && isRoutineWebRead(tool.web) ? 'allow' : 'ask';
    case 'command':
      if (mode === 'plan') return 'deny';
      return mode === 'auto' && isReadOnlyCommand(tool.command ?? '') ? 'allow' : 'ask';
    case 'stashbase-write':
      if (mode === 'plan') return 'deny';
      return edits && isStashbaseWorkspaceEdit(
        { input: { server: 'stashbase', tool: tool.stashbase?.tool, arguments: tool.stashbase?.arguments } },
        cwd,
      ) ? 'allow' : 'ask';
    case 'file-write':
      if (mode === 'plan') return 'deny';
      return edits && !!tool.path && !!cwd
        && isPathWithinWorkspace(path.resolve(cwd, tool.path), cwd) ? 'allow' : 'ask';
    default:
      return mode === 'plan' ? 'deny' : 'ask';
  }
}

/** Programs whose every use below only prints. Anything that can write,
 * install, run other programs, or reach the network is absent. */
const READ_ONLY_PROGRAMS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'echo', 'date',
  'which', 'stat', 'du', 'df', 'sort', 'cut', 'nl', 'diff', 'cmp',
  'basename', 'dirname', 'realpath', 'readlink',
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'blame', 'ls-files', 'rev-parse', 'describe', 'shortlog']);
/** Options that make an otherwise read-only program write or run something. */
const WRITING_OPTIONS: Readonly<Record<string, RegExp>> = {
  find: /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/,
  sort: /^(?:-o|--output)/,
  rg: /^--pre/,
  git: /^--output/,
};

/** Auto runs a shell command unasked only when the line itself shows it reads:
 * known programs, optionally piped into each other, with no chaining,
 * substitution, redirection, escapes, or backgrounding. */
export function isReadOnlyCommand(command: string): boolean {
  const line = command.trim();
  if (!line || /[;&<>`$(){}\n\r\\]/.test(line) || line.includes('||')) return false;
  return line.split('|').every((segment) => {
    const [program, ...args] = segment.trim().split(/\s+/).filter(Boolean);
    if (!program) return false;
    if (WRITING_OPTIONS[program] && args.some((arg) => WRITING_OPTIONS[program]!.test(arg))) return false;
    if (program === 'git') return READ_ONLY_GIT.has(args[0] ?? '');
    return READ_ONLY_PROGRAMS.has(program);
  });
}

/** A web search, or reading a public page whose address carries no query
 * that could take local text out with it. Browsing stays with the reader. */
function isRoutineWebRead(web: ClassifiedTool['web']): boolean {
  if (web?.kind === 'search') return true;
  if (web?.kind !== 'url' || !web.url) return false;
  try {
    const url = new URL(web.url);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.search && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** How a tool call reads in the transcript and on an approval card. Native
 * names keep their own spelling except the two the renderer already knows how
 * to show; StashBase's MCP tools use the `server:tool` form Codex uses. */
export function antigravityToolDisplay(call: AntigravityToolCall): { name: string; input: JsonObject } {
  const stashbase = stashbaseToolCall(call);
  if (stashbase) {
    return { name: `stashbase:${stashbase.tool}`, input: { server: 'stashbase', tool: stashbase.tool, arguments: stashbase.arguments } };
  }
  const name = call.name.toLowerCase();
  if (name === 'run_command') {
    const command = stringValue(call.args.CommandLine ?? call.args.commandLine ?? call.args.command);
    const cwd = stringValue(call.args.Cwd ?? call.args.cwd);
    return { name: 'Bash', input: { command, ...(cwd ? { cwd } : {}) } };
  }
  if (name === 'write_to_file') {
    const target = nativeTargetPath(call.args);
    const content = stringValue(call.args.CodeContent ?? call.args.codeContent ?? call.args.content);
    return { name: 'Write', input: { ...(target ? { file_path: target } : {}), content } };
  }
  const target = nativeTargetPath(call.args);
  return { name: call.name, input: target ? { ...call.args, file_path: target } : call.args };
}

export function antigravityApprovalTitle(tool: ClassifiedTool, display: { name: string }): string {
  switch (tool.kind) {
    case 'command': return 'Allow Antigravity to run this command?';
    case 'file-write': return 'Allow Antigravity to change this file?';
    case 'stashbase-write': return 'Allow Antigravity to change this document?';
    case 'network': return 'Allow Antigravity to access the web?';
    default: return `Allow Antigravity to use ${display.name}?`;
  }
}

function stashbaseToolCall(call: AntigravityToolCall): { tool: string; arguments: JsonObject } | null {
  const args = call.args;
  const server = stringValue(args.server_name ?? args.serverName ?? args.ServerName ?? args.server).toLowerCase();
  const named = stringValue(args.tool_name ?? args.toolName ?? args.ToolName);
  if (server === 'stashbase' && STASHBASE_TOOLS.has(named)) {
    return { tool: named, arguments: jsonObjectValue(args.arguments ?? args.Arguments ?? args.args ?? args.input) };
  }
  const prefixed = /^(?:mcp(?:__|[_:./-]))?stashbase(?:__|[_:./-])([a-z_]+)$/i.exec(call.name)?.[1];
  const tool = prefixed ?? (STASHBASE_TOOLS.has(call.name) ? call.name : '');
  return tool && STASHBASE_TOOLS.has(tool) ? { tool, arguments: args } : null;
}

function nativeTargetPath(args: JsonObject): string {
  for (const key of ['TargetFile', 'targetFile', 'target_file', 'AbsolutePath', 'absolutePath', 'file_path', 'filePath', 'path', 'File', 'file']) {
    const value = stringValue(args[key]);
    if (value) return value;
  }
  return '';
}

// --- Small readers --------------------------------------------------------

export function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : -1;
}

function conversationIdOf(value: JsonObject): string {
  return stringValue(value.conversation_id) || stringValue(value.conversationId);
}

/** Tool parameters arrive as an object or as its JSON text. */
function jsonObjectValue(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try { return objectValue(JSON.parse(value)); } catch { return value ? { value } : {}; }
  }
  return objectValue(value);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  const error = objectValue(value);
  return stringValue(error.message) || stringValue(error.short_error) || stringValue(error.type);
}
