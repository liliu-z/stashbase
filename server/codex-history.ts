import { retireAgentProcess } from './agent-process.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { appVersion, spawnCodexAppServerProcess } from './codex-app-server-process.ts';
import { filesystemPath } from './filesystem-path.ts';
import { errorMessage, logger } from './log.ts';
import {
  httpError,
  objectValue,
  stringValue,
  stringifyCodexValue,
  toolResultFromItem,
  toolStartFromItem,
  type JsonObject,
} from './codex-protocol.ts';
import { CodexRpcPeer, CODEX_RPC_REQUEST_TIMEOUT_MS } from './codex-rpc-transport.ts';
import { historyImageAttachment, restoreHistoryAttachments, type RestoredAttachment } from './agent-history-attachments.ts';

const log = logger('codex-history');

export interface CodexSessionRow {
  id: string;
  title: string;
  lastModified: number;
  hasContent: boolean;
  cwd?: string;
  gitBranch?: string;
}

export type CodexSessionBlock =
  /** `at` (epoch ms) comes from the turn's own `startedAt`/`completedAt`
   * — Codex records no per-item times (verified against the live
   * app-server), so the turn boundaries are the honest per-message
   * approximation: the user message started the turn, the reply's time
   * is when the turn completed. Never defaulted when absent. */
  | { kind: 'user'; id: string; text: string; attachments?: CodexAttachment[]; at?: number }
  | { kind: 'assistant'; id: string; text: string; at?: number }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; status: 'done' | 'error'; result?: string };

/** A restored file attachment: a name-only document card, or — only for images
 * originally uploaded through StashBase's transient attachment route — a
 * previewable thumbnail. */
export type CodexAttachment = RestoredAttachment;

export async function listCodexSessions(folder: string): Promise<CodexSessionRow[]> {
  const cwd = folder;
  const result = await withTemporaryCodexAppServer(cwd, (request) => request('thread/list', {
    limit: 100,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    archived: false,
    cwd: folder,
  })) as JsonObject;
  const data = Array.isArray(result.data) ? result.data : [];
  return data.map(codexThreadToRow).filter((row): row is CodexSessionRow => !!row);
}

export async function getCodexSessionMessages(threadId: string, folder: string): Promise<CodexSessionBlock[]> {
  const cwd = folder;
  const thread = await withTemporaryCodexAppServer(cwd, (request) => readScopedThread(request, threadId, folder, true));
  return codexThreadToBlocks(thread, codexRolloutToolsByTurn(stringValue(thread.path)));
}

async function readScopedThread(
  request: (method: string, params: unknown) => Promise<unknown>,
  threadId: string,
  folder: string,
  includeTurns = false,
): Promise<JsonObject> {
  const result = objectValue(await request('thread/read', { threadId, includeTurns }));
  const thread = objectValue(result.thread);
  const threadCwd = stringValue(thread.cwd);
  if (!threadCwd.trim() || !filesystemPath.equal(threadCwd, folder)) {
    throw httpError(404, 'session not found for current folder');
  }
  return thread;
}

export async function renameCodexSession(threadId: string, title: string, folder: string): Promise<CodexSessionRow> {
  const cwd = folder;
  return withTemporaryCodexAppServer(cwd, async (request) => {
    await readScopedThread(request, threadId, folder);
    await request('thread/name/set', { threadId, name: title });
    const row = codexThreadToRow(await readScopedThread(request, threadId, folder));
    if (!row) throw httpError(502, 'Codex returned invalid session metadata');
    return row;
  });
}

export async function deleteCodexSession(threadId: string, folder: string): Promise<void> {
  const cwd = folder;
  await withTemporaryCodexAppServer(cwd, async (request) => {
    await readScopedThread(request, threadId, folder);
    await permanentlyDeleteCodexThread(request, threadId);
  });
}

/** Delete is irreversible in the shared panel, so use Codex's native
 * thread/delete operation rather than merely removing it from history. */
export async function permanentlyDeleteCodexThread(
  request: (method: string, params: unknown) => Promise<unknown>,
  threadId: string,
): Promise<void> {
  await request('thread/delete', { threadId });
}

async function withTemporaryCodexAppServer<T>(
  cwd: string,
  fn: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  return withSharedCodexHistoryAppServer(cwd, fn);
}

class CodexHistoryAppServer {
  readonly ready: Promise<void>;
  private proc: ChildProcessWithoutNullStreams;
  private stdout: readline.Interface;
  private stderr: readline.Interface;
  private rpc: CodexRpcPeer;
  private closed = false;
  private cleaned = false;

  constructor(readonly cwd: string, private onClose: () => void) {
    this.proc = spawnCodexAppServerProcess(cwd);
    this.rpc = new CodexRpcPeer((line) => {
      if (!this.proc.stdin.writable) throw new Error('Codex app-server is not running.');
      this.proc.stdin.write(`${line}\n`);
    }, {
      requestTimeoutMs: CODEX_RPC_REQUEST_TIMEOUT_MS,
      onRequest: ({ id, method }) => {
        try {
          this.rpc.reject(id, `Unsupported Codex history request: ${method}`, -32601);
        } catch {
          // The process may close between receiving and answering the request.
        }
      },
    });
    this.stdout = readline.createInterface({ input: this.proc.stdout });
    this.stderr = readline.createInterface({ input: this.proc.stderr });

    this.stdout.on('line', (line) => this.rpc.receiveLine(line));
    this.stderr.on('line', (line) => {
      const clean = line.trim();
      if (clean) log.debug(clean);
    });
    this.proc.once('close', (code, signal) => {
      this.closed = true;
      this.rpc.close(new Error(`Codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`));
      this.cleanup();
      this.onClose();
    });
    this.proc.once('error', (err) => {
      this.closed = true;
      this.rpc.close(err);
      this.cleanup();
      this.onClose();
    });

    this.ready = this.request('initialize', {
      clientInfo: { name: 'StashBase', title: null, version: appVersion() },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null },
    }).then(() => undefined);
  }

  isClosed(): boolean {
    return this.closed;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is not running.'));
    return this.rpc.request(method, params);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.rpc.close(new Error('Codex app-server history client closed.'));
    this.cleanup();
    void retireAgentProcess(this.proc);
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.stdout.close();
    this.stderr.close();
  }
}

interface CodexHistoryEntry {
  client: CodexHistoryAppServer;
  refs: number;
  idleTimer: NodeJS.Timeout | null;
}

const HISTORY_APP_SERVER_IDLE_MS = 15000;
const codexHistoryClients = new Map<string, CodexHistoryEntry>();

async function withSharedCodexHistoryAppServer<T>(
  cwd: string,
  fn: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const key = filesystemPath.identity(cwd);
  let entry = codexHistoryClients.get(key);
  if (!entry || entry.client.isClosed()) {
    const client = new CodexHistoryAppServer(cwd, () => {
      const cur = codexHistoryClients.get(key);
      if (cur?.client === client) codexHistoryClients.delete(key);
    });
    entry = { client, refs: 0, idleTimer: null };
    codexHistoryClients.set(key, entry);
  }

  entry.refs += 1;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  try {
    await entry.client.ready;
    return await fn((method, params) => entry!.client.request(method, params));
  } catch (err) {
    if (entry.client.isClosed() || isCodexHistoryTransportError(err)) {
      entry.client.dispose();
      if (codexHistoryClients.get(key) === entry) codexHistoryClients.delete(key);
    }
    throw err;
  } finally {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0 && !entry.client.isClosed() && codexHistoryClients.get(key) === entry) {
      entry.idleTimer = setTimeout(() => {
        const cur = codexHistoryClients.get(key);
        if (cur === entry && cur.refs === 0) {
          cur.client.dispose();
          codexHistoryClients.delete(key);
        }
      }, HISTORY_APP_SERVER_IDLE_MS);
      entry.idleTimer.unref?.();
    }
  }
}

function isCodexHistoryTransportError(err: unknown): boolean {
  return /Codex app-server|not running|timed out|history client closed/i.test(errorMessage(err));
}

export function codexThreadHasContent(thread: unknown): boolean {
  return Boolean(stringValue(objectValue(thread).preview).trim());
}

function codexThreadToRow(thread: unknown): CodexSessionRow | null {
  const obj = objectValue(thread);
  const id = stringValue(obj.id);
  if (!id) return null;
  const cwd = stringValue(obj.cwd);
  const git = objectValue(obj.gitInfo);
  return {
    id,
    title: stringValue(obj.name) || stringValue(obj.preview) || id,
    lastModified: secondsToMillis(obj.updatedAt),
    hasContent: codexThreadHasContent(obj),
    ...(cwd ? { cwd } : {}),
    ...(stringValue(git.branch) ? { gitBranch: stringValue(git.branch) } : {}),
  };
}

type RolloutTool = Extract<CodexSessionBlock, { kind: 'tool' }> & { afterAssistantMessages: number };
type RolloutToolsByTurn = Map<string, RolloutTool[]>;

/**
 * `thread/read` is authoritative for normal app-server sessions, but Codex
 * currently omits desktop-hosted tool calls from that response. Those calls
 * remain in Codex's local rollout file, which the thread metadata points to.
 * Read only that known local session directory and add the missing calls back
 * to their original turn.
 */
function codexRolloutToolsByTurn(threadPath: string): RolloutToolsByTurn {
  const byTurn: RolloutToolsByTurn = new Map();
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  if (!threadPath || !isPathInside(threadPath, sessionsDir)) return byTurn;

  let lines: string[];
  try {
    lines = fs.readFileSync(threadPath, 'utf8').split(/\r?\n/);
  } catch {
    return byTurn;
  }

  const calls = new Map<string, RolloutTool>();
  const assistantMessagesByTurn = new Map<string, number>();
  for (const line of lines) {
    if (!line) continue;
    let entry: JsonObject;
    try { entry = JSON.parse(line) as JsonObject; } catch { continue; }
    if (stringValue(entry.type) !== 'response_item') continue;
    const payload = objectValue(entry.payload);
    const payloadType = stringValue(payload.type);
    const turnId = stringValue(objectValue(payload.internal_chat_message_metadata_passthrough).turn_id);
    const callId = stringValue(payload.call_id);
    if (payloadType === 'message' && stringValue(payload.role) === 'assistant' && turnId) {
      assistantMessagesByTurn.set(turnId, (assistantMessagesByTurn.get(turnId) ?? 0) + 1);
      continue;
    }
    if ((payloadType === 'function_call' || payloadType === 'custom_tool_call') && callId && turnId) {
      const tool: RolloutTool = {
        kind: 'tool',
        id: `rollout-${stringValue(payload.id) || callId}`,
        name: rolloutToolName(stringValue(payload.name)),
        input: rolloutToolInput(payloadType === 'function_call' ? payload.arguments : payload.input),
        status: stringValue(payload.status) === 'failed' ? 'error' : 'done',
        afterAssistantMessages: assistantMessagesByTurn.get(turnId) ?? 0,
      };
      calls.set(callId, tool);
      const tools = byTurn.get(turnId) ?? [];
      tools.push(tool);
      byTurn.set(turnId, tools);
      continue;
    }
    if ((payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') && callId) {
      const tool = calls.get(callId);
      if (tool) tool.result = stringifyCodexValue(payload.output);
    }
  }
  return byTurn;
}

function rolloutToolInput(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonObject;
    } catch {
      // Some custom tools use plain-text input rather than JSON.
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : { input: stringifyCodexValue(value) };
}

function isPathInside(candidate: string, parent: string): boolean {
  return !filesystemPath.equal(parent, candidate) && filesystemPath.contains(parent, candidate);
}

function rolloutToolName(name: string): string {
  if (name === 'exec' || name === 'exec_command') return 'Ran command';
  if (name === 'apply_patch') return 'Changed files';
  return name || 'Tool call';
}

export function codexThreadToBlocks(thread: JsonObject, rolloutTools: RolloutToolsByTurn = new Map()): CodexSessionBlock[] {
  const blocks: CodexSessionBlock[] = [];
  let seq = 0;
  const id = () => `c${seq++}`;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turn of turns) {
    const turnObject = objectValue(turn);
    const items = turnObject.items;
    if (!Array.isArray(items)) continue;
    const startedAt = strictSecondsToMillis(turnObject.startedAt);
    const completedAt = strictSecondsToMillis(turnObject.completedAt);
    // Desktop-hosted threads omit tool calls altogether; normal app-server
    // threads already contain them. Do not add the rollout copies when the
    // authoritative response has tool items for this turn.
    const hasThreadTools = items.some((raw) => !!toolStartFromItem(objectValue(raw)));
    const tools = hasThreadTools ? [] : rolloutTools.get(stringValue(turnObject.id)) ?? [];
    let assistantMessages = 0;
    const appendToolsAfter = (count: number) => {
      for (const tool of tools) {
        if (tool.afterAssistantMessages === count) {
          const { afterAssistantMessages: _position, ...block } = tool;
          blocks.push(block);
        }
      }
    };
    appendToolsAfter(0);
    for (const raw of items) {
      const item = objectValue(raw);
      const type = stringValue(item.type);
      if (type === 'userMessage') {
        const userMessage = userInput(item.content);
        if (userMessage.text.trim() || userMessage.attachments.length) {
          blocks.push({
            kind: 'user',
            id: id(),
            text: userMessage.text,
            ...(userMessage.attachments.length ? { attachments: userMessage.attachments } : {}),
            ...(startedAt !== undefined ? { at: startedAt } : {}),
          });
        }
        continue;
      }
      if (type === 'agentMessage') {
        const text = stringValue(item.text);
        if (text.trim()) {
          blocks.push({ kind: 'assistant', id: id(), text, ...(completedAt !== undefined ? { at: completedAt } : {}) });
          assistantMessages++;
          appendToolsAfter(assistantMessages);
        }
        continue;
      }
      if (type === 'reasoning' || type === 'plan') {
        const text = type === 'plan'
          ? stringValue(item.text)
          : [...stringArray(item.summary), ...stringArray(item.content)].join('\n');
        if (text.trim()) blocks.push({ kind: 'thinking', id: id(), text });
        continue;
      }
      const tool = toolStartFromItem(item);
      const result = toolResultFromItem(item);
      if (tool) {
        blocks.push({
          kind: 'tool',
          id: id(),
          name: tool.name,
          input: tool.input,
          status: result?.isError ? 'error' : 'done',
          ...(result?.content ? { result: result.content } : {}),
        });
      }
    }
    // A rollout can contain a final tool after the final assistant update.
    // Keep it in this turn rather than moving it to the end of the thread.
    for (const tool of tools) {
      if (tool.afterAssistantMessages > assistantMessages) {
        const { afterAssistantMessages: _position, ...block } = tool;
        blocks.push(block);
      }
    }
  }
  return blocks;
}

function userInput(value: unknown): { text: string; attachments: CodexAttachment[] } {
  if (!Array.isArray(value)) return { text: '', attachments: [] };
  const attachments: CodexAttachment[] = [];
  const text = value
    .map((input) => {
      const obj = objectValue(input);
      if (stringValue(obj.type) === 'text') return stringValue(obj.text);
      if (stringValue(obj.type) === 'image') return stringValue(obj.url);
      if (stringValue(obj.type) === 'localImage') {
        addHistoryImageAttachment(attachments, stringValue(obj.path));
        return '';
      }
      return stringValue(obj.name) || stringValue(obj.path);
    })
    .filter(Boolean)
    .join('\n');
  // The `Attached files:` suffix restore is already validated (images to
  // transient thumbnails, other known documents to name-only cards); keep its
  // results as-is rather than re-filtering to images, deduping by path and quote
  // so a passage and the whole file it came from both survive.
  const restored = restoreHistoryAttachments(text);
  for (const attachment of restored.attachments) {
    if (!attachments.some((existing) => existing.path === attachment.path && existing.quote === attachment.quote))
      attachments.push(attachment);
  }
  return { text: restored.text, attachments };
}

function addHistoryImageAttachment(attachments: CodexAttachment[], candidate: string): void {
  const attachment = historyImageAttachment(candidate);
  if (!attachment) return;
  if (attachments.some((attachment) => attachment.path === candidate)) return;
  attachments.push(attachment);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function secondsToMillis(value: unknown): number {
  return typeof value === 'number' ? Math.round(value * 1000) : Date.now();
}

/** Unlike secondsToMillis, absence stays absent: a missing turn time must
 * render as "no timestamp", never as a now() invented at replay time. */
function strictSecondsToMillis(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000)
    : undefined;
}
