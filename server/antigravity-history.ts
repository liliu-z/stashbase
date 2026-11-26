/**
 * Antigravity conversation history.
 *
 * `agy` keeps its conversations in a private store with no listing or
 * transcript interface (its `/resume` picker is interactive only). StashBase
 * therefore records, in app data, the Antigravity conversations its own chats
 * start: their project, title and the turns as the chat showed them. Resuming
 * still continues the native conversation by id; this record only lets the
 * chat list and replay find it. Removing a chat removes the record, not the
 * conversation inside Antigravity.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.ts';
import { filesystemPath } from './filesystem-path.ts';
import { appDataRoot } from './local-data.ts';
import type { AgentHistoryActions } from './agent-contract.ts';
import { restoreHistoryAttachments, type RestoredAttachment } from './agent-history-attachments.ts';
import { logger } from './log.ts';

const log = logger('antigravity-history');

export type AntigravityHistoryBlock =
  | { kind: 'user'; id: string; text: string; attachments?: RestoredAttachment[]; at?: number }
  | { kind: 'assistant'; id: string; text: string; at?: number }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; status: 'done' | 'error'; result?: string };

interface ConversationRecord {
  version: 1;
  id: string;
  folder: string;
  title: string;
  manualTitle?: boolean;
  createdAt: number;
  updatedAt: number;
  blocks: AntigravityHistoryBlock[];
}

interface AntigravitySessionRow {
  id: string;
  title: string;
  lastModified: number;
  hasContent: boolean;
  cwd: string;
}

/** A tool's recorded output is for orientation on replay, not a copy of
 * everything it read. */
const MAX_TOOL_RESULT_CHARS = 16_000;
const MAX_TOOL_INPUT_STRING_CHARS = 16_000;

class SessionNotFoundError extends Error {
  readonly status = 404;
  constructor() { super('session not found for current folder'); }
}

function antigravityHistoryDirectory(): string {
  return path.join(appDataRoot(), 'agent-history', 'antigravity');
}

function validId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) && !id.includes('..');
}

function recordFile(id: string, directory: string): string {
  if (!validId(id)) throw Object.assign(new Error('Invalid Antigravity conversation id.'), { status: 400 });
  return path.join(directory, `${id}.json`);
}

function readRecord(file: string): ConversationRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ConversationRecord>;
    if (parsed?.version !== 1 || typeof parsed.id !== 'string' || typeof parsed.folder !== 'string'
      || !Array.isArray(parsed.blocks)) return null;
    return {
      version: 1,
      id: parsed.id,
      folder: parsed.folder,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      ...(parsed.manualTitle === true ? { manualTitle: true } : {}),
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      blocks: parsed.blocks,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`unreadable Antigravity history ${file}:`, error);
    return null;
  }
}

function sameFolder(a: string, b: string): boolean {
  try { return filesystemPath.equal(a, b); } catch { return false; }
}

function toRow(record: ConversationRecord): AntigravitySessionRow {
  return {
    id: record.id,
    title: record.title || firstUserText(record) || record.id,
    lastModified: record.updatedAt,
    hasContent: record.blocks.length > 0,
    cwd: record.folder,
  };
}

function firstUserText(record: ConversationRecord): string {
  const first = record.blocks.find((block) => block.kind === 'user');
  return first?.kind === 'user' ? first.text.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 80) ?? '' : '';
}

function bounded(block: AntigravityHistoryBlock): AntigravityHistoryBlock {
  if (block.kind !== 'tool') return block;
  const input = Object.fromEntries(Object.entries(block.input).map(([key, value]) => [
    key,
    typeof value === 'string' && value.length > MAX_TOOL_INPUT_STRING_CHARS ? `${value.slice(0, MAX_TOOL_INPUT_STRING_CHARS)}…` : value,
  ]));
  const result = block.result && block.result.length > MAX_TOOL_RESULT_CHARS
    ? `${block.result.slice(0, MAX_TOOL_RESULT_CHARS)}…`
    : block.result;
  return { ...block, input, ...(result !== undefined ? { result } : {}) };
}

/** The record keeps each prompt as sent; replay lifts its `Attached files:`
 * and `Selected passages:` blocks back into cards, as the other runtimes'
 * history does, so a preview link is minted at read time. */
function replayBlocks(blocks: readonly AntigravityHistoryBlock[]): AntigravityHistoryBlock[] {
  return blocks.map((block) => {
    if (block.kind !== 'user') return block;
    const restored = restoreHistoryAttachments(block.text);
    return restored.attachments.length
      ? { ...block, text: restored.text, attachments: restored.attachments }
      : block;
  });
}

/** Writes to one conversation apply in order; different conversations do
 * not wait for each other. */
const writes = new Map<string, Promise<void>>();

export interface AntigravityHistoryStore {
  /** Append one turn's blocks, creating the record on the first turn. */
  appendTurn(id: string, folder: string, blocks: AntigravityHistoryBlock[], title?: string): Promise<void>;
  /** The title a resumed conversation already carries. */
  title(id: string): string | null;
  actions(): AgentHistoryActions;
}

export function createAntigravityHistoryStore(directoryOverride?: string): AntigravityHistoryStore {
  // Resolved per use, so app data moved after import (tests, a custom root) is honoured.
  const dir = () => directoryOverride ?? antigravityHistoryDirectory();
  const serialize = (id: string, write: () => void): Promise<void> => {
    const next = (writes.get(id) ?? Promise.resolve()).then(write, write);
    const settled = next.catch((error) => { log.warn(`Antigravity history write failed for ${id}:`, error); });
    writes.set(id, settled);
    void settled.finally(() => { if (writes.get(id) === settled) writes.delete(id); });
    return next;
  };

  const scoped = (id: string, folder: string): ConversationRecord => {
    const record = readRecord(recordFile(id, dir()));
    if (!record || !sameFolder(record.folder, folder)) throw new SessionNotFoundError();
    return record;
  };

  return {
    appendTurn(id, folder, blocks, title) {
      return serialize(id, () => {
        const file = recordFile(id, dir());
        const now = Date.now();
        const current = readRecord(file);
        const record: ConversationRecord = current && sameFolder(current.folder, folder)
          ? current
          : { version: 1, id, folder, title: '', createdAt: now, updatedAt: now, blocks: [] };
        if (!record.title && title) record.title = title;
        record.blocks.push(...blocks.map(bounded));
        record.updatedAt = now;
        writeFileAtomic(file, JSON.stringify(record));
      });
    },
    title(id) {
      if (!validId(id)) return null;
      return readRecord(recordFile(id, dir()))?.title || null;
    },
    actions() {
      return {
        async list(folder) {
          let names: string[];
          const directory = dir();
          try { names = await fs.promises.readdir(directory); } catch { return []; }
          return names
            .filter((name) => name.endsWith('.json'))
            .map((name) => readRecord(path.join(directory, name)))
            .filter((record): record is ConversationRecord => !!record && sameFolder(record.folder, folder))
            .map(toRow)
            .sort((a, b) => b.lastModified - a.lastModified);
        },
        async messages(id, folder) {
          return replayBlocks(scoped(id, folder).blocks);
        },
        async replay(id, folder) {
          return { protocol: 2, messages: replayBlocks(scoped(id, folder).blocks), effort: null };
        },
        async rename(id, title, folder) {
          scoped(id, folder);
          let row: AntigravitySessionRow | null = null;
          await serialize(id, () => {
            const record = scoped(id, folder);
            record.title = title;
            record.manualTitle = true;
            writeFileAtomic(recordFile(id, dir()), JSON.stringify(record));
            row = toRow(record);
          });
          return row;
        },
        async remove(id, folder) {
          scoped(id, folder);
          await serialize(id, () => {
            scoped(id, folder);
            fs.rmSync(recordFile(id, dir()), { force: true });
          });
        },
      };
    },
  };
}

export const antigravityHistory = createAntigravityHistoryStore();
