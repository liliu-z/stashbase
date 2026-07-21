import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { analyzeHtml } from './html.ts';
import { derivedHtmlPathForDocx } from './docx.ts';
import { isConversionTextUnavailable } from './conversion.ts';
import { isAudioTranscriptTextUnavailable } from './audio-transcription.ts';
import { derivedNoteFor } from './derived-store.ts';
import {
  isAudioFile,
  isConvertibleSource,
  isDocxFile,
  matchesSearchTypes,
} from './format.ts';
import { isCloudPlaceholderName, isIndexExcludedDirName } from './indexable.ts';
import {
  type KeywordHitFile,
  type KeywordMatch,
  type KeywordSearchResult,
} from './search-display.ts';
import type { SearchTypeCategory } from '../shared/search-types.ts';

const RG_PER_FILE_CAP = 50;
const RG_TOTAL_CAP = 500;
const RG_TIMEOUT_MS = 8000;
const RG_MAX_LINE_CHARS = 240;
const RESOLVED_RG_PATH = resolveSpawnableRipgrepPath(rgPath);

export interface KeywordSearchOpts {
  /** false -> `--smart-case` (case-insensitive unless query has caps);
   *  true -> `--case-sensitive` regardless of query shape. */
  caseStrict: boolean;
  /** true -> Unicode-aware app-side whole-token filtering. We do not use
   *  ripgrep's `--word-regexp`: its boundary semantics do not line up
   *  with the renderer and are especially poor for CJK text. */
  wholeWord: boolean;
  /** Folder-relative subfolder to search instead of the whole folder.
   *  Already validated by the route (escape-safe, existing directory). */
  pathPrefix?: string;
  /** File-type categories to include; empty/absent = every category. */
  types?: readonly SearchTypeCategory[];
}

export async function runKeywordSearch(
  query: string,
  folderRoot: string,
  opts: KeywordSearchOpts,
): Promise<KeywordSearchResult> {
  const types = opts.types ?? [];
  const wantsNotes = types.length === 0 || types.includes('notes');
  const wantsConvertible = types.length === 0
    || types.some((type) => type !== 'notes');
  const empty: KeywordSearchResult = { files: [], totalMatches: 0, truncated: false };
  return mergeKeywordResults(
    wantsNotes ? await runRipgrep(query, folderRoot, opts) : empty,
    wantsConvertible ? searchDerivedMarkdown(query, folderRoot, opts) : empty,
  );
}

/** Spawn ripgrep on `cwd` with `query` as a literal pattern (no shell).
 *  `--json` gives structured `match` events; we group them into
 *  per-file buckets, applying caps and truncations. */
function runRipgrep(query: string, cwd: string, opts: KeywordSearchOpts): Promise<KeywordSearchResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '--json',
      opts.caseStrict ? '--case-sensitive' : '--smart-case',
      '--fixed-strings',
      '--max-count', String(RG_PER_FILE_CAP),
      '--max-filesize', '5M',
      '--glob', '*.md',
      '--glob', '*.markdown',
      '--glob', '*.html',
      '--glob', '*.htm',
    ];
    args.push('-e', query, opts.pathPrefix ? `./${opts.pathPrefix}` : '.');
    execFile(RESOLVED_RG_PATH, args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: RG_TIMEOUT_MS,
    }, (err, stdout) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
        const codeStr = String(code ?? '');
        if (codeStr !== '1') {
          if (codeStr === '2') {
            return reject(new Error(`invalid query: ${query}`));
          }
          return reject(new Error(`ripgrep failed (code ${codeStr}): ${err.message}`));
        }
      }
      const byFile = new Map<string, KeywordHitFile>();
      let total = 0;
      let truncated = false;
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        let evt: any;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type !== 'match') continue;
        const dataPath = evt.data?.path?.text;
        const lineNum = evt.data?.line_number;
        const rawText = evt.data?.lines?.text;
        if (typeof dataPath !== 'string' || typeof lineNum !== 'number' || typeof rawText !== 'string') continue;
        const relPath = dataPath.replace(/^\.\//, '').replace(/\\/g, '/');
        const stripped = rawText.replace(/\r?\n$/, '');
        const subs = Array.isArray(evt.data?.submatches) ? evt.data.submatches : [];
        const matchRanges = normalizeRipgrepSubmatches(stripped, subs)
          .filter(([start, end]) => !opts.wholeWord || hasWholeTokenBoundaries(stripped, start, end));
        if (matchRanges.length === 0) continue;
        const snippet = snippetForLine(stripped, matchRanges);
        let bucket = byFile.get(relPath);
        if (!bucket) {
          bucket = { path: relPath, matches: [], totalMatches: 0 };
          byFile.set(relPath, bucket);
        }
        bucket.totalMatches += matchRanges.length;
        if (total < RG_TOTAL_CAP) {
          bucket.matches.push({ line: lineNum, text: snippet.text, ranges: snippet.ranges });
          total += matchRanges.length;
        } else {
          truncated = true;
        }
      }
      const files = Array.from(byFile.values()).sort((a, b) => a.path.localeCompare(b.path));
      resolve({ files, totalMatches: total, truncated });
    });
  });
}

export function resolveSpawnableRipgrepPath(candidate: string): string {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  if (!candidate.includes(asarSegment)) return candidate;
  const unpacked = candidate.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpacked) ? unpacked : candidate;
}

function searchDerivedMarkdown(query: string, folderRoot: string, opts: KeywordSearchOpts): KeywordSearchResult {
  const files: KeywordHitFile[] = [];
  let total = 0;
  let truncated = false;
  const caseSensitive = opts.caseStrict || /[A-Z]/.test(query);
  const types = opts.types ?? [];
  const walkRoot = opts.pathPrefix ? path.join(folderRoot, opts.pathPrefix) : folderRoot;

  walkConvertibleSources(walkRoot, opts.pathPrefix ?? '', (rel, abs) => {
    if (total >= RG_TOTAL_CAP) {
      truncated = true;
      return;
    }
    if (!convertibleMatchesTypes(rel, types)) return;
    const text = readDerivedSearchText(rel, abs);
    if (text == null) return;
    const lines = text.split(/\r?\n/);
    const matches: KeywordMatch[] = [];
    let fileMatches = 0;
    lines.forEach((line, i) => {
      if (fileMatches >= RG_PER_FILE_CAP || total >= RG_TOTAL_CAP) {
        truncated = true;
        return;
      }
      const ranges = findLiteralRanges(line, query, caseSensitive)
        .filter(([start, end]) => !opts.wholeWord || hasWholeTokenBoundaries(line, start, end));
      if (ranges.length === 0) return;
      const snippet = snippetForLine(line, ranges);
      const audioTimestampMs = isAudioFile(rel) ? audioTimestampForTranscriptLine(line) : null;
      matches.push({
        line: i + 1,
        text: snippet.text,
        ranges: snippet.ranges,
        ...(/\.pdf$/i.test(rel) ? { pdfPage: pdfPageForDerivedLine(lines, i + 1) } : {}),
        ...(audioTimestampMs == null ? {} : { audioTimestampMs }),
      });
      fileMatches += ranges.length;
      total += ranges.length;
    });
    if (matches.length > 0) {
      files.push({ path: rel, matches, totalMatches: fileMatches });
    }
  });

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalMatches: total, truncated };
}

function readDerivedSearchText(rel: string, abs: string): string | null {
  if (isConversionTextUnavailable(abs) || isAudioTranscriptTextUnavailable(abs)) return null;
  try {
    if (isDocxFile(rel)) {
      const raw = fs.readFileSync(derivedHtmlPathForDocx(abs), 'utf8');
      return analyzeHtml(raw).plaintext;
    }
    return fs.readFileSync(derivedNoteFor(abs), 'utf8');
  } catch {
    return null;
  }
}

function walkConvertibleSources(
  dir: string,
  prefix: string,
  fn: (rel: string, abs: string) => void,
): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (isCloudPlaceholderName(ent.name)) continue;
    if (ent.name.startsWith('.')) continue;
    if (ent.isDirectory() && isIndexExcludedDirName(ent.name)) continue;
    if (ent.isDirectory() && ent.name.endsWith('_files')) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkConvertibleSources(abs, rel, fn);
    } else if (ent.isFile() && isConvertibleSource(ent.name)) {
      fn(rel, abs);
    }
  }
}

/** Category membership for the convertible-source walk. Empty types =
 *  every convertible category (`notes` never reaches this leg). */
function convertibleMatchesTypes(rel: string, types: readonly SearchTypeCategory[]): boolean {
  return matchesSearchTypes(rel, types);
}

function findLiteralRanges(line: string, query: string, caseSensitive: boolean): Array<[number, number]> {
  const haystack = caseSensitive ? line : line.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  while (needle) {
    const idx = haystack.indexOf(needle, offset);
    if (idx < 0) break;
    ranges.push([idx, idx + needle.length]);
    offset = idx + Math.max(needle.length, 1);
  }
  return ranges;
}

export function snippetForLine(line: string, matchRanges: Array<[number, number]>): { text: string; ranges: Array<[number, number]> } {
  let windowStart = 0;
  if (line.length > RG_MAX_LINE_CHARS && matchRanges.length > 0) {
    const firstStart = matchRanges[0]?.[0] ?? 0;
    windowStart = Math.max(0, Math.min(
      line.length - RG_MAX_LINE_CHARS,
      firstStart - Math.floor(RG_MAX_LINE_CHARS / 3),
    ));
  }
  const windowEnd = Math.min(line.length, windowStart + RG_MAX_LINE_CHARS);
  const timestampPrefix = windowStart > 0 ? transcriptTimestampPrefix(line) : '';
  const leading = windowStart > 0
    ? timestampPrefix && windowStart >= timestampPrefix.length
      ? `${timestampPrefix.trimEnd()} … `
      : '…'
    : '';
  const trailing = windowEnd < line.length ? '…' : '';
  const text = leading + line.slice(windowStart, windowEnd) + trailing;
  const ranges: Array<[number, number]> = [];
  for (const [start, end] of matchRanges) {
    const localStart = start - windowStart + leading.length;
    const localEnd = end - windowStart + leading.length;
    if (localEnd <= leading.length) continue;
    if (localStart >= text.length - trailing.length) continue;
    ranges.push([
      Math.max(leading.length, localStart),
      Math.min(text.length - trailing.length, localEnd),
    ]);
  }
  return { text, ranges };
}

function transcriptTimestampPrefix(line: string): string {
  return line.match(/^\s*-\s*\[\d{1,3}:\d{2}:\d{2}(?:\.\d{1,3})?\]\s*/)?.[0] ?? '';
}

export function audioTimestampForTranscriptLine(line: string): number | null {
  const match = line.match(/^\s*-\s*\[(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;
  const millis = Number((match[4] ?? '').padEnd(3, '0')) || 0;
  return ((hours * 3600) + (minutes * 60) + seconds) * 1000 + millis;
}

function pdfPageForDerivedLine(lines: string[], lineNumber: number): number | undefined {
  let page: number | undefined;
  for (let i = 0; i < Math.min(lines.length, lineNumber); i++) {
    const line = lines[i] ?? '';
    const marker = line.match(/stashbase-pdf-pages?:\s*(\d+)(?:\s*-\s*(\d+))?/i);
    const pageHeading = line.match(/^#{1,6}\s+Page\s+(\d+)\b/i);
    const next = marker ? Number(marker[1]) : pageHeading ? Number(pageHeading[1]) : NaN;
    if (Number.isFinite(next) && next > 0) page = next;
  }
  return page;
}

function mergeKeywordResults(a: KeywordSearchResult, b: KeywordSearchResult): KeywordSearchResult {
  const byPath = new Map<string, KeywordHitFile>();
  for (const file of [...a.files, ...b.files]) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, { ...file, matches: [...file.matches] });
      continue;
    }
    existing.matches.push(...file.matches);
    existing.matches.sort((x, y) => x.line - y.line);
    existing.totalMatches += file.totalMatches;
  }
  const files = [...byPath.values()].sort((x, y) => x.path.localeCompare(y.path));
  return {
    files,
    totalMatches: files.reduce((sum, file) => sum + file.totalMatches, 0),
    truncated: a.truncated || b.truncated,
  };
}

export function normalizeRipgrepSubmatches(line: string, subs: unknown[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const s of subs) {
    if (!s || typeof s !== 'object') continue;
    const start = (s as { start?: unknown }).start;
    const end = (s as { end?: unknown }).end;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    ranges.push([
      utf8ByteOffsetToUtf16Index(line, start),
      utf8ByteOffsetToUtf16Index(line, end),
    ]);
  }
  return ranges;
}

function utf8ByteOffsetToUtf16Index(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let index = 0;
  for (const ch of text) {
    const next = bytes + Buffer.byteLength(ch, 'utf8');
    if (next > byteOffset) return index;
    index += ch.length;
    bytes = next;
    if (bytes === byteOffset) return index;
  }
  return text.length;
}

export function hasWholeTokenBoundaries(text: string, start: number, end: number): boolean {
  const before = charBefore(text, start);
  const after = charAt(text, end);
  return !isKeywordWordChar(before) && !isKeywordWordChar(after);
}

function charBefore(text: string, index: number): string {
  if (index <= 0) return '';
  const prev = Array.from(text.slice(0, index)).pop();
  return prev ?? '';
}

function charAt(text: string, index: number): string {
  if (index >= text.length) return '';
  return Array.from(text.slice(index))[0] ?? '';
}

function isKeywordWordChar(ch: string): boolean {
  return ch !== '' && /[\p{L}\p{N}_]/u.test(ch);
}
