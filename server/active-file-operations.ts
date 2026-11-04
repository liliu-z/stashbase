import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomicAsync } from './atomic-write.ts';
import { errorCode } from './log.ts';
import { matchNoteStem } from './format.ts';
import { filesystemPath } from './filesystem-path.ts';
import {
  renameAbsPreservingCaseAsync,
  resolveSafe,
  resolveSafeAsync,
} from './file-paths.ts';
import { MAX_INDEXABLE_BYTES } from './indexable.ts';
import { decodeDirectTextBytes } from './text-decoding.ts';
import { writeDiagnosticEvidence, writeDiagnosticStep } from './write-diagnostic-context.ts';

/** One synchronous text read is capped to the same admission ceiling as the
 * local index. This bounds HTTP/MCP response memory and main-loop stalls. */
export const MAX_TEXT_READ_BYTES = MAX_INDEXABLE_BYTES;

export async function readUtf8FileBoundedAsync(absPath: string, maxBytes = MAX_TEXT_READ_BYTES): Promise<string> {
  return (await readFileBytesBoundedAsync(absPath, maxBytes)).toString('utf8');
}

/** Bounded, complete reads shared by source snapshots and text consumers. */
export async function readFileBytesBoundedAsync(absPath: string, maxBytes = MAX_TEXT_READ_BYTES): Promise<Buffer> {
  // Opening a FIFO must not block before the regular-file check below.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
  const handle = await writeDiagnosticStep('read', 'open_source', () => fs.promises.open(absPath, flags), { path: absPath, syscall: 'open', flags });
  try {
    const stat = await writeDiagnosticStep('read', 'stat_open_source', () => handle.stat(), { path: absPath, syscall: 'fstat' });
    writeDiagnosticStep('read', 'validate_source_snapshot', () => {
      if (!stat.isFile()) throw Object.assign(new Error('path is not a file'), { code: 'NOT_REGULAR_FILE' });
      if (stat.size > maxBytes) throw textReadSizeError(stat.size, maxBytes);
    }, { path: absPath, is_regular_file: stat.isFile(), size_bytes: stat.size, max_bytes: maxBytes });
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const bytes = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await writeDiagnosticStep('read', 'read_source_chunk', () => handle.read(bytes, 0, bytes.length, total), {
        path: absPath, syscall: 'read', offset: total, requested_bytes: bytes.length,
      });
      if (!bytesRead) break;
      chunks.push(bytes.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw textReadSizeError(total, maxBytes);
    writeDiagnosticEvidence('read_source_complete', { path: absPath, bytes_read: total });
    return Buffer.concat(chunks, total);
  } finally {
    await writeDiagnosticStep('read', 'close_source', () => handle.close(), { path: absPath, syscall: 'close' });
  }
}

function textReadSizeError(actual: number, max: number): Error {
  const err = new Error(`file is too large to read in one response (${actual} bytes > ${max} bytes)`) as Error & {
    code: string;
    status: number;
  };
  err.code = 'FILE_TOO_LARGE';
  err.status = 413;
  return err;
}

export async function fileVersionAsync(relPath: string): Promise<string | null> {
  let target: string;
  try { target = await resolveSafeAsync(relPath, 'existing'); } catch { return null; }
  try {
    const st = await fs.promises.stat(target);
    if (!st.isFile()) return null;
    return `sha256:${crypto.createHash('sha256').update(await fs.promises.readFile(target)).digest('hex')}`;
  } catch {
    return null;
  }
}

/** Cheap cache/reload identity for binary viewers. Text write conflicts use
 * the content hash above; binary previews only need a token that changes when
 * the filesystem object or its bytes are replaced. */
export function fileStatVersion(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath, 'existing'); } catch { return null; }
  try {
    const st = fs.statSync(target, { bigint: true });
    if (!st.isFile()) return null;
    return `stat:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    return null;
  }
}

export async function fileStatVersionAsync(relPath: string): Promise<string | null> {
  let target: string;
  try { target = await resolveSafeAsync(relPath, 'existing'); } catch { return null; }
  try {
    const st = await fs.promises.stat(target, { bigint: true });
    if (!st.isFile()) return null;
    return `stat:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    return null;
  }
}

export async function saveTextAsync(relPath: string, content: string, beforePublish?: () => Promise<void>): Promise<void> {
  await saveBytesAsync(relPath, Buffer.from(content, 'utf8'), beforePublish);
}

export async function saveBytesAsync(relPath: string, bytes: Buffer, beforePublish?: () => Promise<void>): Promise<void> {
  const target = await resolveSafeAsync(relPath, 'creatable');
  await writeDiagnosticStep('persist', 'create_target_parent', () => fs.promises.mkdir(path.dirname(target), { recursive: true }), {
    path: path.dirname(target), target_path: target, syscall: 'mkdir', recursive: true, target_partial_write_possible: false,
  });
  await resolveSafeAsync(relPath, 'creatable');
  const mode = await writeDiagnosticStep('persist', 'stat_target_permissions', () => fs.promises.stat(target), { path: target, syscall: 'stat' }).then(
    (stat) => stat.mode & 0o777,
    (err: unknown) => {
      if (errorCode(err) !== 'ENOENT') throw err;
      return undefined;
    },
  );
  writeDiagnosticEvidence('target_permissions', { path: target, mode: mode ?? null, existing: mode !== undefined });
  await writeFileAtomicAsync(target, bytes, { mode, beforeRename: beforePublish });
}

/** Exclusive-create variant: returns false if the file already exists
 *  (POSIX O_EXCL via `wx` flag). Used by `+ new file` so concurrent
 *  clicks can't race-pick the same `untitled-N.md`. Creates intermediate
 *  directories if needed. */
export async function createTextExclusiveAsync(relPath: string, content: string): Promise<boolean> {
  const target = await resolveSafeAsync(relPath, 'creatable');
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await resolveSafeAsync(relPath, 'creatable');
  try {
    await fs.promises.writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err: any) {
    if (errorCode(err) === 'EEXIST') return false;
    throw err;
  }
}

/** Atomic in-place rename / move. Same FS only. Creates the target's
 *  parent dirs as needed (moving across folders works). */
export async function renameOnDiskAsync(oldRel: string, newRel: string): Promise<void> {
  const o = await resolveSafeAsync(oldRel, 'existing', 'source file');
  const n = await resolveSafeAsync(newRel, 'creatable', 'target file');
  const oldStat = await fs.promises.stat(o).catch(() => null);
  if (!oldStat?.isFile()) throw new Error('source file not found');
  const targetExists = await fs.promises.stat(n).then(() => true, () => false);
  if (targetExists && !(await filesystemPath.sameExistingPathAsync(o, n))) {
    throw new Error('target already exists');
  }
  await fs.promises.mkdir(path.dirname(n), { recursive: true });
  await resolveSafeAsync(newRel, 'creatable', 'target file');
  await renameAbsPreservingCaseAsync(o, n);
  await renameBundleSiblingAsync(oldRel, newRel);
}

/** Resolve a folder-relative path to an absolute filesystem path for
 *  asset serving (images, css, fonts referenced from an HTML iframe).
 *  Returns null if the path resolves outside the folder, doesn't exist,
 *  or isn't a regular file. Safe to pass to `fs.createReadStream`. */
export async function resolveAssetAsync(relPath: string): Promise<string | null> {
  let target: string;
  try { target = await resolveSafeAsync(relPath, 'existing'); } catch { return null; }
  try {
    return (await fs.promises.stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

export async function readTextAsync(relPath: string): Promise<string | null> {
  let target: string;
  try { target = await resolveSafeAsync(relPath, 'existing'); } catch { return null; }
  try {
    return await readDirectTextFileBoundedAsync(target, relPath);
  } catch (err) {
    if (['FILE_TOO_LARGE', 'UNSUPPORTED_ENCODING'].includes(String((err as { code?: unknown })?.code))) throw err;
    return null;
  }
}

async function readDirectTextFileBoundedAsync(
  absPath: string,
  sourceName: string,
  maxBytes = MAX_TEXT_READ_BYTES,
): Promise<string> {
  return decodeDirectTextBytes(sourceName, await readFileBytesBoundedAsync(absPath, maxBytes));
}

/** True if a file or directory exists at the folder-relative path. */
export async function pathExistsAsync(relPath: string): Promise<boolean> {
  try {
    const target = await resolveSafeAsync(relPath, 'existing');
    await fs.promises.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** True if a directory exists at the folder-relative path. */
export async function directoryExistsAsync(relPath: string): Promise<boolean> {
  try {
    const target = await resolveSafeAsync(relPath, 'existing');
    return (await fs.promises.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve to an absolute path if anything exists at the folder-relative
 *  location (file OR directory). Used by the reveal-in-OS route, which
 *  needs to accept both files and folders. */
export async function resolveExistingAsync(relPath: string): Promise<string | null> {
  try {
    const target = await resolveSafeAsync(relPath, 'existing');
    await fs.promises.stat(target);
    return target;
  } catch {
    return null;
  }
}

/** Delete a file at the given folder-relative path. Returns false only
 *  when the file genuinely isn't there (ENOENT). */
export async function deleteFileAsync(relPath: string): Promise<boolean> {
  let target: string;
  try { target = await resolveSafeAsync(relPath, 'existing', 'file'); }
  catch (err: unknown) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
  try {
    await fs.promises.unlink(target);
  } catch (err: any) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
  await deleteBundleSiblingAsync(relPath);
  return true;
}

/** Map a note's folder-relative path to its `<stem>_files/` sibling
 *  bundle dir. Returns null when the path isn't a recognised note. */
function bundleDirSibling(noteRel: string): string | null {
  const m = matchNoteStem(path.posix.basename(noteRel));
  if (!m) return null;
  const dir = path.posix.dirname(noteRel);
  const bundle = `${m.stem}_files`;
  return dir === '.' ? bundle : `${dir}/${bundle}`;
}

async function renameBundleSiblingAsync(oldNoteRel: string, newNoteRel: string): Promise<void> {
  const oldBundle = bundleDirSibling(oldNoteRel);
  const newBundle = bundleDirSibling(newNoteRel);
  if (!oldBundle || !newBundle || oldBundle === newBundle) return;
  let oldAbs: string;
  let newAbs: string;
  try {
    [oldAbs, newAbs] = await Promise.all([
      resolveSafeAsync(oldBundle, 'existing'),
      resolveSafeAsync(newBundle, 'creatable'),
    ]);
  } catch {
    return;
  }
  try {
    if (!(await fs.promises.stat(oldAbs)).isDirectory()) return;
  } catch {
    return;
  }
  const targetExists = await fs.promises.stat(newAbs).then(() => true, () => false);
  if (targetExists && !(await filesystemPath.sameExistingPathAsync(oldAbs, newAbs))) return;
  await renameAbsPreservingCaseAsync(oldAbs, newAbs);
}

async function deleteBundleSiblingAsync(noteRel: string): Promise<void> {
  const bundle = bundleDirSibling(noteRel);
  if (!bundle) return;
  let abs: string;
  try { abs = await resolveSafeAsync(bundle, 'existing'); } catch { return; }
  try {
    if ((await fs.promises.stat(abs)).isDirectory()) {
      await fs.promises.rm(abs, { recursive: true, force: true });
    }
  } catch { /* no bundle — fine */ }
}

/** Create a (possibly nested) folder inside the folder. Returns false if
 *  the folder already exists, throws on other errors. */
export async function createFolderAsync(relPath: string): Promise<boolean> {
  const target = await resolveSafeAsync(relPath, 'creatable', 'folder', { writable: true });
  const exists = await fs.promises.stat(target).then(() => true, () => false);
  if (exists) return false;
  await fs.promises.mkdir(target, { recursive: true });
  await resolveSafeAsync(relPath, 'existing', 'folder', { writable: true });
  return true;
}

/** Rename a folder in place. The PATCH route handles the index
 *  update separately (see Indexer.renamePathPrefix); this function
 *  only moves the directory on disk. Refuses to overwrite an existing
 *  target. */
export async function renameFolderAsync(oldRel: string, newRel: string): Promise<void> {
  const oldAbs = await resolveSafeAsync(oldRel, 'existing', 'source folder');
  const newAbs = await resolveSafeAsync(newRel, 'creatable', 'target folder');
  const oldStat = await fs.promises.stat(oldAbs).catch(() => null);
  if (!oldStat?.isDirectory()) throw new Error('source folder not found');
  const targetExists = await fs.promises.stat(newAbs).then(() => true, () => false);
  if (targetExists && !(await filesystemPath.sameExistingPathAsync(oldAbs, newAbs))) {
    throw new Error('target already exists');
  }
  await fs.promises.mkdir(path.dirname(newAbs), { recursive: true });
  await resolveSafeAsync(newRel, 'creatable', 'target folder');
  await renameAbsPreservingCaseAsync(oldAbs, newAbs);
}

/** Delete a folder and everything inside it (recursively). The route
 *  layer already prompts the user for confirmation before calling
 *  this, so the confirmation guard lives in the UI. */
export async function deleteFolderAsync(relPath: string): Promise<boolean> {
  let target: string;
  try { target = await resolveSafeAsync(relPath, 'existing', 'folder'); }
  catch { return false; }
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
    return true;
  } catch (err: any) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}
