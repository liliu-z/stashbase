/**
 * PDF → markdown-with-bundle conversion, driven by `python/pdf_extract.py`.
 *
 * Wired from upload/sync/retry: whenever a `.pdf` needs text extraction we
 * spawn the extractor in the background. It writes derived Markdown and any
 * extracted asset bundle under AppData (`derived-store.ts`), never next to
 * the user's PDF. On completion the derived Markdown is pushed into the
 * index under the original PDF path, independently of embedding availability.
 * The PDF itself stays on disk as the user-facing source.
 *
 * Default `pymupdf` route uses `pymupdf4llm` for LLM-friendly markdown
 * (heading detection, table extraction, figure screenshots), falling back
 * to native text and direct local OCR for missing text or failed layout passes.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isDerivedNoteName, matchDerivedNote, NOTE_EXTS } from './format.ts';
import { derivedNoteFor, derivedBundleFor, derivedBatchesFor, derivedDir } from './derived-store.ts';
import { extractorComponent, extractorSpawn, prepareExtractorRuntime } from './python-host.ts';
import { TransientConversionError, type ConversionSpec } from './conversion.ts';
import { lowerExtractorPriority, runExtractor, spawnOptionsForPdfOcr, terminateExtractorTree } from './extractor-process.ts';
import type { ConversionProgress } from './conversion-status.ts';
import { logger } from './log.ts';
import {
  LEGACY_DERIVED_SOURCE_EXTENSIONS,
  LEGACY_EXTENSIONLESS_DERIVED_SOURCE_EXTENSIONS,
} from '../shared/file-formats.ts';

const log = logger('pdf');
const PDF_TEXT_PROBE_TIMEOUT_MS = 5000;
const PDF_TEXT_PROBE_REAP_TIMEOUT_MS = 2000;
const PDF_COST_TEXT_LAYER = 0;
const PDF_COST_OCR_OR_UNKNOWN = 10;

interface ConvertResult {
  /** Absolute AppData path of the written derived Markdown. */
  notePath: string;
  /** Absolute AppData path of the extracted asset bundle. */
  bundleDir: string;
}

/** Derive the AppData paths for a given PDF. Returns both the markdown note
 *  and the extracted asset bundle dir so callers don't repeat the naming. */
export function derivedPathsForPdf(pdfAbsPath: string): { notePath: string; bundleDir: string } {
  // Derived artifacts live in per-machine app data, NEVER in the user's
  // opened folder (see `derived-store.ts`). The PDF resume-batch scratch
  // follows `notePath` automatically (`pdf_extract.py:_resume_dir_for`).
  return {
    notePath: derivedNoteFor(pdfAbsPath),
    bundleDir: derivedBundleFor(pdfAbsPath),
  };
}

function cleanupDerivedPdf(pdfAbsPath: string): void {
  const { notePath, bundleDir } = derivedPathsForPdf(pdfAbsPath);
  rmSync(notePath, { force: true });
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(derivedBatchesFor(pdfAbsPath), { recursive: true, force: true });
}

function cleanupFinalPdfArtifacts(pdfAbsPath: string): void {
  const { notePath, bundleDir } = derivedPathsForPdf(pdfAbsPath);
  rmSync(notePath, { force: true });
  rmSync(bundleDir, { recursive: true, force: true });
}

async function pdfConversionPriority(pdfAbsPath: string, signal: AbortSignal): Promise<number> {
  const hasTextLayer = await probePdfTextLayer(pdfAbsPath, signal);
  // Text-layer PDFs are cheap and should run first. Scanned PDFs fall behind
  // because their OCR path is usually the slowest conversion work.
  return hasTextLayer ? PDF_COST_TEXT_LAYER : PDF_COST_OCR_OR_UNKNOWN;
}

async function probePdfTextLayer(pdfAbsPath: string, signal: AbortSignal): Promise<boolean> {
  // Status discovers an existing component without creating download demand.
  // A missing/downloading component is unknown cost, not a missing dev script.
  if (signal.aborted || (await extractorComponent.status()).status !== 'installed') return false;
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let cmd: string;
    let args: string[];
    try {
      ({ cmd, args } = extractorSpawn('pdf', 'pdf_extract.py', ['--probe-text-layer', pdfAbsPath]));
    } catch (err: unknown) {
      log.warn(`pdf text probe skipped for ${path.basename(pdfAbsPath)}:`, err);
      resolve(false);
      return;
    }
    const proc = spawn(cmd, args, spawnOptionsForPdfOcr());
    lowerExtractorPriority(proc);
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reapTimer: ReturnType<typeof setTimeout> | null = null;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (reapTimer) clearTimeout(reapTimer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const stopAndSettle = () => {
      terminateExtractorTree(proc);
      // A broken/non-cooperative child must not permanently occupy one of the
      // bounded classifier slots. Normal exit/error still settles immediately;
      // this grace is longer than the extractor tree's TERM→KILL escalation.
      if (!reapTimer) {
        reapTimer = setTimeout(() => done(false), PDF_TEXT_PROBE_REAP_TIMEOUT_MS);
        reapTimer.unref?.();
      }
    };
    const onAbort = () => stopAndSettle();
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      stopAndSettle();
      // A probe that cannot finish quickly is likely not a cheap text-layer
      // document; defer it behind definitely text-readable PDFs.
    }, PDF_TEXT_PROBE_TIMEOUT_MS);
    timer.unref?.();
    proc.on('error', () => done(false));
    proc.on('exit', (code) => {
      if (signal.aborted || timedOut) done(false);
      else if (code === 0) done(true);
      else if (code === 10) done(false);
      else done(false);
    });
  });
}

/** Given a POSIX-relative path to a legacy dot-prefixed derived note
 *  (`.paper.pdf.md` / `.shot.png.md`), return the relative path of its
 *  parent binary source (PDF / image) when that source exists on disk —
 *  or null if the shape doesn't match or the source is gone. The source
 *  filename is encoded in the derived name, so this is a direct read +
 *  existence check (no extension probing). Used by the search routes to
 *  rewrite hits so users see the PDF / image row rather than the hidden
 *  derived note. `baseAbs` is the folder root for relative GUI hits; absolute
 *  project hits already carry their full source identity. */
function originalForDerivedNote(noteRel: string, baseAbs: string): string | null {
  // The derived name encodes the full source filename, so the source is
  // read straight off it — no extension probing.
  const m = matchDerivedNote(noteRel);
  if (!m) return null;
  return existsSync(path.join(baseAbs, m.source)) ? m.source : null;
}

function originalForLegacyDerivedNote(noteRel: string, baseAbs: string): string | null {
  const norm = noteRel.replace(/\\/g, '/');
  const dir = path.posix.dirname(norm);
  const base = path.posix.basename(norm);
  const extAlt = NOTE_EXTS.join('|');
  const m = base.match(new RegExp(`^\\.(.+)\\.(${extAlt})$`, 'i'));
  if (!m) return null;
  const stem = m[1];
  // Extension-bearing legacy artifacts (`.paper.pdf.md`) are handled above.
  // Treat extension-less legacy names (`.paper.md`) as derived only when a
  // source with the same stem exists next to them; this keeps ordinary
  // user-authored hidden notes visible unless they collide with a legacy
  // converter artifact.
  if (LEGACY_DERIVED_SOURCE_EXTENSIONS.some(
    (extension) => stem.toLowerCase().endsWith(`.${extension}`),
  )) return null;
  for (const ext of LEGACY_EXTENSIONLESS_DERIVED_SOURCE_EXTENSIONS) {
    const sourceBase = `${stem}.${ext}`;
    const source = dir === '.' ? sourceBase : `${dir}/${sourceBase}`;
    if (existsSync(path.join(baseAbs, source))) return source;
  }
  return null;
}

/** Compatibility remap for legacy dot-prefixed derived notes that may still
 *  exist in user folders. Current PDF/image derived Markdown lives in AppData
 *  and search routes map it to the source file before display.
 *
 *    • legacy derived note (`.paper.pdf.md` / `.shot.png.md`) with a live source
 *        → the source PDF / image (the clickable, openable original);
 *    • derived note whose source is gone (orphan)
 *        → `null`, i.e. drop the hit — the bare `.md` is hidden in the
 *          sidebar and must never surface as an unopenable row;
 *    • any normal file → unchanged.
 *
 *  `rel` is relative to `baseAbs` for GUI routes, and may already be absolute
 *  for project/MCP routes. Centralised here so `/api/search`,
 *  `/api/keyword-search`, and `/api/project/search` can't drift apart. */
export function displayPathForHit(rel: string, baseAbs: string): string | null {
  const source = originalForDerivedNote(rel, baseAbs);
  if (source) return source;
  const legacySource = originalForLegacyDerivedNote(rel, baseAbs);
  if (legacySource) return legacySource;
  if (isDerivedNoteName(rel)) return null;
  return rel;
}

/** Run the extractor on a single PDF. Resolves with paths on success;
 *  rejects with the extractor's stderr tail on failure. A signal-terminated
 *  extractor (exit code null) is transient rather than a durable failure. */
async function convertPdf(
  pdfAbsPath: string,
  onProgress?: (progress: ConversionProgress) => void,
  signal?: AbortSignal,
  yieldLane?: (until?: Promise<unknown>) => Promise<void>,
): Promise<ConvertResult> {
  await prepareExtractorRuntime(signal, yieldLane);
  signal?.throwIfAborted();
  const { notePath, bundleDir } = derivedPathsForPdf(pdfAbsPath);
  mkdirSync(derivedDir(), { recursive: true });

  const handleStderrLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[pdf_extract]')) {
      const message = trimmed.replace(/^\[pdf_extract\]\s*/, '');
      const started = message.match(/^batch \d+\/\d+ pages (\d+)-\d+ started$/);
      const done = message.match(/^batch \d+\/\d+ pages \d+-(\d+) done$/);
      if (started) onProgress?.({ phase: 'extracting', currentPage: Number(started[1]) });
      if (done) onProgress?.({ phase: 'extracting', currentPage: Number(done[1]) });
      log.info(`${path.basename(pdfAbsPath)}: ${message}`);
    } else if (/^(Using RapidOCR|OCR on page\.number=)/.test(trimmed)) {
      log.debug(`${path.basename(pdfAbsPath)}: ${trimmed}`);
    }
  };
  const { code, signal: exitSignal, cancelled, stderrTail, stderr } = await runExtractor({
    mode: 'pdf',
    script: 'pdf_extract.py',
    args: [pdfAbsPath, notePath, bundleDir],
    signal,
    onStderrLine: handleStderrLine,
  });
  if (cancelled) throw new TransientConversionError('pdf_extract cancelled');
  if (code === 0) return { notePath, bundleDir };
  const message = `pdf_extract ${exitSignal ? `signal ${exitSignal}` : `exit ${code}`}: ${stderrTail || '(no stderr)'}`;
  throw Object.assign(code === null ? new TransientConversionError(message) : new Error(message),
    { exit_code: code, signal: exitSignal, stderr: stderr ?? stderrTail });
}

/** Conversion spec wiring PDFs into the shared `conversion.ts` plumbing. */
export const PDF_SPEC: ConversionSpec = {
  kind: 'pdf_extract',
  lane: 'heavy',
  cost: PDF_COST_OCR_OR_UNKNOWN,
  matches: (name) => /\.pdf$/i.test(name),
  derivedNote: (abs) => derivedPathsForPdf(abs).notePath,
  completeMarker: { text: '<!-- stashbase-pdf-conversion: complete -->', tailBytes: 4096 },
  classifyCost: pdfConversionPriority,
  convert: convertPdf,
  cleanupBeforeConvert: cleanupFinalPdfArtifacts,
  cleanupDerived: cleanupDerivedPdf,
};
