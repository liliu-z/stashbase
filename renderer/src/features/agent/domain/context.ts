/**
 * Bound Agent context: project sources a prompt mentions or attaches, and
 * transient uploads the runtime reads from a temp path. Every item is bound
 * to explicit identity, so a send can re-check it against the live scope
 * instead of trusting a path typed minutes ago.
 */
import {
  isRetrievableViewerFormat,
  VIEWABLE_FILE_EXTENSION_ALTERNATION,
  type ViewerFormat,
} from '@/contracts/file-formats';
import type { AgentScope } from '@/features/agent/domain/session';
import type { SourceReference } from '@/shared/domain/source-reference';
import { basePathName } from '@/shared/utils/file-path';

type AgentSourceFormat = ViewerFormat;

export interface AgentScopeListing {
  /** Folder-relative source paths with their listing format. */
  files: ReadonlyArray<{ path: string; format: AgentSourceFormat }>;
  /** Folder-relative paths of normal folders. */
  folders: readonly string[];
}

export type AgentContextReadiness = 'current' | 'pending' | 'blocked' | 'failed' | 'cancelled';

export type AgentContextItem =
  | {
      kind: 'source';
      source: SourceReference;
      format: AgentSourceFormat;
      /** Conversion version seen when the item was bound; null when unknown. */
      boundVersion: number | null;
    }
  | {
      kind: 'passage';
      source: SourceReference;
      /** The selected Markdown, sent verbatim: a later edit to the file
       *  cannot change what the reader asked about. */
      quote: string;
    }
  | {
      kind: 'transient';
      path: string;
      name: string;
      dims?: string | undefined;
      previewUrl?: string | undefined;
    };

/** The most selected text one passage carries, near Humanize's own limit. */
export const PASSAGE_QUOTE_LIMIT = 6_000;

/** FNV-1a, enough to tell two passages of one file apart in a key. */
function quoteDigest(quote: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < quote.length; index += 1) {
    hash ^= quote.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export function contextItemKey(item: AgentContextItem): string {
  switch (item.kind) {
    case 'source':
      return `source:${item.source.folderPath}/${item.source.path}`;
    case 'passage':
      return `passage:${item.source.folderPath}/${item.source.path}#${quoteDigest(item.quote)}`;
    case 'transient':
      return `transient:${item.path}`;
  }
}

export function contextItemName(item: AgentContextItem): string {
  return item.kind === 'transient'
    ? item.name || basePathName(item.path)
    : basePathName(item.source.path);
}

/** A passage of `source`, or null when the selection holds no text. */
export function passageContextItem(
  source: SourceReference,
  quote: string,
): Extract<AgentContextItem, { kind: 'passage' }> | null {
  const trimmed = quote.trim();
  return trimmed ? { kind: 'passage', quote: trimmed, source } : null;
}

export function addContextItem(
  items: readonly AgentContextItem[],
  item: AgentContextItem,
): AgentContextItem[] {
  const key = contextItemKey(item);
  if (items.some((existing) => contextItemKey(existing) === key)) return [...items];
  return [...items, item];
}

export function removeContextItem(
  items: readonly AgentContextItem[],
  key: string,
): AgentContextItem[] {
  return items.filter((item) => contextItemKey(item) !== key);
}

// Mention ranking

export interface MentionSuggestion {
  kind: 'file' | 'folder';
  path: string;
  format?: AgentSourceFormat;
}

function normalizeMentionText(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\p{M}\p{P}\p{Z}]+/gu, '');
}

function mentionScore(path: string, query: string): number | null {
  if (!query) return 5;
  const fileName = normalizeMentionText(basePathName(path));
  const lowerPath = normalizeMentionText(path);
  if (fileName === query) return 0;
  if (fileName.startsWith(query)) return 1;
  if (fileName.includes(query)) return 2;
  if (lowerPath.startsWith(query)) return 3;
  if (lowerPath.includes(query)) return 4;
  return null;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rank the scope item a person is most likely typing and keep ties stable.
 *  A document already open beside the chat wins an otherwise equal score, so
 *  an empty `@` leads with what the user is looking at. */
export function rankMentionSuggestions(
  listing: AgentScopeListing | null,
  query: string,
  openPaths: readonly string[] = [],
  limit = 8,
): MentionSuggestion[] {
  if (!listing) return [];
  const open = new Set(openPaths);
  const needle = normalizeMentionText(query);
  const suggestions: MentionSuggestion[] = [
    ...listing.files
      .filter((file) => isRetrievableViewerFormat(file.format))
      .map((file) => ({ format: file.format, kind: 'file' as const, path: file.path })),
    ...listing.folders.map((path) => ({ kind: 'folder' as const, path })),
  ];
  const ranked = suggestions
    .map((suggestion) => ({ score: mentionScore(suggestion.path, needle), suggestion }))
    .filter(
      (candidate): candidate is { score: number; suggestion: MentionSuggestion } =>
        candidate.score !== null,
    );
  const openRank = (suggestion: MentionSuggestion) => (open.has(suggestion.path) ? 0 : 1);
  ranked.sort(
    (a, b) =>
      a.score - b.score ||
      openRank(a.suggestion) - openRank(b.suggestion) ||
      basePathName(a.suggestion.path).length - basePathName(b.suggestion.path).length ||
      comparePaths(a.suggestion.path, b.suggestion.path),
  );
  return ranked.slice(0, limit).map((candidate) => candidate.suggestion);
}

// Mention text editing

export interface MentionQuery {
  /** Which marker opened the query: `@` for a file, `/` for a skill. */
  kind: 'mention' | 'skill';
  /** Index of the marker that opens the query. */
  from: number;
  query: string;
}

const MENTION_QUERY_RE = /(^|\s)@([^\s@]*)$/u;

export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const match = MENTION_QUERY_RE.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[2] ?? '';
  return { from: caret - query.length - 1, kind: 'mention', query };
}

export function applyMention(
  text: string,
  query: MentionQuery,
  path: string,
): { text: string; caret: number } {
  const end = query.from + 1 + query.query.length;
  const next = text[end];
  const run = `@${path}${next === undefined || !/\s/u.test(next) ? ' ' : ''}`;
  return {
    caret: query.from + run.length,
    text: text.slice(0, query.from) + run + text.slice(end),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function removeMentionText(text: string, path: string): string {
  const run = new RegExp(`(^|\\s)@${escapeRegExp(path)}(?=$|\\s)( ?)`, 'gu');
  return text.replace(run, (_raw, lead: string, space: string) => (space ? lead : ''));
}

// Validation

export type ContextStatus = 'ready' | 'preparing' | 'failed' | 'blocked' | 'stale';

export interface ContextValidation {
  item: AgentContextItem;
  key: string;
  status: ContextStatus;
  reason: string | null;
}

export interface ContextEnvironment {
  listing: AgentScopeListing | null;
  readiness: Readonly<Record<string, AgentContextReadiness>>;
  scope: AgentScope;
  versions?: Readonly<Record<string, number>> | undefined;
  hasUpload?: ((path: string) => boolean) | undefined;
}

function validateItem(item: AgentContextItem, environment: ContextEnvironment): ContextValidation {
  const key = contextItemKey(item);
  if (item.kind === 'transient')
    return environment.hasUpload && !environment.hasUpload(item.path)
      ? {
          item,
          key,
          reason: 'Attachment unavailable. Reattach it or remove it before sending.',
          status: 'stale',
        }
      : { item, key, reason: null, status: 'ready' };
  if (environment.scope.kind !== 'folder' || environment.scope.path !== item.source.folderPath) {
    return { item, key, reason: 'This file belongs to a different folder.', status: 'stale' };
  }
  if (
    environment.listing &&
    !environment.listing.files.some((file) => file.path === item.source.path)
  ) {
    return { item, key, reason: 'This file is no longer in the folder.', status: 'stale' };
  }
  // The quote travels in the prompt, so neither a later edit nor preparation
  // changes what a passage says; only its length can refuse it.
  if (item.kind === 'passage')
    return item.quote.length > PASSAGE_QUOTE_LIMIT
      ? {
          item,
          key,
          reason: `This passage is longer than ${PASSAGE_QUOTE_LIMIT.toLocaleString('en-US')} characters. Select less and ask again.`,
          status: 'stale',
        }
      : { item, key, reason: null, status: 'ready' };
  const version = environment.versions?.[item.source.path];
  if (version !== undefined && item.boundVersion !== null && version !== item.boundVersion)
    return {
      item,
      key,
      reason: 'This file changed. Remove it and attach the latest version.',
      status: 'stale',
    };
  switch (environment.readiness[item.source.path]) {
    case 'pending':
      return { item, key, reason: 'Searchable text is still being prepared.', status: 'preparing' };
    case 'failed':
    case 'cancelled':
      return {
        item,
        key,
        reason: 'Preparation failed; the Agent gets the source only.',
        status: 'failed',
      };
    case 'blocked':
      return { item, key, reason: 'Preparation is blocked.', status: 'blocked' };
    default:
      return { item, key, reason: null, status: 'ready' };
  }
}

export function validateContext(
  items: readonly AgentContextItem[],
  environment: ContextEnvironment,
): ContextValidation[] {
  return items.map((item) => validateItem(item, environment));
}

/** Only a stale item blocks a send; the rest are explained and sent. */
export function staleContext(validations: readonly ContextValidation[]): ContextValidation[] {
  return validations.filter((validation) => validation.status === 'stale');
}

// Transcript segmentation

export type FileMentionSegment =
  | { kind: 'text'; text: string }
  /** `start` is the span's offset in the source text, a stable key for a chip. */
  | { kind: 'mention'; path: string; start: number };

const FILE_MENTION_RE = new RegExp(
  `(^|\\s)@([^\\n]*?\\.(?:${VIEWABLE_FILE_EXTENSION_ALTERNATION}))(?![/.])`,
  'giu',
);

/* Bare multi-segment paths chip too: history replay and some runtimes
 * serialize a mention without its `@`. At least one `/` keeps ordinary
 * "README.md" prose as text. */
const BARE_FILE_PATH_RE = new RegExp(
  `(^|\\s)((?:[^\\s/@]+/)+[^\\s/]+?\\.(?:${VIEWABLE_FILE_EXTENSION_ALTERNATION}))(?![\\w./])`,
  'giu',
);

/** Split user text into plain runs and file-mention spans: `@` mentions,
 *  bare multi-segment paths, and exact occurrences of this turn's attachment
 *  paths. Overlapping hits keep the earliest, longest match. */
export function segmentFileMentions(
  text: string,
  attachmentPaths: readonly string[] = [],
): FileMentionSegment[] {
  const hits: Array<{ start: number; end: number; path: string; lead: string }> = [];
  const collect = (re: RegExp) => {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const [raw, lead = '', path = ''] = match;
      hits.push({ end: match.index + raw.length, lead, path, start: match.index });
    }
  };
  collect(FILE_MENTION_RE);
  collect(BARE_FILE_PATH_RE);
  for (const path of attachmentPaths) {
    if (!path) continue;
    let from = 0;
    for (let at = text.indexOf(path, from); at !== -1; at = text.indexOf(path, from)) {
      hits.push({ end: at + path.length, lead: '', path, start: at });
      from = at + path.length;
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const segments: FileMentionSegment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, hit.start) });
    if (hit.lead) segments.push({ kind: 'text', text: hit.lead });
    segments.push({ kind: 'mention', path: hit.path, start: hit.start });
    cursor = hit.end;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments.length ? segments : [{ kind: 'text', text }];
}

/** The window folder's live listing and preparation state, published by the
 *  shell so every session bound to that folder validates against it. */
export interface AgentScopeEnvironment {
  folderPath: string;
  listing: AgentScopeListing;
  /** Folder-relative paths of the documents open beside the chat, so an `@`
   *  list can lead with what the user is looking at. */
  openPaths?: readonly string[];
  /** The document in front of the reader while the Agent docks beside it,
   *  which the composer offers to attach. Null in Chats, where no document
   *  is on screen. */
  activeSource?: SourceReference | null;
  readiness: Readonly<Record<string, AgentContextReadiness>>;
  versions: Readonly<Record<string, number>>;
}
