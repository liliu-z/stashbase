/**
 * What each Agent turn changed in a project's Markdown files.
 *
 * The host cannot see most Agent writes. Native Write/Edit tools, Codex
 * patches and OpenCode writes happen inside the runtime's own process, and a
 * shell command names no file at all. The turn lifecycle on the Agent socket is
 * the one thing every runtime shares, so the host compares the folder's
 * Markdown before a prompt reaches the runtime with what is on disk when the
 * runtime ends the turn. Anything that changed in between is the turn's,
 * including an edit the reader made during it; the review shows that edit like
 * any other and the reader keeps it.
 *
 * Recorded turns live in memory and die with the process: a durable copy of old
 * document text would need its own staleness and recovery rules. A renamed file
 * is not followed; its review answers 404 the
 * way an expired turn does.
 *
 * Tracking is best effort by design. A failed scan leaves the turn untracked
 * rather than delaying or failing it, because the Agent's work matters more
 * than the review of it.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { WebSocket } from 'ws';

import type { AgentServerEvent, AgentTurnChangedFile } from '../shared/protocols/websocket/agent-session.ts';
import { MAX_TURN_CHANGED_FILES } from '../shared/protocols/websocket/agent-session.ts';
import { readFileBytesBoundedAsync } from './active-file-operations.ts';
import { walkMarkdownSourcesAsync } from './file-listing.ts';
import { filesystemPath } from './filesystem-path.ts';
import { errorMessage, logger } from './log.ts';
import { decodeDirectTextBytes } from './text-decoding.ts';
import { textVersion } from './text-file-transaction.ts';

const log = logger('turn-changes');

/** Larger documents are not tracked for per-change prose review. */
const MAX_TRACKED_FILE_BYTES = 1024 * 1024;

/** Every prompt rescans the folder, so the number of files read and held must
 *  not grow with the size of a vault. Files past either bound are untracked
 *  for that turn, never reported as created or deleted. */
const MAX_TRACKED_FILES = 5000;
const MAX_TRACKED_BYTES = 32 * 1024 * 1024;

/** Enough history to review the turns of one sitting. */
const MAX_RECORDED_TURNS_PER_FOLDER = 20;

/** A turn nobody reviews is released by age. */
const TURN_TTL_MS = 6 * 60 * 60 * 1000;

/** Coarse filesystems store mtime to the second or two. A file whose mtime is
 *  this close to when it was read could be rewritten at the same size without
 *  its mtime moving, so it is read again rather than trusted from cache. */
const RACY_MTIME_WINDOW_MS = 2000;

/** What one scan saw of one Markdown file. `version` is `textVersion` of the
 *  bytes, the token the renderer's source load returns, which is what makes
 *  the renderer's stale gate a plain string comparison. */
interface ScannedFile {
  mtimeMs: number;
  size: number;
  readAtMs: number;
  version: string;
  text: string;
}

interface FolderScan {
  /** Absolute POSIX path to the file as read. */
  files: ReadonlyMap<string, ScannedFile>;
  /** Files that exist but were past a bound. Their absence from `files` says
   *  nothing about whether the turn created or deleted them. */
  untracked: ReadonlySet<string>;
}

export interface TurnBaseline {
  readonly folder: string;
  readonly scan: FolderScan;
}

export interface TurnChanges {
  turnId: string;
  files: AgentTurnChangedFile[];
}

/** A file the reader can open and review. `before` is the whole document
 *  before the turn, empty for a created file; `afterVersion` is what the turn
 *  left on disk. */
export interface TurnChangeBefore {
  change: 'created' | 'edited';
  before: string;
  afterVersion: string;
}

type RecordedFile = TurnChangeBefore | { change: 'deleted'; before: string };

interface RecordedTurn {
  turnId: string;
  folder: string;
  endedAt: number;
  /** Only the files the turn changed. */
  files: Map<string, RecordedFile>;
}

/** The last scan of each folder, so an unchanged file is not read again on the
 *  next prompt. Each scan builds its own map and replaces this one, so two
 *  sessions scanning the same folder never see each other's half-done work. */
const scanCache = new Map<string, ReadonlyMap<string, ScannedFile>>();

/** Insertion order is end order, which the per-folder retention relies on. */
const recordedTurns = new Map<string, RecordedTurn>();

async function scanFolder(folder: string): Promise<FolderScan> {
  const previous = scanCache.get(folder);
  const files = new Map<string, ScannedFile>();
  const untracked = new Set<string>();
  let bytes = 0;
  await walkMarkdownSourcesAsync(folder, async (rel, full) => {
    const abs = filesystemPath.join(folder, rel);
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(full); }
    // Gone between the directory read and the stat: absent, like any deletion.
    catch { return; }
    if (stat.size > MAX_TRACKED_FILE_BYTES || files.size >= MAX_TRACKED_FILES || bytes + stat.size > MAX_TRACKED_BYTES) {
      untracked.add(abs);
      return;
    }
    const cached = previous?.get(abs);
    const reusable = cached
      && cached.mtimeMs === stat.mtimeMs
      && cached.size === stat.size
      && stat.mtimeMs < cached.readAtMs - RACY_MTIME_WINDOW_MS;
    let file: ScannedFile;
    if (reusable) {
      file = cached;
    } else {
      try {
        const readAtMs = Date.now();
        const content = await readFileBytesBoundedAsync(full, MAX_TRACKED_FILE_BYTES);
        // The stat precedes the read, so a write racing the read leaves a stale
        // mtime in the cache and the next scan reads the file again.
        file = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          readAtMs,
          version: textVersion(content),
          text: decodeDirectTextBytes(rel, content),
        };
      } catch {
        untracked.add(abs);
        return;
      }
    }
    files.set(abs, file);
    bytes += file.size;
  });
  scanCache.set(folder, files);
  return { files, untracked };
}

/** Capture the folder's Markdown as it stands before a prompt reaches the
 *  runtime. */
export async function beginTurnBaseline(folder: string): Promise<TurnBaseline> {
  return { folder, scan: await scanFolder(folder) };
}

/** Rescan, record what the turn changed, and say so; null when nothing did. */
export async function finishTurn(baseline: TurnBaseline, now: () => number = Date.now): Promise<TurnChanges | null> {
  const before = baseline.scan;
  const after = await scanFolder(baseline.folder);
  const files = new Map<string, RecordedFile>();
  const reported: AgentTurnChangedFile[] = [];
  for (const [path, file] of after.files) {
    const previous = before.files.get(path);
    if (previous ? previous.version === file.version : before.untracked.has(path)) continue;
    const change = previous ? 'edited' : 'created';
    files.set(path, { change, before: previous?.text ?? '', afterVersion: file.version });
    reported.push({ path, change, ...countLineChanges(previous?.text ?? '', file.text) });
  }
  for (const [path, file] of before.files) {
    if (after.files.has(path) || after.untracked.has(path)) continue;
    files.set(path, { change: 'deleted', before: file.text });
    reported.push({ path, change: 'deleted', ...countLineChanges(file.text, '') });
  }
  if (!files.size) return null;
  sweepExpired(now());
  const turnId = randomUUID();
  recordedTurns.set(turnId, { turnId, folder: baseline.folder, endedAt: now(), files });
  retainNewest(baseline.folder);
  reported.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { turnId, files: reported.slice(0, MAX_TURN_CHANGED_FILES) };
}

/** The pre-turn text of one file a recorded turn changed. Reading does not
 *  consume it: the reader may review the same turn twice. */
export function turnChangeBefore(
  folder: string,
  turnId: string,
  path: string,
  now: () => number = Date.now,
): TurnChangeBefore | null {
  sweepExpired(now());
  const turn = recordedTurns.get(turnId);
  if (!turn || !filesystemPath.equal(turn.folder, folder)) return null;
  for (const [recordedPath, file] of turn.files) {
    if (!filesystemPath.equal(recordedPath, path)) continue;
    if (file.change === 'deleted') return null;
    return { change: file.change, before: file.before, afterVersion: file.afterVersion };
  }
  return null;
}

/** Removing a project, or deleting or renaming one of its folders, retires the
 *  recorded text beneath it. A retained nested project keeps its own. */
export function forgetFolderTurnChanges(folder: string, retainedRoots: readonly string[] = []): void {
  const retired = (path: string) => filesystemPath.contains(folder, path)
    && !retainedRoots.some((root) => filesystemPath.contains(root, path));
  for (const turn of [...recordedTurns.values()]) {
    for (const path of [...turn.files.keys()]) {
      if (retired(path)) turn.files.delete(path);
    }
    if (!turn.files.size) recordedTurns.delete(turn.turnId);
  }
  for (const root of [...scanCache.keys()]) {
    if (retired(root)) scanCache.delete(root);
  }
}

function sweepExpired(nowMs: number): void {
  for (const turn of [...recordedTurns.values()]) {
    if (nowMs - turn.endedAt >= TURN_TTL_MS) recordedTurns.delete(turn.turnId);
  }
}

function retainNewest(folder: string): void {
  const own = [...recordedTurns.values()].filter((turn) => filesystemPath.equal(turn.folder, folder));
  for (const turn of own.slice(0, Math.max(0, own.length - MAX_RECORDED_TURNS_PER_FOLDER))) {
    recordedTurns.delete(turn.turnId);
  }
}

/** Lines added and removed, counted as a multiset difference rather than an
 *  alignment. A moved line counts as neither, which is close enough for a
 *  summary and needs no diff dependency. */
function countLineChanges(before: string, after: string): { additions: number; deletions: number } {
  const remaining = new Map<string, number>();
  for (const line of lines(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of lines(after)) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else additions++;
  }
  let deletions = 0;
  for (const count of remaining.values()) deletions += count;
  return { additions, deletions };
}

function lines(text: string): string[] {
  if (!text) return [];
  const split = text.split(/\r?\n/);
  if (split.at(-1) === '') split.pop();
  return split;
}

function isClientPrompt(raw: unknown): boolean {
  try { return (JSON.parse(String(raw)) as { t?: unknown } | null)?.t === 'prompt'; }
  catch { return false; }
}

/** The turn boundary an outbound event marks, if any. */
function turnBoundary(data: unknown): 'turn-start' | 'turn-end' | null {
  // Cheap filter first: every text delta passes through here, and a delta that
  // merely quotes the event is escaped, so it cannot match.
  if (typeof data !== 'string' || !/"t":"turn-(start|end)"/.test(data)) return null;
  try {
    const t = (JSON.parse(data) as { t?: unknown } | null)?.t;
    return t === 'turn-start' || t === 'turn-end' ? t : null;
  } catch { return null; }
}

/**
 * Bracket every Agent turn on this socket with a baseline and a report.
 *
 * This wraps the socket rather than any runtime because it is the one seam all
 * of them pass through. The baseline must exist before the runtime can act on
 * the prompt, so a prompt and everything that arrives after it are held until
 * the capture settles, then delivered in arrival order. Holding every event,
 * not only messages, keeps a `close` from overtaking the prompt it followed.
 * A second prompt after the runtime started a turn is one it refuses as
 * concurrent, so the earlier baseline still describes the running turn. A
 * prompt the runtime refused without starting a turn (an empty one, an unknown
 * skill) leaves no turn to report, so the next prompt replaces its baseline
 * rather than crediting the edits in between to the next turn.
 */
export function trackAgentTurns(ws: WebSocket, folder: string): void {
  const emit = ws.emit.bind(ws);
  const send = ws.send.bind(ws);
  let baseline: Promise<TurnBaseline | null> | null = null;
  let started = false;
  let held: Array<[string | symbol, unknown[]]> | null = null;

  ws.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    if (held) {
      held.push([event, args]);
      return true;
    }
    if (event !== 'message' || (baseline && started) || !isClientPrompt(args[0])) return emit(event, ...args);
    held = [[event, args]];
    started = false;
    const capture = beginTurnBaseline(folder).catch((error: unknown) => {
      log.debug(`baseline for ${folder} failed; the turn is untracked: ${errorMessage(error)}`);
      return null;
    });
    baseline = capture;
    void capture.then(() => {
      const queued = held ?? [];
      held = null;
      for (const [queuedEvent, queuedArgs] of queued) emit(queuedEvent, ...queuedArgs);
    });
    return true;
  }) as typeof ws.emit;

  ws.send = ((data: Parameters<WebSocket['send']>[0], ...rest: unknown[]): void => {
    (send as (...args: unknown[]) => void)(data, ...rest);
    if (!baseline) return;
    const boundary = turnBoundary(data);
    if (boundary === 'turn-start') started = true;
    if (boundary !== 'turn-end') return;
    const pending = baseline;
    baseline = null;
    void report(pending);
  }) as typeof ws.send;

  async function report(pending: Promise<TurnBaseline | null>): Promise<void> {
    const started = await pending;
    if (!started) return;
    let changes: TurnChanges | null;
    try { changes = await finishTurn(started); }
    catch (error: unknown) {
      log.debug(`rescan of ${folder} failed; the turn is untracked: ${errorMessage(error)}`);
      return;
    }
    if (!changes || ws.readyState !== ws.OPEN) return;
    const event: AgentServerEvent = { t: 'turn-changes', turnId: changes.turnId, files: changes.files };
    try { send(JSON.stringify(event)); } catch { /* socket gone */ }
  }
}
