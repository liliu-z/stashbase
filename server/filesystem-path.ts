/**
 * Cross-platform filesystem path semantics.
 *
 * This module is the single seam between user/config/daemon path strings and
 * platform filesystem rules. Callers keep the source spelling returned by
 * `absolute()` for persistence and display, use `identity()` only for keyed
 * state, and use `resolveUnder()` for filesystem access scoped to a folder.
 */
import fs from 'node:fs';
import path from 'node:path';

// fs.promises.realpath() has no `.native` counterpart (unlike the sync and
// callback APIs), so wrap the callback-style native binding directly.
function realpathNativeAsync(input: fs.PathLike): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.realpath.native(input, (error, resolvedPath) => {
      if (error) reject(error);
      else resolve(resolvedPath);
    });
  });
}

export type FilesystemPlatform = 'win32' | 'darwin' | 'posix';
export type PathAccess = 'lexical' | 'existing' | 'creatable';

export interface ResolveUnderOptions {
  access?: PathAccess;
  label?: string;
}

export interface FilesystemPathModule {
  readonly platform: FilesystemPlatform;
  /** Absolute source spelling with POSIX separators. */
  absolute(input: string, base?: string): string;
  /** Whether input is an absolute path under the selected platform rules. */
  isAbsolute(input: string): boolean;
  /** Stable comparison/map identity following Windows and mounted macOS volume rules. */
  identity(input: string): string;
  /** Async request-path equivalent of `identity()`. */
  identityAsync(input: string): Promise<string>;
  /** Whether two existing spellings resolve to one path, excluding distinct hard links. */
  sameExistingPathAsync(a: string, b: string): Promise<boolean>;
  equal(a: string, b: string): boolean;
  equalAsync(a: string, b: string): Promise<boolean>;
  contains(root: string, candidate: string): boolean;
  containsAsync(root: string, candidate: string): Promise<boolean>;
  relative(root: string, candidate: string): string | null;
  relativeAsync(root: string, candidate: string): Promise<string | null>;
  join(root: string, relative: string): string;
  /** Restore real component spelling on case-insensitive filesystems. */
  canonicalRelative(root: string, relative: string): string;
  canonicalRelativeAsync(root: string, relative: string): Promise<string>;
  /** Resolve a folder-relative path and optionally enforce realpath safety. */
  resolveUnder(root: string, relative: string, options?: ResolveUnderOptions): string;
  /** Promise-based equivalent of `resolveUnder()` for staged migration of
   *  request-handling callers. Canonicalization, identity, containment, and
   *  realpath checks use async filesystem APIs. */
  resolveUnderAsync(root: string, relative: string, options?: ResolveUnderOptions): Promise<string>;
}

interface CreateFilesystemPathOptions {
  platform?: FilesystemPlatform;
  cwd?: string;
}

export function createFilesystemPath(
  options: CreateFilesystemPathOptions = {},
): FilesystemPathModule {
  const platform = options.platform ?? (
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'posix'
  );
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const defaultCwd = options.cwd ?? defaultCwdFor(platform);
  const volumeCaseInsensitive = new Map<number, boolean>();

  function absolute(input: string, base = defaultCwd): string {
    requirePath(input);
    const prepared = prepareInput(input, platform);
    const preparedBase = prepareInput(base, platform);
    const resolved = pathApi.resolve(preparedBase, prepared);
    return toSourceSeparators(resolved, platform);
  }

  function isAbsolute(input: string): boolean {
    requirePath(input);
    return pathApi.isAbsolute(prepareInput(input, platform));
  }

  function identity(input: string): string {
    const source = absolute(input);
    if (platform === 'win32') return source.toLowerCase();
    if (platform === 'darwin') return darwinIdentity(source);
    return source;
  }

  function darwinIdentity(source: string): string {
    const segments = source.split('/').filter(Boolean);
    const identitySegments: string[] = [];
    let cursor = '/';
    let insensitive = isCaseInsensitiveVolume(cursor);

    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      identitySegments.push(macIdentitySegment(segment, insensitive));

      const candidate = path.posix.join(cursor, segment);
      try {
        if (!fs.statSync(candidate).isDirectory()) {
          for (const suffix of segments.slice(i + 1)) {
            identitySegments.push(macIdentitySegment(suffix, insensitive));
          }
          break;
        }
        cursor = candidate;
        insensitive = isCaseInsensitiveVolume(cursor);
      } catch {
        for (const suffix of segments.slice(i + 1)) {
          identitySegments.push(macIdentitySegment(suffix, insensitive));
        }
        break;
      }
    }

    return `/${identitySegments.join('/')}`;
  }

  function isCaseInsensitiveVolume(existingDirectory: string): boolean {
    let directory = existingDirectory;
    let directoryStat: fs.Stats;
    try {
      directoryStat = fs.statSync(directory);
      if (!directoryStat.isDirectory()) {
        directory = path.posix.dirname(directory);
        directoryStat = fs.statSync(directory);
      }
    } catch {
      return false;
    }
    const cached = volumeCaseInsensitive.get(directoryStat.dev);
    if (cached !== undefined) return cached;

    const device = directoryStat.dev;
    let cursor = directory;
    while (true) {
      try {
        let inspectedAlias = false;
        for (const entry of fs.readdirSync(cursor)) {
          const alias = swapAsciiLetterCase(entry);
          if (alias === entry) continue;
          inspectedAlias = true;
          if (sameFilesystemAlias(
            path.posix.join(cursor, entry),
            path.posix.join(cursor, alias),
          )) {
            volumeCaseInsensitive.set(device, true);
            return true;
          }
        }
        if (inspectedAlias) {
          volumeCaseInsensitive.set(device, false);
          return false;
        }
      } catch {
        break;
      }
      const parent = path.posix.dirname(cursor);
      if (parent === cursor) break;
      try {
        if (fs.statSync(parent).dev !== device) break;
      } catch {
        break;
      }
      cursor = parent;
    }

    // Empty/unreadable case-sensitive volumes must not collapse distinct names.
    volumeCaseInsensitive.set(device, false);
    return false;
  }

  function sameExistingPathAsync(a: string, b: string): Promise<boolean> {
    return sameFilesystemAliasAsync(
      toNative(absolute(a), platform),
      toNative(absolute(b), platform),
    );
  }

  function equal(a: string, b: string): boolean {
    return identity(a) === identity(b);
  }

  function contains(root: string, candidate: string): boolean {
    const rootKey = identity(root);
    const candidateKey = identity(candidate);
    return candidateKey === rootKey || candidateKey.startsWith(childPrefix(rootKey));
  }

  async function identityAsync(input: string): Promise<string> {
    const source = absolute(input);
    if (platform === 'win32') return source.toLowerCase();
    if (platform === 'darwin') return darwinIdentityAsync(source);
    return source;
  }

  async function darwinIdentityAsync(source: string): Promise<string> {
    const segments = source.split('/').filter(Boolean);
    const identitySegments: string[] = [];
    let cursor = '/';
    let insensitive = await isCaseInsensitiveVolumeAsync(cursor);

    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      identitySegments.push(macIdentitySegment(segment, insensitive));

      const candidate = path.posix.join(cursor, segment);
      try {
        if (!(await fs.promises.stat(candidate)).isDirectory()) {
          for (const suffix of segments.slice(i + 1)) {
            identitySegments.push(macIdentitySegment(suffix, insensitive));
          }
          break;
        }
        cursor = candidate;
        insensitive = await isCaseInsensitiveVolumeAsync(cursor);
      } catch {
        for (const suffix of segments.slice(i + 1)) {
          identitySegments.push(macIdentitySegment(suffix, insensitive));
        }
        break;
      }
    }

    return `/${identitySegments.join('/')}`;
  }

  async function isCaseInsensitiveVolumeAsync(existingDirectory: string): Promise<boolean> {
    let directory = existingDirectory;
    let directoryStat: fs.Stats;
    try {
      directoryStat = await fs.promises.stat(directory);
      if (!directoryStat.isDirectory()) {
        directory = path.posix.dirname(directory);
        directoryStat = await fs.promises.stat(directory);
      }
    } catch {
      return false;
    }
    const cached = volumeCaseInsensitive.get(directoryStat.dev);
    if (cached !== undefined) return cached;

    const device = directoryStat.dev;
    let cursor = directory;
    while (true) {
      try {
        let inspectedAlias = false;
        for (const entry of await fs.promises.readdir(cursor)) {
          const alias = swapAsciiLetterCase(entry);
          if (alias === entry) continue;
          inspectedAlias = true;
          if (await sameFilesystemAliasAsync(
            path.posix.join(cursor, entry),
            path.posix.join(cursor, alias),
          )) {
            volumeCaseInsensitive.set(device, true);
            return true;
          }
        }
        if (inspectedAlias) {
          volumeCaseInsensitive.set(device, false);
          return false;
        }
      } catch {
        break;
      }
      const parent = path.posix.dirname(cursor);
      if (parent === cursor) break;
      try {
        if ((await fs.promises.stat(parent)).dev !== device) break;
      } catch {
        break;
      }
      cursor = parent;
    }

    volumeCaseInsensitive.set(device, false);
    return false;
  }

  async function containsAsync(root: string, candidate: string): Promise<boolean> {
    const [rootKey, candidateKey] = await Promise.all([
      identityAsync(root),
      identityAsync(candidate),
    ]);
    return candidateKey === rootKey || candidateKey.startsWith(childPrefix(rootKey));
  }

  async function equalAsync(a: string, b: string): Promise<boolean> {
    const [aKey, bKey] = await Promise.all([identityAsync(a), identityAsync(b)]);
    return aKey === bKey;
  }

  function relative(root: string, candidate: string): string | null {
    const rootSource = absolute(root);
    const candidateSource = absolute(candidate);
    if (!contains(rootSource, candidateSource)) return null;
    if (platform === 'darwin') {
      const rootDepth = rootSource.split('/').filter(Boolean).length;
      return candidateSource.split('/').filter(Boolean).slice(rootDepth).join('/');
    }
    const rel = pathApi.relative(toNative(rootSource, platform), toNative(candidateSource, platform));
    if (escapesRoot(rel, pathApi)) return null;
    return rel.split(pathApi.sep).join('/');
  }

  async function relativeAsync(root: string, candidate: string): Promise<string | null> {
    const rootSource = absolute(root);
    const candidateSource = absolute(candidate);
    if (!(await containsAsync(rootSource, candidateSource))) return null;
    if (platform === 'darwin') {
      const rootDepth = rootSource.split('/').filter(Boolean).length;
      return candidateSource.split('/').filter(Boolean).slice(rootDepth).join('/');
    }
    const rel = pathApi.relative(toNative(rootSource, platform), toNative(candidateSource, platform));
    if (escapesRoot(rel, pathApi)) return null;
    return rel.split(pathApi.sep).join('/');
  }

  function join(root: string, relativePath: string): string {
    const rootSource = absolute(root);
    return joinLexically(rootSource, relativePath);
  }

  function joinLexically(rootSource: string, relativePath: string): string {
    const rel = normalizeRelative(relativePath, platform);
    if (!rel) return rootSource;
    return absolute(toNative(rel, platform), toNative(rootSource, platform));
  }

  function canonicalRelative(root: string, relativePath: string): string {
    const rel = normalizeRelative(relativePath, platform);
    if (platform === 'posix' || !rel) return rel;
    const canonical: string[] = [];
    let cursor = toNative(absolute(root), platform);
    for (const segment of rel.split('/')) {
      let spelling = segment;
      try {
        const found = matchingExistingEntry(cursor, segment, platform === 'darwin');
        if (found) spelling = found;
      } catch {
        // A create target may have a missing suffix. Preserve caller spelling.
      }
      canonical.push(spelling);
      cursor = pathApi.join(cursor, spelling);
    }
    return canonical.join('/');
  }

  function canonicalCreatableRelative(root: string, relativePath: string): string {
    const rel = normalizeRelative(relativePath, platform);
    const lastSlash = rel.lastIndexOf('/');
    if (lastSlash < 0) return rel;
    const parent = canonicalRelative(root, rel.slice(0, lastSlash));
    return parent ? `${parent}/${rel.slice(lastSlash + 1)}` : rel.slice(lastSlash + 1);
  }

  function resolveUnder(
    root: string,
    relativePath: string,
    options: ResolveUnderOptions = {},
  ): string {
    const access = options.access ?? 'lexical';
    const label = options.label ?? 'path';
    const rootSource = absolute(root);
    const resolvedRelative = access === 'lexical'
      ? relativePath
      : access === 'creatable'
        ? canonicalCreatableRelative(rootSource, relativePath)
        : canonicalRelative(rootSource, relativePath);
    const targetSource = joinLexically(rootSource, resolvedRelative);
    const rootNative = toNative(rootSource, platform);
    const targetNative = toNative(targetSource, platform);
    if (access === 'lexical') return targetSource;

    const rootReal = fs.realpathSync.native(rootNative);
    if (access === 'existing') {
      const targetReal = fs.realpathSync.native(targetNative);
      if (!contains(rootReal, targetReal)) {
        throw new Error(`${label} escapes folder through symlink`);
      }
      return targetSource;
    }

    // Start at the target itself. If it already exists as a symlink, checking
    // only its parent would approve a subsequent write that follows outside
    // the folder. Missing suffixes naturally walk up to their first existing
    // ancestor.
    let probe = targetNative;
    while (!fs.existsSync(probe)) {
      const parent = pathApi.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (!contains(rootNative, probe)) throw new Error(`${label} escapes folder`);
    const probeReal = fs.realpathSync.native(probe);
    if (!contains(rootReal, probeReal)) {
      throw new Error(`${label} escapes folder through symlink`);
    }
    return targetSource;
  }

  // --- Async mirrors for the request-handling path -------------------------
  // These duplicate the sync functions above one-for-one using async
  // filesystem APIs for canonicalization, containment, and realpath work.
  // They establish a migration path for request handlers without introducing
  // blocking filesystem calls into async request execution.
  // Kept as separate functions, rather than a sync/async flag on the
  // existing ones, so neither implementation has to guard against `await`
  // inside a hot, already-audited sync path.

  async function canonicalRelativeAsync(root: string, relativePath: string): Promise<string> {
    const rel = normalizeRelative(relativePath, platform);
    if (platform === 'posix' || !rel) return rel;
    const canonical: string[] = [];
    let cursor = toNative(absolute(root), platform);
    for (const segment of rel.split('/')) {
      let spelling = segment;
      try {
        const found = await matchingExistingEntryAsync(cursor, segment, platform === 'darwin');
        if (found) spelling = found;
      } catch {
        // A create target may have a missing suffix. Preserve caller spelling.
      }
      canonical.push(spelling);
      cursor = pathApi.join(cursor, spelling);
    }
    return canonical.join('/');
  }

  async function canonicalCreatableRelativeAsync(root: string, relativePath: string): Promise<string> {
    const rel = normalizeRelative(relativePath, platform);
    const lastSlash = rel.lastIndexOf('/');
    if (lastSlash < 0) return rel;
    const parent = await canonicalRelativeAsync(root, rel.slice(0, lastSlash));
    return parent ? `${parent}/${rel.slice(lastSlash + 1)}` : rel.slice(lastSlash + 1);
  }

  async function resolveUnderAsync(
    root: string,
    relativePath: string,
    options: ResolveUnderOptions = {},
  ): Promise<string> {
    const access = options.access ?? 'lexical';
    const label = options.label ?? 'path';
    const rootSource = absolute(root);
    const resolvedRelative = access === 'lexical'
      ? relativePath
      : access === 'creatable'
        ? await canonicalCreatableRelativeAsync(rootSource, relativePath)
        : await canonicalRelativeAsync(rootSource, relativePath);
    const targetSource = joinLexically(rootSource, resolvedRelative);
    const rootNative = toNative(rootSource, platform);
    const targetNative = toNative(targetSource, platform);
    if (access === 'lexical') return targetSource;

    const rootReal = await realpathNativeAsync(rootNative);
    if (access === 'existing') {
      const targetReal = await realpathNativeAsync(targetNative);
      if (!(await containsAsync(rootReal, targetReal))) {
        throw new Error(`${label} escapes folder through symlink`);
      }
      return targetSource;
    }

    // Start at the target itself. If it already exists as a symlink, checking
    // only its parent would approve a subsequent write that follows outside
    // the folder. Missing suffixes naturally walk up to their first existing
    // ancestor.
    let probe = targetNative;
    while (!(await existsAsync(probe))) {
      const parent = pathApi.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (!(await containsAsync(rootNative, probe))) throw new Error(`${label} escapes folder`);
    const probeReal = await realpathNativeAsync(probe);
    if (!(await containsAsync(rootReal, probeReal))) {
      throw new Error(`${label} escapes folder through symlink`);
    }
    return targetSource;
  }

  return {
    platform,
    absolute,
    isAbsolute,
    identity,
    identityAsync,
    sameExistingPathAsync,
    equal,
    equalAsync,
    contains,
    containsAsync,
    relative,
    relativeAsync,
    join,
    canonicalRelative,
    canonicalRelativeAsync,
    resolveUnder,
    resolveUnderAsync,
  };
}

export const filesystemPath = createFilesystemPath();

function requirePath(input: string): void {
  if (typeof input !== 'string' || input.length === 0) throw new Error('path required');
}

function defaultCwdFor(platform: FilesystemPlatform): string {
  // A module for another platform than the host's (tests) cannot resolve
  // against the host's working directory, so it starts at that platform's root.
  if (platform !== 'win32') return path.posix.isAbsolute(process.cwd()) ? process.cwd() : '/';
  return path.win32.isAbsolute(process.cwd()) ? process.cwd() : 'C:\\';
}

function prepareInput(input: string, platform: FilesystemPlatform): string {
  if (platform !== 'win32') {
    if (/^[A-Za-z]:[\\/]/.test(input)) {
      throw new Error('Windows drive paths are only valid on Windows');
    }
    return input;
  }
  const native = input.replace(/\//g, '\\');
  if (/^\\\\\.\\/.test(native)) throw new Error('Windows device paths are not supported');
  if (/^[A-Za-z]:($|[^\\])/.test(native)) {
    throw new Error('drive-relative Windows paths are not supported');
  }
  if (/^\\\\\?\\UNC\\/i.test(native)) return `\\\\${native.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(native)) return native.slice(4);
  if (/^\\\\\?\\/.test(native) || /^\\(?:\?\?|GLOBALROOT)\\/i.test(native)) {
    throw new Error('unsupported Windows namespace path');
  }
  return native;
}

function toSourceSeparators(input: string, platform: FilesystemPlatform): string {
  return platform === 'win32' ? input.replace(/\\/g, '/') : input;
}

function toNative(input: string, platform: FilesystemPlatform): string {
  return platform === 'win32' ? input.replace(/\//g, '\\') : input;
}

function childPrefix(root: string): string {
  return root.endsWith('/') ? root : `${root}/`;
}

function normalizeRelative(input: string, platform: FilesystemPlatform): string {
  if (typeof input !== 'string') throw new Error('path required');
  const source = input.replace(/\\/g, '/');
  if (source.startsWith('/') || (platform === 'win32' && /^[A-Za-z]:/.test(source))) {
    throw new Error('path must be relative to the folder');
  }
  const segments = source.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('invalid path segment');
  }
  return segments.join('/');
}

function macIdentitySegment(input: string, caseInsensitive: boolean): string {
  const normalized = input.normalize('NFC');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function swapAsciiLetterCase(input: string): string {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      return input.slice(0, i) + input[i].toLowerCase() + input.slice(i + 1);
    }
    if (code >= 97 && code <= 122) {
      return input.slice(0, i) + input[i].toUpperCase() + input.slice(i + 1);
    }
  }
  return input;
}

function sameFilesystemEntry(a: string, b: string): boolean {
  try {
    const aStat = fs.statSync(a);
    const bStat = fs.statSync(b);
    return aStat.dev === bStat.dev && aStat.ino === bStat.ino;
  } catch {
    return false;
  }
}

function sameFilesystemAlias(a: string, b: string): boolean {
  if (!sameFilesystemEntry(a, b)) return false;
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

function matchingExistingEntry(cursor: string, segment: string, verifyAlias: boolean): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(cursor);
  } catch {
    return undefined;
  }
  const exact = entries.find((entry) => entry === segment);
  if (exact) return exact;
  const folded = segment.normalize('NFC').toLowerCase();
  const alias = entries.find((entry) => entry.normalize('NFC').toLowerCase() === folded);
  if (!alias) return undefined;
  if (!verifyAlias) return alias;
  return sameFilesystemEntry(path.posix.join(cursor, segment), path.posix.join(cursor, alias))
    ? alias
    : undefined;
}

async function existsAsync(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function sameFilesystemEntryAsync(a: string, b: string): Promise<boolean> {
  try {
    const [aStat, bStat] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
    return aStat.dev === bStat.dev && aStat.ino === bStat.ino;
  } catch {
    return false;
  }
}

async function sameFilesystemAliasAsync(a: string, b: string): Promise<boolean> {
  if (!(await sameFilesystemEntryAsync(a, b))) return false;
  try {
    const [aReal, bReal] = await Promise.all([
      realpathNativeAsync(a),
      realpathNativeAsync(b),
    ]);
    return aReal === bReal;
  } catch {
    return false;
  }
}

async function matchingExistingEntryAsync(
  cursor: string,
  segment: string,
  verifyAlias: boolean,
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(cursor);
  } catch {
    return undefined;
  }
  const exact = entries.find((entry) => entry === segment);
  if (exact) return exact;
  const folded = segment.normalize('NFC').toLowerCase();
  const alias = entries.find((entry) => entry.normalize('NFC').toLowerCase() === folded);
  if (!alias) return undefined;
  if (!verifyAlias) return alias;
  return (await sameFilesystemEntryAsync(path.posix.join(cursor, segment), path.posix.join(cursor, alias)))
    ? alias
    : undefined;
}

function escapesRoot(relative: string, pathApi: typeof path.posix | typeof path.win32): boolean {
  return relative === '..'
    || relative.startsWith(`..${pathApi.sep}`)
    || pathApi.isAbsolute(relative);
}
