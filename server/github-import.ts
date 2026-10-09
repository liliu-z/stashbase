/** Public GitHub snapshot acquisition with staged publication. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { getFolderHome, registerProjectFolderAsync } from './folder.ts';
import { logger } from './log.ts';
import { validateFolderName } from '../shared/folder-name.ts';
import {
  parseGitHubRepositoryUrl,
  type ParsedGitHubRepositoryUrl,
} from '../shared/github-import.ts';

export { GitHubImportError } from './github-import-error.ts';
import { GitHubImportError } from './github-import-error.ts';
import { downloadGitHubSnapshot } from './github-snapshot.ts';

const log = logger('github-import');

export type ValidatedGitHubUrl = ParsedGitHubRepositoryUrl;

export function parseAndValidateGitHubUrl(
  rawUrl: unknown,
): { ok: true; parsed: ValidatedGitHubUrl } | { ok: false; error: GitHubImportError } {
  const result = parseGitHubRepositoryUrl(rawUrl);
  return result.ok
    ? result
    : {
        ok: false,
        error: new GitHubImportError(result.message, 'INVALID_GITHUB_URL', 400),
      };
}

export function detectGitLfs(gitattributesContent: string): boolean {
  for (const line of gitattributesContent.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    if (
      /\bfilter=lfs\b/i.test(clean)
      || /\bmerge=lfs\b/i.test(clean)
      || /\bdiff=lfs\b/i.test(clean)
    ) {
      return true;
    }
  }
  return false;
}

export interface GitHubImportDeps {
  folderHome(): string;
  fetch: typeof fetch;
  register(target: string, signal: AbortSignal): Promise<void>;
  publish(stagedRepository: string, target: string, signal: AbortSignal, commit: () => Promise<void>): Promise<void>;
}

interface PublishedEntry {
  path: string;
  stat: fs.BigIntStats;
  children: PublishedEntry[];
}

function sameIdentity(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino
    && a.birthtimeNs === b.birthtimeNs;
}

/** Publish without replacing entries, then roll back only unchanged owned items. */
export async function publishStagedRepository(
  stagedRepository: string,
  target: string,
  signal: AbortSignal,
  commit?: () => Promise<void>,
): Promise<void> {
  let root: PublishedEntry | undefined;
  const ancestors: PublishedEntry[] = [];

  async function publish(source: string, destination: string, parent?: PublishedEntry): Promise<void> {
    throwIfCancelled(signal);
    // Never continue into a directory that was replaced while we awaited I/O.
    for (const ancestor of ancestors) {
      const current = await fs.promises.lstat(ancestor.path, { bigint: true });
      if (!current.isDirectory() || !sameIdentity(ancestor.stat, current)) {
        throw destinationExists(path.basename(target));
      }
    }
    const sourceStat = await fs.promises.lstat(source, { bigint: true });
    let publishedStat: fs.BigIntStats;
    if (sourceStat.isDirectory()) {
      await fs.promises.mkdir(destination);
      publishedStat = await fs.promises.lstat(destination, { bigint: true });
    } else if (sourceStat.isSymbolicLink()) {
      const link = await fs.promises.readlink(source);
      const isDirectory = await fs.promises.stat(source).then((stat) => stat.isDirectory(), () => false);
      await fs.promises.symlink(link, destination, isDirectory ? 'dir' : 'file');
      publishedStat = await fs.promises.lstat(destination, { bigint: true });
    } else {
      try {
        // Staging and destination share a volume. A hard link atomically exposes
        // complete bytes and fails on collision; unlinking staging keeps the snapshot's
        // ordinary files and executable modes intact.
        await fs.promises.link(source, destination);
        publishedStat = sourceStat;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) throw err;
        // FAT/exFAT and some network volumes cannot hard-link. Exclusive copy
        // retains the same no-replace contract on those filesystems.
        await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
        publishedStat = await fs.promises.lstat(destination, { bigint: true });
      }
    }
    const entry: PublishedEntry = { path: destination, stat: publishedStat, children: [] };
    if (parent) parent.children.push(entry);
    else root = entry;
    throwIfCancelled(signal);
    if (sourceStat.isDirectory()) {
      ancestors.push(entry);
      try {
        for (const name of await fs.promises.readdir(source)) {
          await publish(path.join(source, name), path.join(destination, name), entry);
        }
      } finally {
        ancestors.pop();
      }
    }
  }

  try {
    await publish(stagedRepository, target);
    // Persist membership only after publication and cancellation checks. A
    // failed commit still owns this ledger and can safely roll publication back.
    throwIfCancelled(signal);
    await commit?.();
  } catch (err) {
    if (root) {
      await rollbackPublication(root);
      if (await pathExists(target)) {
        const retained = new GitHubImportError('Some files were retained after the import failed.', 'IMPORT_INCOMPLETE', 500);
        retained.retainedPath = target;
        throw retained;
      }
    }
    throw err;
  }
}

async function rollbackPublication(entry: PublishedEntry): Promise<void> {
  try {
    const current = await fs.promises.lstat(entry.path, { bigint: true });
    if (!sameIdentity(entry.stat, current)) return;
    if (entry.stat.isDirectory()) {
      for (let i = entry.children.length - 1; i >= 0; i--) {
        await rollbackPublication(entry.children[i]);
      }
      // Non-recursive removal preserves any new or modified user content.
      await fs.promises.rmdir(entry.path);
    } else if (current.size === entry.stat.size && current.mtimeNs === entry.stat.mtimeNs
      && current.mode === entry.stat.mode) {
      await fs.promises.unlink(entry.path);
    }
  } catch { /* Keep ambiguous or changed paths; the import failure is authoritative. */ }
}

export const productionGitHubImportDeps: GitHubImportDeps = {
  folderHome: getFolderHome,
  fetch: (...args) => fetch(...args),
  register: (target, signal) => registerProjectFolderAsync(target, { signal }),
  publish: publishStagedRepository,
};

export interface ImportPublicGitHubRepositoryInput {
  url: unknown;
  folderName?: unknown;
  signal?: AbortSignal;
}

export interface ImportPublicGitHubRepositoryResult {
  path: string;
}

interface ActiveImport {
  controller: AbortController;
  completion: Promise<void>;
  complete(): void;
}

const activeImports = new Set<ActiveImport>();

function createActiveImport(externalSignal?: AbortSignal): {
  active: ActiveImport;
  removeExternalListener(): void;
} {
  const controller = new AbortController();
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => { complete = resolve; });
  const active = { controller, completion, complete };
  const relayAbort = () => controller.abort(externalSignal?.reason ?? abortError());
  if (externalSignal?.aborted) relayAbort();
  else externalSignal?.addEventListener('abort', relayAbort, { once: true });
  return {
    active,
    removeExternalListener: () => externalSignal?.removeEventListener('abort', relayAbort),
  };
}

/** Abort active downloads and wait for its staging cleanup during app shutdown. */
export async function cancelAllGitHubImports(): Promise<number> {
  const active = [...activeImports];
  for (const operation of active) operation.controller.abort(abortError());
  await Promise.allSettled(active.map((operation) => operation.completion));
  return active.length;
}

export async function importPublicGitHubRepository(
  input: ImportPublicGitHubRepositoryInput,
  deps: GitHubImportDeps = productionGitHubImportDeps,
): Promise<ImportPublicGitHubRepositoryResult> {
  const urlValidation = parseAndValidateGitHubUrl(input.url);
  if (!urlValidation.ok) throw urlValidation.error;

  const { active, removeExternalListener } = createActiveImport(input.signal);
  activeImports.add(active);
  try {
    return await runImport(input, urlValidation.parsed, active.controller.signal, deps);
  } finally {
    removeExternalListener();
    activeImports.delete(active);
    active.complete();
  }
}

async function runImport(
  input: ImportPublicGitHubRepositoryInput,
  validatedUrl: ValidatedGitHubUrl,
  signal: AbortSignal,
  deps: GitHubImportDeps,
): Promise<ImportPublicGitHubRepositoryResult> {
  const rawFolderName = input.folderName === undefined
    ? validatedUrl.defaultFolderName
    : typeof input.folderName === 'string'
      ? input.folderName.trim()
      : '';
  const invalidFolderName = validateFolderName(rawFolderName);
  if (invalidFolderName) {
    throw new GitHubImportError(invalidFolderName, 'INVALID_FOLDER_NAME', 400);
  }

  throwIfCancelled(signal);
  const folderHome = deps.folderHome();
  await fs.promises.mkdir(folderHome, { recursive: true });
  throwIfCancelled(signal);
  const target = path.join(folderHome, rawFolderName);
  if (await pathExists(target)) throw destinationExists(rawFolderName);

  const operationRoot = path.join(folderHome, `.import-staging-${randomUUID()}`);
  const stagedRepository = path.join(operationRoot, 'repository');

  try {
    await fs.promises.mkdir(operationRoot, { recursive: false, mode: 0o700 });
    await fs.promises.mkdir(stagedRepository);
    await downloadGitHubSnapshot(validatedUrl, stagedRepository, signal, deps.fetch);

    throwIfCancelled(signal);
    if (await pathExists(path.join(stagedRepository, '.gitmodules'))) {
      throw new GitHubImportError(
        'Repositories with submodules are not supported.',
        'UNSUPPORTED_SUBMODULES',
        400,
      );
    }
    if (await repositoryDeclaresGitLfs(stagedRepository, signal)) {
      throw new GitHubImportError(
        'Repositories with Git LFS are not supported.',
        'UNSUPPORTED_LFS',
        400,
      );
    }

    throwIfCancelled(signal);
    if (await pathExists(target)) throw destinationExists(rawFolderName);
    try {
      await deps.publish(stagedRepository, target, signal, () => deps.register(target, signal));
    } catch (err: unknown) {
      if (err instanceof GitHubImportError && err.retainedPath) throw err;
      if (signal.aborted || isAbortError(err)) throw cancelled();
      if (isDestinationCollision(err)) throw destinationExists(rawFolderName);
      throw err;
    }

    return { path: target };
  } catch (err: unknown) {
    if (err instanceof GitHubImportError) throw err;
    if (signal.aborted || isAbortError(err)) throw cancelled();
    const code = (err as NodeJS.ErrnoException)?.code;
    log.warn(`GitHub import failed during local staging${code ? ` (${code})` : ''}`);
    throw new GitHubImportError('Failed to save or register the local copy.', 'LOCAL_IMPORT_FAILED', 500);
  } finally {
    try {
      await fs.promises.rm(operationRoot, { recursive: true, force: true });
    } catch {
      log.warn('GitHub import staging cleanup failed');
    }
  }
}

async function repositoryDeclaresGitLfs(root: string, signal: AbortSignal): Promise<boolean> {
  const pending = [root];
  while (pending.length > 0) {
    throwIfCancelled(signal);
    const current = pending.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name === '.gitattributes') {
        if (await fileDeclaresGitLfs(absolute, signal)) return true;
      }
    }
  }
  return false;
}

async function fileDeclaresGitLfs(file: string, signal: AbortSignal): Promise<boolean> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      throwIfCancelled(signal);
      if (detectGitLfs(String(line))) return true;
    }
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.promises.lstat(candidate);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw err;
  }
}

function isDestinationCollision(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}

function destinationExists(folderName: string): GitHubImportError {
  return new GitHubImportError(
    `A folder named "${folderName}" already exists in your folder home.`,
    'DESTINATION_EXISTS',
    409,
  );
}

function abortError(): Error {
  const err = new Error('GitHub import cancelled');
  err.name = 'AbortError';
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function cancelled(): GitHubImportError {
  return new GitHubImportError('Import was cancelled.', 'IMPORT_CANCELLED', 499);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}
