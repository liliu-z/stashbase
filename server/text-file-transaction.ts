/** Shared text snapshots and per-source write transactions for saves and link rewrites. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSafeAsync } from './file-paths.ts';
import { filesystemPath } from './filesystem-path.ts';
import { requireCurrentFolder, runWithFolderRoot } from './folder.ts';
import { readFileBytesBoundedAsync, saveTextAsync } from './active-file-operations.ts';
import { decodeTextSnapshotBytes } from './text-decoding.ts';
import { setWriteDiagnosticTarget, writeDiagnosticEvidence, writeDiagnosticStep } from './write-diagnostic-context.ts';
import { writeDiagnosticTextMetrics } from './write-diagnostic-text.ts';

export interface TextSnapshot { content: string; version: string }
const writes = new Map<string, Promise<void>>();

async function writeIdentity(target: string): Promise<string> {
  // Atomic replacement owns a directory entry, not the old file's inode.
  // Resolve parent aliases while preserving any not-yet-created suffix.
  const suffix = [path.basename(target)];
  let parent = path.dirname(target);
  for (;;) {
    let physicalParent: string;
    try {
      physicalParent = await writeDiagnosticStep('path_resolution', 'write_identity_realpath', () => fs.promises.realpath(parent), {
        path: parent, syscall: 'realpath', target_path: target,
      });
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(parent) === parent) throw error;
      suffix.unshift(path.basename(parent));
      parent = path.dirname(parent);
      continue;
    }
    const identity = await filesystemPath.identityAsync(path.join(physicalParent, ...suffix));
    setWriteDiagnosticTarget(identity);
    writeDiagnosticEvidence('write_queue_identity', { path: target, physical_parent: physicalParent, comparison_identity: identity });
    return identity;
  }
}

export function textVersion(bytes: string | Uint8Array): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/** Content and its version always describe the same bounded read. */
export async function readTextSnapshotAsync(
  name: string,
  purpose: 'read_source' | 'write_previous' | 'commit_recheck' = 'read_source',
): Promise<TextSnapshot | null> {
  const target = await resolveSafeAsync(name, 'creatable');
  return writeDiagnosticStep('read', 'read_text_snapshot', async () => {
    try {
      const bytes = await readFileBytesBoundedAsync(target);
      const content = decodeTextSnapshotBytes(name, bytes);
      const version = textVersion(bytes);
      writeDiagnosticEvidence('text_snapshot', { path: target, purpose, present: true, read_version: version, text: writeDiagnosticTextMetrics(content) });
      return { content, version };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        writeDiagnosticEvidence('text_snapshot', { path: target, purpose, present: false, read_version: null, system_code: 'ENOENT' });
        return null;
      }
      throw error;
    }
  }, { path: target, purpose });
}

export function fileChanged(currentVersion: string | null): Error {
  return Object.assign(new Error('file changed on disk; reload before saving'), {
    code: 'FILE_CHANGED', currentVersion,
  });
}

/** Pin the folder before yielding; equivalent source spellings share one queue. */
export async function withTextFileTransaction<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return runWithFolderRoot(requireCurrentFolder(), async () => {
    const target = await resolveSafeAsync(name, 'creatable');
    const key = await writeIdentity(target);
    const queued = writes.has(key);
    const previous = writes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    writes.set(key, pending);
    const queueStarted = performance.now();
    writeDiagnosticEvidence('write_queue_enqueued', { path: target, comparison_identity: key, waited_for_previous: queued });
    await previous;
    writeDiagnosticEvidence('write_queue_acquired', { path: target, comparison_identity: key, wait_duration_ms: performance.now() - queueStarted });
    try { return await operation(); }
    finally {
      release();
      if (writes.get(key) === pending) writes.delete(key);
      writeDiagnosticEvidence('write_queue_released', { path: target, comparison_identity: key });
    }
  });
}

/** Called inside the source transaction. Recheck external edits after staging. */
export async function replaceTextSnapshotAsync(name: string, content: string, expectedVersion: string | null): Promise<TextSnapshot> {
  await saveTextAsync(name, content, async () => {
    await writeDiagnosticStep('version_check', 'check_commit_version', async () => {
      const current = await readTextSnapshotAsync(name, 'commit_recheck');
      writeDiagnosticEvidence('commit_version_result', { expected_version: expectedVersion, commit_version: current?.version ?? null });
      if ((current?.version ?? null) !== expectedVersion) throw fileChanged(current?.version ?? null);
    }, { expected_version: expectedVersion });
  });
  return { content, version: textVersion(content) };
}
