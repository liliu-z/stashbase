import { displayPathForHit } from './pdf.ts';
import { derivedNoteFor } from './derived-store.ts';
import type { SearchHit } from './indexer.ts';
import fs from 'node:fs';
import { filesystemPath } from './filesystem-path.ts';

export interface KeywordMatch {
  line: number;
  text: string;
  ranges: Array<[number, number]>;
  pdfPage?: number;
  /** Exact transcript position retained independently from display snippet
   * truncation. Present only for AppData-derived audio Markdown. */
  audioTimestampMs?: number;
}

export interface KeywordHitFile {
  path: string;
  matches: KeywordMatch[];
  totalMatches: number;
}

export interface KeywordSearchResult {
  files: KeywordHitFile[];
  totalMatches: number;
  truncated: boolean;
}

export function remapKeywordFilesForDisplay(
  files: KeywordHitFile[],
  baseAbs: string,
): Pick<KeywordSearchResult, 'files' | 'totalMatches'> {
  const byPath = new Map<string, KeywordHitFile>();
  const seenMatches = new Map<string, Set<string>>();

  for (const file of files) {
    const display = displayPathForHit(file.path, baseAbs);
    if (display == null) continue;
    const pageMap = pdfSourceLineMap(display, baseAbs)
      ?? (display !== file.path ? pdfLineMapForPath(filesystemPath.absolute(file.path, baseAbs), baseAbs) : null);
    let bucket = byPath.get(display);
    if (!bucket) {
      bucket = { path: display, matches: [], totalMatches: 0 };
      byPath.set(display, bucket);
      seenMatches.set(display, new Set());
    }
    const seen = seenMatches.get(display)!;
    for (const match of file.matches) {
      const nextMatch = pageMap
        ? {
            ...match,
            pdfPage: pdfPageForLine(pageMap, match.line),
          }
        : match;
      const key = `${nextMatch.line}\0${nextMatch.text}\0${JSON.stringify(nextMatch.ranges)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bucket.matches.push(nextMatch);
    }
    bucket.totalMatches = Math.max(bucket.totalMatches, file.totalMatches, bucket.matches.length);
  }

  const out = Array.from(byPath.values())
    .map((file) => ({
      ...file,
      matches: [...file.matches].sort((a, b) => a.line - b.line),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: out,
    totalMatches: out.reduce((sum, file) => sum + file.totalMatches, 0),
  };
}

export function remapSearchHitsForDisplay(hits: SearchHit[], baseAbs: string): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const display = displayPathForHit(hit.fileName, baseAbs);
    if (display == null) continue;
    const pageMap = pdfSourceLineMap(display, baseAbs)
      ?? (display !== hit.fileName ? pdfLineMapForPath(filesystemPath.absolute(hit.fileName, baseAbs), baseAbs) : null);
    const next = {
      ...hit,
      fileName: display,
      ...(pageMap
        ? {
            pdfPage: hit.startLine ? pdfPageForLine(pageMap, hit.startLine) : undefined,
          }
        : {}),
    };
    const key = [
      next.fileName,
      next.content,
      next.heading,
      next.startLine ?? '',
      next.endLine ?? '',
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

interface PdfDerivedLineMap {
  markers: Array<{ line: number; page: number }>;
}

function pdfSourceLineMap(displayPath: string, baseAbs: string): PdfDerivedLineMap | null {
  if (!/\.pdf$/i.test(displayPath)) return null;
  const sourceAbs = filesystemPath.absolute(displayPath, baseAbs);
  return pdfLineMapForPath(derivedNoteFor(sourceAbs), undefined);
}

function pdfLineMapForPath(full: string, baseAbs?: string): PdfDerivedLineMap | null {
  if (baseAbs) {
    if (!filesystemPath.contains(baseAbs, full)) return null;
  }
  let text: string;
  try { text = fs.readFileSync(full, 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/);
  const markers: Array<{ line: number; page: number }> = [];
  lines.forEach((line, i) => {
    const marker = line.match(/stashbase-pdf-pages?:\s*(\d+)(?:\s*-\s*(\d+))?/i);
    const pageHeading = line.match(/^#{1,6}\s+Page\s+(\d+)\b/i);
    const page = marker ? Number(marker[1]) : pageHeading ? Number(pageHeading[1]) : NaN;
    if (Number.isFinite(page) && page > 0) markers.push({ line: i + 1, page });
  });
  return { markers };
}

function pdfPageForLine(map: PdfDerivedLineMap, line: number): number | undefined {
  let page: number | undefined;
  for (const marker of map.markers) {
    if (marker.line > line) break;
    page = marker.page;
  }
  return page;
}
