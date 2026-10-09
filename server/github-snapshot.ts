/** Anonymous GitHub archives, bounded in transit and confined to fresh staging. */
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Header, Parser, type ReadEntry } from 'tar';
import type { ParsedGitHubRepositoryUrl } from '../shared/github-import.ts';
import { GitHubImportError } from './github-import-error.ts';

const DEFAULT_LIMITS = {
  downloadBytes: 512 * 1024 * 1024,
  expandedBytes: 2 * 1024 * 1024 * 1024,
  entries: 50_000,
  idleMs: 30_000,
};

function invalidArchive(): GitHubImportError {
  return new GitHubImportError('The repository snapshot contains invalid or unsupported files.', 'INVALID_ARCHIVE');
}

function tooLarge(): GitHubImportError {
  return new GitHubImportError('The repository snapshot exceeds import limits.', 'ARCHIVE_TOO_LARGE', 413);
}

function boundedBytes(max: number, onChunk?: () => void): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onChunk?.();
      bytes += chunk.length;
      callback(bytes > max ? tooLarge() : null, chunk);
    },
  });
}

/** The parser also accepts compressed input; enforce one gzip layer so the
 * expanded-byte bound covers everything it can read, including tar metadata. */
function tarHeader(): Transform {
  let prefix = Buffer.alloc(0);
  let checked = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (checked) { callback(null, chunk); return; }
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length < 512) { callback(); return; }
      if (!new Header(prefix).cksumValid) { callback(invalidArchive()); return; }
      checked = true;
      callback(null, prefix);
      prefix = Buffer.alloc(0);
    },
    flush(callback) { callback(checked ? null : invalidArchive()); },
  });
}

/** No token, Git config, shell, or executable from the source repository is used. */
export async function downloadGitHubSnapshot(
  repository: ParsedGitHubRepositoryUrl,
  destination: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
  overrides: Partial<typeof DEFAULT_LIMITS> = {},
): Promise<void> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout>;
  const armTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('Snapshot download stalled')), limits.idleMs);
    timer.unref();
  };
  let response: Response | undefined;
  try {
    combined.throwIfAborted();
    armTimeout();
    // Omitting ref selects the default branch, including repositories using a
    // name other than main. Only GitHub's API and archive service may redirect.
    let url = new URL(`https://api.github.com/repos/${repository.owner}/${repository.repo}/tarball`);
    for (let redirects = 0; ; redirects++) {
      response = await request(url.href, {
        signal: combined, redirect: 'manual', credentials: 'omit',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'StashBase' },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects >= 3) throw new Error('Invalid archive redirect');
      url = new URL(location, url);
      if (url.protocol !== 'https:' || url.port || url.username || url.password
        || !['api.github.com', 'codeload.github.com'].includes(url.hostname)) {
        throw new Error('Archive redirect leaves GitHub');
      }
    }
    if (response.status === 404) {
      throw new GitHubImportError('Repository not found or private. Make sure it exists and is public.', 'PRIVATE_OR_NOT_FOUND', 404);
    }
    // Rate limits and service failures are retryable download errors, not proof
    // that a public repository is private or missing.
    if (!response.ok || !response.body) throw new Error(`Archive HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > limits.downloadBytes) throw tooLarge();
    await extractSnapshot(response.body, destination, combined, limits, armTimeout);
  } catch (error) {
    if (signal.aborted) throw new GitHubImportError('Import was cancelled.', 'IMPORT_CANCELLED', 499);
    if (error instanceof GitHubImportError) throw error;
    // Filesystem failures retain the import transaction's local-failure mapping.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code && ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EMFILE', 'ENFILE', 'EIO'].includes(code)) throw error;
    throw new GitHubImportError('Failed to download the repository snapshot.', 'DOWNLOAD_FAILED', 502);
  } finally {
    clearTimeout(timer!);
    controller.abort();
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

async function extractSnapshot(
  body: ReadableStream<Uint8Array>,
  destination: string,
  signal: AbortSignal,
  limits: typeof DEFAULT_LIMITS,
  onChunk: () => void,
): Promise<void> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const pending = new Set<Promise<void>>();
  const links: Array<{ file: string; target: string }> = [];
  const declared = new Set<string>();
  const kinds = new Map<string, string>();
  let root: string | undefined;
  let count = 0;
  let size = 0;
  let failure: unknown;
  const fail = (error: unknown) => {
    failure ??= error;
    controller.abort(error);
  };
  const parser = new Parser({ strict: true, maxMetaEntrySize: 1024 * 1024 });
  // The wrapper gives tar's event-based parser a cancellable Node stream. Entry
  // writes are awaited separately before the caller can remove staging.
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      if (parser.write(chunk)) callback();
      else parser.once('drain', callback);
    },
    final(callback) {
      parser.once('end', callback);
      parser.end();
    },
    destroy(error, callback) {
      if (error) { fail(error); parser.abort(error); }
      callback(error);
    },
  });
  parser.on('error', (error) => { fail(error instanceof GitHubImportError ? error : invalidArchive()); sink.destroy(error); });
  parser.on('ignoredEntry', () => { const error = invalidArchive(); fail(error); sink.destroy(error); });
  parser.on('entry', (entry: ReadEntry) => {
    const work = writeEntry(entry).catch(fail);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });

  async function writeEntry(entry: ReadEntry): Promise<void> {
    combined.throwIfAborted();
    const parts = entry.path.replace(/\/$/, '').split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'
      || /[\\:\x00-\x1f<>"|?*]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw invalidArchive();
    root ??= parts[0];
    if (parts[0] !== root || !['File', 'Directory', 'SymbolicLink'].includes(entry.type)
      || (parts.length === 1 && entry.type !== 'Directory')) throw invalidArchive();
    if (++count > limits.entries || (size += entry.size) > limits.expandedBytes) throw tooLarge();
    // Portable identity prevents case/Unicode aliases overwriting one another on
    // macOS or Windows. Implicit parents may only ever become directories.
    const relative = parts.slice(1).join('/');
    const key = relative.normalize('NFC').toLowerCase();
    if (declared.has(key) || (kinds.has(key) && kinds.get(key) !== entry.type)) throw invalidArchive();
    declared.add(key);
    kinds.set(key, entry.type);
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(1, i + 1).join('/').normalize('NFC').toLowerCase();
      if (kinds.has(parent) && kinds.get(parent) !== 'Directory') throw invalidArchive();
      kinds.set(parent, 'Directory');
    }
    const file = path.join(destination, relative);
    if (entry.type === 'SymbolicLink') {
      const target = entry.linkpath ?? '';
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
      if (!target || /[\\:\x00-\x1f]/.test(target) || path.posix.isAbsolute(target)
        || resolved === '..' || resolved.startsWith('../')) throw invalidArchive();
      links.push({ file, target });
      entry.resume();
      return;
    }
    if (entry.type === 'Directory') {
      await fs.promises.mkdir(file, { recursive: true });
      entry.resume();
      return;
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await pipeline(entry, fs.createWriteStream(file, {
      flags: 'wx', mode: ((entry.mode ?? 0o644) & 0o777) | 0o600,
    }), { signal: combined });
  }

  try {
    await pipeline(
      Readable.fromWeb(body), boundedBytes(limits.downloadBytes, onChunk),
      createGunzip(), boundedBytes(limits.expandedBytes), tarHeader(), sink, { signal: combined },
    );
    await Promise.all(pending);
    if (failure) throw failure;
    if (!root) throw invalidArchive();
    // Links are installed only after regular files, so no archive entry can
    // write through a link. Resolve every link before publishing, including
    // chains; dangling, cyclic, and escaping links are refused.
    for (const link of links) {
      combined.throwIfAborted();
      await fs.promises.mkdir(path.dirname(link.file), { recursive: true });
      const isDirectory = await fs.promises.stat(path.resolve(path.dirname(link.file), link.target))
        .then((stat) => stat.isDirectory(), () => false);
      await fs.promises.symlink(link.target, link.file, isDirectory ? 'dir' : 'file');
    }
    const realRoot = await fs.promises.realpath(destination);
    for (const link of links) {
      combined.throwIfAborted();
      const real = await fs.promises.realpath(link.file).catch(() => { throw invalidArchive(); });
      const relative = path.relative(realRoot, real);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw invalidArchive();
    }
  } catch (error) {
    fail(error);
    await Promise.all(pending);
    if (signal.aborted) throw signal.reason;
    if (failure instanceof GitHubImportError) throw failure;
    if ((failure as NodeJS.ErrnoException)?.code?.startsWith('Z_')) throw invalidArchive();
    throw failure;
  }
}
