import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeDiagnosticEvidence, writeDiagnosticStep } from './write-diagnostic-context.ts';

/** Hidden sibling temp file, so the rename stays on one filesystem and a
 *  crash leaves a dot-file instead of a half-written target. */
function temporarySibling(file: string): string {
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
}

/** Write `data` to a temp sibling, then rename it over `file`. Creates the
 *  parent directory; removes the temp file when either step fails. */
export function writeFileAtomic(file: string, data: string | Uint8Array, options: { mode?: number } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = temporarySibling(file);
  try {
    fs.writeFileSync(tmp, data, options.mode === undefined ? undefined : { mode: options.mode });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

/** Async `writeFileAtomic`. `beforeRename` runs after the bytes are written
 *  and may abort the publish by throwing. */
export async function writeFileAtomicAsync(
  file: string,
  data: string | Uint8Array,
  options: { mode?: number; beforeRename?: () => Promise<void> } = {},
): Promise<void> {
  await writeDiagnosticStep('persist', 'atomic_create_parent', () => fs.promises.mkdir(path.dirname(file), { recursive: true }), {
    path: path.dirname(file), target_path: file, syscall: 'mkdir', recursive: true, target_partial_write_possible: false,
  });
  const tmp = temporarySibling(file);
  writeDiagnosticEvidence('atomic_write_plan', {
    path: file, temporary_path: tmp, strategy: 'temporary_sibling_then_rename',
    target_partial_write_possible: false, staging_partial_write_possible: true,
  });
  try {
    await writeDiagnosticStep('persist', 'write_staging_file', () => fs.promises.writeFile(tmp, data, options.mode === undefined ? undefined : { mode: options.mode }), {
      path: tmp, target_path: file, syscall: 'writeFile', mode: options.mode ?? null,
      size_bytes: typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength,
      target_partial_write_possible: false, staging_partial_write_possible: true,
    });
    // Creation applies umask; an explicit mode (including a source file's
    // existing permissions) must survive replacement exactly.
    if (options.mode !== undefined) {
      await writeDiagnosticStep('persist', 'restore_staging_permissions', () => fs.promises.chmod(tmp, options.mode!), {
        path: tmp, target_path: file, syscall: 'chmod', mode: options.mode,
      });
    }
    await options.beforeRename?.();
    await writeDiagnosticStep('persist', 'publish_staging_file', () => fs.promises.rename(tmp, file), {
      path: tmp, target_path: file, syscall: 'rename', target_partial_write_possible: false,
    });
    writeDiagnosticEvidence('atomic_write_published', { path: file, published: true, target_partial_write_possible: false });
  } catch (err) {
    try {
      await writeDiagnosticStep('persist', 'cleanup_staging_file', () => fs.promises.rm(tmp, { force: true }), { path: tmp, syscall: 'rm' });
      writeDiagnosticEvidence('atomic_write_cleanup', { temporary_path: tmp, cleanup_complete: true, published: false, target_partial_write_possible: false });
    } catch {
      writeDiagnosticEvidence('atomic_write_cleanup', { temporary_path: tmp, cleanup_complete: false, published: false, target_partial_write_possible: false });
    }
    throw err;
  }
}
