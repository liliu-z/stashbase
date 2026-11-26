/**
 * App-data home for convertible-source derived text (PDF/image markdown,
 * DOCX HTML, image/PDF bundles, and PDF resume-batch scratch). These never live in
 * the user's opened folder; all generated artifacts are per-machine derived
 * state under app data (see `local-data.ts`). The source file is the user-facing file
 * and is what gets indexed (under its own path, with the derived text as
 * the content) so folder-scoped search still finds it.
 *
 * Keyed by a hash of the **source's absolute path** (not its content): a
 * path is locatable even after the source file is deleted, so cleanup /
 * orphan-GC can still find the derived note to remove it. The trade-off is a
 * rename re-converts (rare); content-addressing would need a separate
 * path→hash index just to support deletion.
 */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import fs from 'node:fs';
import path from 'node:path';
import { appDataRoot } from './local-data.ts';
import { writeFileAtomic } from './atomic-write.ts';
import { filesystemPath } from './filesystem-path.ts';
import { isConvertibleSource } from './format.ts';
import { isCloudPlaceholderName, isIndexExcludedDirName } from './indexable.ts';
import { logger, errorMessage } from './log.ts';

const log = logger('derived-store');

/** The single global derived-notes directory: `<appData>/derived.nosync/`.
 *  `.nosync` keeps iCloud off it (same rationale as the vector store). */
export function derivedDir(): string {
  return path.join(appDataRoot(), 'derived.nosync');
}

function derivedKey(sourceAbs: string): string {
  // Preserve the canonical source spelling in the durable cache key so an
  // upgrade does not invalidate existing Windows derived artifacts. External
  // paths are canonicalized before this seam; comparison-only state uses
  // `filesystemPath.identity()` elsewhere.
  return bytesToHex(blake3(new TextEncoder().encode(filesystemPath.absolute(sourceAbs)))).slice(0, 32);
}

function manifestPath(): string {
  return path.join(derivedDir(), 'manifest.json');
}

function readManifest(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeManifest(manifest: Record<string, string>): void {
  writeFileAtomic(manifestPath(), JSON.stringify(manifest, null, 2));
}

export function registerDerivedSource(sourceAbs: string): void {
  if (!isConvertibleSource(sourceAbs)) return;
  const manifest = readManifest();
  manifest[derivedKey(sourceAbs)] = filesystemPath.absolute(sourceAbs);
  writeManifest(manifest);
}

function forgetDerivedSource(sourceAbs: string): void {
  const manifest = readManifest();
  const key = derivedKey(sourceAbs);
  if (!(key in manifest)) return;
  delete manifest[key];
  writeManifest(manifest);
}

export function knownDerivedSourcesUnderFolder(folderAbs: string): string[] {
  const root = filesystemPath.absolute(folderAbs);
  return Object.values(readManifest())
    .map((sourceAbs) => filesystemPath.absolute(sourceAbs))
    .filter((sourceAbs) => filesystemPath.contains(root, sourceAbs));
}

/** Absolute path of the derived markdown note for a source file. */
export function derivedNoteFor(sourceAbs: string): string {
  return path.join(derivedDir(), `${derivedKey(sourceAbs)}.md`);
}

/** Absolute path of the derived HTML representation for a source file. */
export function derivedHtmlFor(sourceAbs: string): string {
  return path.join(derivedDir(), `${derivedKey(sourceAbs)}.html`);
}

/** Absolute path of the derived image bundle (`_files/`) for a source. */
export function derivedBundleFor(sourceAbs: string): string {
  return path.join(derivedDir(), `${derivedKey(sourceAbs)}_files`);
}

/** Absolute path of the PDF resume-batch scratch dir for a source. */
export function derivedBatchesFor(sourceAbs: string): string {
  return path.join(derivedDir(), `${derivedKey(sourceAbs)}.batches`);
}

export interface DerivedCleanupStats {
  sources: number;
  artifacts: number;
}

interface DerivedRemoval {
  artifacts: number;
  failed: string[];
}

function rmDerivedArtifact(absPath: string): DerivedRemoval {
  try {
    const existed = fs.existsSync(absPath);
    fs.rmSync(absPath, { recursive: true, force: true });
    return { artifacts: existed ? 1 : 0, failed: [] };
  } catch (err: unknown) {
    return { artifacts: 0, failed: [`${absPath}: ${errorMessage(err)}`] };
  }
}

/** Delete all AppData-derived artifacts for one convertible source path. */
export function deleteDerivedForSource(sourceAbs: string): DerivedCleanupStats {
  if (!isConvertibleSource(sourceAbs)) return { sources: 0, artifacts: 0 };
  const removals = [
    rmDerivedArtifact(derivedNoteFor(sourceAbs)),
    rmDerivedArtifact(derivedHtmlFor(sourceAbs)),
    rmDerivedArtifact(derivedBundleFor(sourceAbs)),
    rmDerivedArtifact(derivedBatchesFor(sourceAbs)),
  ];
  const artifacts = removals.reduce((sum, item) => sum + item.artifacts, 0);
  const failed = removals.flatMap((item) => item.failed);
  if (failed.length === 0) {
    forgetDerivedSource(sourceAbs);
  } else {
    log.warn(
      `derived cleanup failed for ${sourceAbs}; keeping manifest entry for retry: ${failed.join('; ')}`,
    );
  }
  return {
    sources: 1,
    artifacts,
  };
}

/** Best-effort cleanup for every convertible source currently visible under
 *  a folder. This is used when a folder leaves the project; user files stay
 *  in place, but AppData-derived text/assets for those sources should go. */
export function deleteDerivedUnderFolder(folderAbs: string, excludedRoots: readonly string[] = []): DerivedCleanupStats {
  const root = filesystemPath.absolute(folderAbs);
  const seen = new Set<string>();
  const totals: DerivedCleanupStats = { sources: 0, artifacts: 0 };

  function add(stats: DerivedCleanupStats): void {
    totals.sources += stats.sources;
    totals.artifacts += stats.artifacts;
  }

  function visit(absDir: string): void {
    if (excludedRoots.some((root) => filesystemPath.contains(root, absDir))) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (isCloudPlaceholderName(ent.name)) continue;
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        if (isIndexExcludedDirName(ent.name)) continue;
        visit(abs);
        continue;
      }
      if (!ent.isFile() || !isConvertibleSource(ent.name)) continue;
      const sourceAbs = filesystemPath.absolute(abs);
      const sourceKey = filesystemPath.identity(sourceAbs);
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      add(deleteDerivedForSource(sourceAbs));
    }
  }

  if (fs.existsSync(root)) visit(root);
  for (const sourceAbs of knownDerivedSourcesUnderFolder(root)) {
    if (excludedRoots.some((excluded) => filesystemPath.contains(excluded, sourceAbs))) continue;
    const sourceKey = filesystemPath.identity(sourceAbs);
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    add(deleteDerivedForSource(sourceAbs));
  }
  return totals;
}
