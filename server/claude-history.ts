/** Native Claude transcript and history adapter.
 * Shared Agent routes own HTTP scope validation. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listSessions,
  getSessionMessages,
  getSessionInfo,
  renameSession,
  deleteSession,
  type SDKSessionInfo,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { filesystemPath } from './filesystem-path.ts';
import { type AgentHistoryActions } from './agent-contract.ts';
import { restoreHistoryAttachments, type RestoredAttachment } from './agent-history-attachments.ts';

/** Trimmed session row sent to the client. */
interface SessionRow {
  id: string;
  title: string;
  lastModified: number;
  hasContent: boolean;
  cwd?: string;
  gitBranch?: string;
}

class SessionNotFoundError extends Error {
  readonly status = 404;
  constructor() { super('session not found for current folder'); }
}

function toRow(s: SDKSessionInfo): SessionRow {
  return {
    id: s.sessionId,
    title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
    lastModified: s.lastModified,
    hasContent: true,
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}),
  };
}

/** Claude history follows the native session cwd. */
interface ClaudeHistoryDependencies {
  getMessages: typeof getSessionMessages;
  readNativeTranscript: typeof readClaudeNativeTranscript;
  belongsToFolder: typeof sessionBelongsToFolder;
}

export function claudeHistoryActions(overrides: Partial<ClaudeHistoryDependencies> = {}): AgentHistoryActions {
  const getMessages = overrides.getMessages ?? getSessionMessages;
  const readNativeTranscript = overrides.readNativeTranscript ?? readClaudeNativeTranscript;
  const belongsToFolder = overrides.belongsToFolder ?? sessionBelongsToFolder;
  return {
    async list(folder) {
      const sessions = await listSessions();
      return sessions.map(toRow)
        .filter((row) => sessionInfoMatchesFolder(row, folder))
        .sort((a, b) => b.lastModified - a.lastModified);
    },
    async messages(id, folder) {
      if (!(await belongsToFolder(id, folder))) throw new SessionNotFoundError();
      const messages = await getMessages(id);
      const native = await readNativeTranscript(id);
      return transcriptToBlocks(withFollowUps(messages, native), nativeTimesByUuid(native));
    },
    async replay(id, folder) {
      if (!(await belongsToFolder(id, folder))) throw new SessionNotFoundError();
      // The SDK intentionally sanitizes history after selecting the active
      // chain. Keep those UUIDs for chain authority, but join them back to the
      // raw JSONL entries to recover metadata the SDK response omits.
      const messages = await getMessages(id);
      const native = await readNativeTranscript(id);
      return {
        protocol: 2,
        messages: transcriptToBlocks(withFollowUps(messages, native), nativeTimesByUuid(native)),
        effort: claudeTranscriptEffort(native, messages),
      };
    },
    async rename(id, title, folder) {
      if (!(await belongsToFolder(id, folder))) throw new SessionNotFoundError();
      await renameSession(id, title);
      const info = await getSessionInfo(id);
      return info ? toRow(info) : { id, title, lastModified: 0 };
    },
    async remove(id, folder) {
      if (!(await belongsToFolder(id, folder))) throw new SessionNotFoundError();
      await deleteSession(id);
    },
  };
}

type NativeTranscriptEntry = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  attachment?: unknown;
  effort?: unknown;
  timestamp?: unknown;
  message?: unknown;
};

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Recover raw effort for the newest assistant UUID selected by the SDK's
 * active-chain reader. A future value is deliberately unknown; walking back
 * would silently replace newer native semantics with stale supported data. */
export function claudeTranscriptEffort(
  native: NativeTranscriptEntry[],
  active: Array<Pick<SessionMessage, 'type' | 'uuid'>>,
): string | null {
  const byId = new Map(native.flatMap((entry) =>
    typeof entry.uuid === 'string' && entry.uuid ? [[entry.uuid, entry] as const] : []));
  const latest = [...active].reverse().find((entry) => entry.type === 'assistant');
  if (!latest) return null;
  const raw = byId.get(latest.uuid);
  const message = raw?.message as { effort?: unknown } | null | undefined;
  const value = raw?.effort ?? message?.effort;
  return typeof value === 'string' && CLAUDE_EFFORTS.has(value) ? value : null;
}

/** Read the native session JSONL without trusting the renderer-supplied id as
 * a path. Claude may use a hashed project-directory name, so search only the
 * immediate SDK projects directories for the exact UUID filename. */
async function readClaudeNativeTranscript(sessionId: string): Promise<NativeTranscriptEntry[]> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return [];
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  const projectsDir = path.join(configDir, 'projects');
  let projects: import('node:fs').Dirent[];
  try { projects = await fs.readdir(projectsDir, { withFileTypes: true }); }
  catch { return []; }
  for (const project of projects) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue;
    try {
      const text = await fs.readFile(path.join(projectsDir, project.name, `${sessionId}.jsonl`), 'utf8');
      return text.split(/\r?\n/).flatMap((line): NativeTranscriptEntry[] => {
        if (!line.trim()) return [];
        try {
          const value = JSON.parse(line) as NativeTranscriptEntry;
          return value && typeof value === 'object' && typeof value.type === 'string' ? [value] : [];
        } catch { return []; }
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return [];
    }
  }
  return [];
}

async function sessionBelongsToFolder(id: string, folder: string): Promise<boolean> {
  const info = await getSessionInfo(id);
  return sessionInfoMatchesFolder(info, folder);
}

export function sessionInfoMatchesFolder(info: { cwd?: unknown } | null | undefined, folder: string): boolean {
  return !!(info && typeof info.cwd === 'string'
    && info.cwd.trim()
    && filesystemPath.equal(info.cwd, folder));
}

// ----- transcript → panel blocks ----------------------------------------

/** The renderable block shape the client's BlockView consumes. Mirrors
 *  AgentView's `Block` union (history tools are always settled: 'done' or
 *  'error'). */
type WireBlock =
  /** `at` (epoch ms) joins the SDK message back to its native JSONL line
   * by uuid — the SDK response is sanitized and carries no timestamp, the
   * native line does. Absent when the join finds no valid time; replay
   * never substitutes a clock of its own. */
  | { kind: 'user'; id: string; text: string; attachments?: RestoredAttachment[]; at?: number }
  | { kind: 'assistant'; id: string; text: string; at?: number }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; status: 'done' | 'error'; result?: string };

/** Walk a session's messages in order into panel blocks, stitching each
 *  `tool_result` (which arrives as a later user-role message) back onto
 *  its originating `tool_use` block by id — the same correlation the live
 *  WS path does, just replayed from disk. */
export function transcriptToBlocks(
  msgs: Array<{ type: string; uuid?: string; message: unknown }>,
  timeByUuid?: Map<string, number>,
): WireBlock[] {
  const blocks: WireBlock[] = [];
  const toolById = new Map<string, Extract<WireBlock, { kind: 'tool' }>>();
  let seq = 0;
  const id = () => `h${seq++}`;

  for (const m of msgs) {
    const message = m.message as { role?: string; content?: unknown };
    const content = message?.content;
    const at = m.uuid ? timeByUuid?.get(m.uuid) : undefined;

    if (m.type === 'user') {
      if (typeof content === 'string') {
        appendUserBlock(blocks, id, content, at);
        continue;
      }
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text);
          } else if (b.type === 'tool_result') {
            const tool = toolById.get(String(b.tool_use_id));
            if (tool) {
              tool.result = stringifyToolResult(b.content);
              if (b.is_error === true) tool.status = 'error';
            }
          }
        }
        appendUserBlock(blocks, id, texts.join('\n').trim(), at);
      }
      continue;
    }

    if (m.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          blocks.push({ kind: 'assistant', id: id(), text: b.text, ...(at !== undefined ? { at } : {}) });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          blocks.push({ kind: 'thinking', id: id(), text: b.thinking });
        } else if (b.type === 'tool_use') {
          const tool: Extract<WireBlock, { kind: 'tool' }> = {
            kind: 'tool',
            id: id(),
            name: String(b.name ?? ''),
            input: (b.input as Record<string, unknown>) ?? {},
            status: 'done',
          };
          toolById.set(String(b.id), tool);
          blocks.push(tool);
        }
      }
    }
  }
  return blocks;
}

function appendUserBlock(blocks: WireBlock[], id: () => string, text: string, at?: number): void {
  const restored = restoreHistoryAttachments(text);
  if (!restored.text.trim() && restored.attachments.length === 0) return;
  blocks.push({
    kind: 'user',
    id: id(),
    text: restored.text,
    ...(restored.attachments.length ? { attachments: restored.attachments } : {}),
    ...(at !== undefined ? { at } : {}),
  });
}

type HistoryMessage = { type: string; uuid?: string; message: unknown };

/** Claude records a follow-up it read mid-turn as a `queued_command`
 *  attachment, which the SDK's history reader leaves out. Each goes back as a
 *  user message after the message its chain hangs from, so a reopened chat
 *  shows what the reader sent where Claude read it. */
function withFollowUps(
  messages: HistoryMessage[],
  native: NativeTranscriptEntry[],
): HistoryMessage[] {
  const byUuid = new Map(native.flatMap((entry) =>
    typeof entry.uuid === 'string' && entry.uuid ? [[entry.uuid, entry] as const] : []));
  const listed = new Set(messages.flatMap((message) => (message.uuid ? [message.uuid] : [])));
  const after = new Map<string, HistoryMessage[]>();
  for (const entry of native) {
    const attachment = entry.attachment as { type?: unknown; prompt?: unknown; commandMode?: unknown } | undefined;
    if (entry.type !== 'attachment' || entry.isSidechain || !entry.uuid) continue;
    if (attachment?.type !== 'queued_command' || typeof attachment.prompt !== 'string') continue;
    if (attachment.commandMode !== undefined && attachment.commandMode !== 'prompt') continue;
    // Attachments chain to one another; the anchor is the nearest ancestor
    // the SDK kept in the conversation.
    let anchor = entry.parentUuid ?? null;
    const seen = new Set<string>();
    while (anchor && !listed.has(anchor) && !seen.has(anchor)) {
      seen.add(anchor);
      anchor = byUuid.get(anchor)?.parentUuid ?? null;
    }
    if (!anchor) continue;
    const followUps = after.get(anchor) ?? [];
    followUps.push({ type: 'user', uuid: entry.uuid, message: { role: 'user', content: attachment.prompt } });
    after.set(anchor, followUps);
  }
  if (after.size === 0) return messages;
  return messages.flatMap((message) => [message, ...(message.uuid ? after.get(message.uuid) ?? [] : [])]);
}

/** Native-line times keyed by uuid. Only real, parseable timestamps enter
 * the map — a missing or malformed one simply leaves the message timeless. */
export function nativeTimesByUuid(native: NativeTranscriptEntry[]): Map<string, number> {
  const times = new Map<string, number>();
  for (const entry of native) {
    if (typeof entry.uuid !== 'string' || typeof entry.timestamp !== 'string') continue;
    const ms = Date.parse(entry.timestamp);
    if (Number.isFinite(ms)) times.set(entry.uuid, ms);
  }
  return times;
}

/** Stringify a tool_result `content` (string, or text/other blocks) into
 *  renderable text, for live tool results and replayed history alike. */
export function stringifyToolResult(content: unknown): string {
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
