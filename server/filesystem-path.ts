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
import { writeDiagnosticEvidence, writeDiagnosticStep } from './write-diagnostic-context.ts';

type PathEvidence = Record<string, string | number | boolean | null>;

/** Observe a check where it executes. These helpers never repeat a filesystem
 * call, include file bytes, or retain directory enumeration results. */
function observePathCheck<T>(action: string, evidence: PathEvidence, work: () => T): T {
  const started = performance.now();
  try {
    const result = work();
    writeDiagnosticEvidence(action, { ...evidence, outcome: 'ok', duration_ms: performance.now() - started,
      ...(typeof result === 'string' || typeof result === 'boolean' ? { result } : {}) });
    return result;
  } catch (error) {
    recordPathCheckError(action, evidence, error, started);
    throw error;
  }
}

async function observePathCheckAsync<T>(action: string, evidence: PathEvidence, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await work();
    writeDiagnosticEvidence(action, { ...evidence, outcome: 'ok', duration_ms: performance.now() - started,
      ...(typeof result === 'string' || typeof result === 'boolean' ? { result } : {}) });
    return result;
  } catch (error) {
    recordPathCheckError(action, evidence, error, started);
    throw error;
  }
}

function recordPathCheckError(action: string, evidence: PathEvidence, error: unknown, started?: number): void {
  const value = error as NodeJS.ErrnoException | null;
  writeDiagnosticEvidence(action, {
    ...evidence, outcome: 'error', duration_ms: started === undefined ? null : performance.now() - started,
    error_type: error instanceof Error ? error.name : typeof error,
    code: typeof value?.code === 'string' ? value.code : null,
    errno: typeof value?.errno === 'number' ? value.errno : null,
    syscall: typeof value?.syscall === 'string' ? value.syscall : null,
  });
}

function pathError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

// fs.promises.realpath() has no `.native` counterpart (unlike the sync and
// callback APIs), so wrap the callback-style native binding directly.
function realpathNativeAsync(input: fs.PathLike): Promise<string> {
  return observePathCheckAsync('path.realpath', { path: String(input), syscall: 'realpath', mode: 'async' }, () => new Promise((resolve, reject) => {
    fs.realpath.native(input, (error, resolvedPath) => {
      if (error) reject(error);
      else resolve(resolvedPath);
    });
  }));
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
    const result = platform === 'win32' ? source.toLowerCase() : platform === 'darwin' ? darwinIdentity(source) : source;
    recordIdentity(source, result);
    return result;
  }

  function recordIdentity(source: string, result: string): void {
    writeDiagnosticEvidence('path.identity', {
      path: source, comparison_identity: result, platform,
      case_rule: platform === 'win32' ? 'lowercase' : platform === 'darwin' ? 'per_volume' : 'sensitive',
      unicode_rule: platform === 'darwin' ? 'NFC' : 'preserve',
      separator_rule: platform === 'win32' ? 'backslash_to_slash' : 'preserve',
    });
  }

  function darwinIdentity(source: string): string {
    const segments = source.split('/').filter(Boolean);
    const identitySegments: string[] = [];
    let cursor = '/';
    let insensitive = isCaseInsensitiveVolume(cursor);
    const caseRules = [{ from_component: 0, case_insensitive: insensitive }];

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
        if (caseRules.at(-1)?.case_insensitive !== insensitive) caseRules.push({ from_component: i + 1, case_insensitive: insensitive });
      } catch (error) {
        recordPathCheckError('path.identity_suffix', { path: candidate, fallback: 'retain_remaining_segments' }, error);
        for (const suffix of segments.slice(i + 1)) {
          identitySegments.push(macIdentitySegment(suffix, insensitive));
        }
        break;
      }
    }

    writeDiagnosticEvidence('path.volume_rules', { path: source, rules: caseRules, unicode_rule: 'NFC' });
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
    } catch (error) {
      recordPathCheckError('path.volume_case', { path: directory, fallback: 'case_sensitive' }, error);
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
            false,
          )) {
            volumeCaseInsensitive.set(device, true);
            writeDiagnosticEvidence('path.volume_case', { path: directory, device, case_insensitive: true, source: 'observed_alias' });
            return true;
          }
        }
        if (inspectedAlias) {
          volumeCaseInsensitive.set(device, false);
          writeDiagnosticEvidence('path.volume_case', { path: directory, device, case_insensitive: false, source: 'observed_distinct_entries' });
          return false;
        }
      } catch (error) {
        recordPathCheckError('path.volume_case_probe', { path: cursor, syscall: 'readdir', fallback: 'case_sensitive' }, error);
        break;
      }
      const parent = path.posix.dirname(cursor);
      if (parent === cursor) break;
      try {
        if (fs.statSync(parent).dev !== device) break;
      } catch (error) {
        recordPathCheckError('path.volume_case_probe', { path: parent, syscall: 'stat', fallback: 'case_sensitive' }, error);
        break;
      }
      cursor = parent;
    }

    // Empty/unreadable case-sensitive volumes must not collapse distinct names.
    volumeCaseInsensitive.set(device, false);
    writeDiagnosticEvidence('path.volume_case', { path: directory, device, case_insensitive: false, source: 'fallback_unproven' });
    return false;
  }

  function sameExistingPathAsync(a: string, b: string): Promise<boolean> {
    return sameFilesystemAliasAsync(
      toNative(absolute(a), platform),
      toNative(absolute(b), platform),
    );
  }

  function equal(a: string, b: string): boolean {
    const quick = lexicalEquality(a, b);
    if (quick !== undefined) {
      writeDiagnosticEvidence('path.equal', { a, b, matches: quick, rule: 'lexical_fast_path', platform });
      return quick;
    }
    const aKey = identity(a), bKey = identity(b);
    const matches = aKey === bKey;
    writeDiagnosticEvidence('path.equal', { a, b, a_identity: aKey, b_identity: bKey, matches, rule: 'volume_identity', platform });
    return matches;
  }

  /** Volume rules can change case sensitivity, never other characters.
   * Possible macOS aliases still require the real volume rules. */
  function lexicalEquality(a: string, b: string): boolean | undefined {
    const aSource = absolute(a), bSource = absolute(b);
    if (aSource === bSource) return true;
    if (platform !== 'darwin') return identity(aSource) === identity(bSource);
    if (macIdentitySegment(aSource, true) !== macIdentitySegment(bSource, true)) return false;
    return undefined;
  }

  function contains(root: string, candidate: string): boolean {
    const rootKey = identity(root);
    const candidateKey = identity(candidate);
    const matches = candidateKey === rootKey || candidateKey.startsWith(childPrefix(rootKey));
    writeDiagnosticEvidence('path.contains', { root, candidate, root_identity: rootKey, candidate_identity: candidateKey, matches, platform });
    return matches;
  }

  async function identityAsync(input: string): Promise<string> {
    const source = absolute(input);
    const result = platform === 'win32' ? source.toLowerCase() : platform === 'darwin' ? await darwinIdentityAsync(source) : source;
    recordIdentity(source, result);
    return result;
  }

  async function darwinIdentityAsync(source: string): Promise<string> {
    const segments = source.split('/').filter(Boolean);
    const identitySegments: string[] = [];
    let cursor = '/';
    let insensitive = await isCaseInsensitiveVolumeAsync(cursor);
    const caseRules = [{ from_component: 0, case_insensitive: insensitive }];

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
        if (caseRules.at(-1)?.case_insensitive !== insensitive) caseRules.push({ from_component: i + 1, case_insensitive: insensitive });
      } catch (error) {
        recordPathCheckError('path.identity_suffix', { path: candidate, fallback: 'retain_remaining_segments' }, error);
        for (const suffix of segments.slice(i + 1)) {
          identitySegments.push(macIdentitySegment(suffix, insensitive));
        }
        break;
      }
    }

    writeDiagnosticEvidence('path.volume_rules', { path: source, rules: caseRules, unicode_rule: 'NFC' });
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
    } catch (error) {
      recordPathCheckError('path.volume_case', { path: directory, fallback: 'case_sensitive' }, error);
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
            false,
          )) {
            volumeCaseInsensitive.set(device, true);
            writeDiagnosticEvidence('path.volume_case', { path: directory, device, case_insensitive: true, source: 'observed_alias' });
            return true;
          }
        }
        if (inspectedAlias) {
          volumeCaseInsensitive.set(device, false);
          writeDiagnosticEvidence('path.volume_case', { path: directory, device, case_insensitive: false, source: 'observed_distinct_entries' });
          return false;
        }
      } catch (error) {
        recordPathCheckError('path.volume_case_probe', { path: cursor, syscall: 'readdir', fallback: 'case_sensitive' }, error);
        break;
      }
      const parent = path.posix.dirname(cursor);
      if (parent === cursor) break;
      try {
        if ((await fs.promises.stat(parent)).dev !== device) break;
      } catch (error) {
        recordPathCheckError('path.volume_case_probe', { path: parent, syscall: 'stat', fallback: 'case_sensitive' }, error);
        break;
      }
      cursor = parent;
    }

    volumeCaseInsensitive.set(device, false);
    writeDiagnosticEvidence('path.volume_case', { path: directory, device, case_insensitive: false, source: 'fallback_unproven' });
    return false;
  }

  async function containsAsync(root: string, candidate: string): Promise<boolean> {
    const [rootKey, candidateKey] = await Promise.all([
      identityAsync(root),
      identityAsync(candidate),
    ]);
    const matches = candidateKey === rootKey || candidateKey.startsWith(childPrefix(rootKey));
    writeDiagnosticEvidence('path.contains', { root, candidate, root_identity: rootKey, candidate_identity: candidateKey, matches, platform });
    return matches;
  }

  async function equalAsync(a: string, b: string): Promise<boolean> {
    const quick = lexicalEquality(a, b);
    if (quick !== undefined) {
      writeDiagnosticEvidence('path.equal', { a, b, matches: quick, rule: 'lexical_fast_path', platform });
      return quick;
    }
    const [aKey, bKey] = await Promise.all([identityAsync(a), identityAsync(b)]);
    const matches = aKey === bKey;
    writeDiagnosticEvidence('path.equal', { a, b, a_identity: aKey, b_identity: bKey, matches, rule: 'volume_identity', platform });
    return matches;
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
      } catch (error) {
        recordPathCheckError('path.canonical_component', { path: pathApi.join(cursor, segment), fallback: 'caller_spelling' }, error);
        // A create target may have a missing suffix. Preserve caller spelling.
      }
      canonical.push(spelling);
      cursor = pathApi.join(cursor, spelling);
    }
    const result = canonical.join('/');
    writeDiagnosticEvidence('path.canonical_relative', { root, relative_path: relativePath, canonical_relative: result, platform });
    return result;
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
    return writeDiagnosticStep('path_resolution', 'path.resolve_under', () => {
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
      writeDiagnosticEvidence('path.resolve_under.inputs', { root, relative_path: relativePath, root_source: rootSource, target_source: targetSource, root_native: rootNative, target_native: targetNative, access, platform });
      if (access === 'lexical') return targetSource;

      const rootReal = observePathCheck('path.realpath', { path: rootNative, syscall: 'realpath', mode: 'sync' }, () => fs.realpathSync.native(rootNative));
      if (access === 'existing') {
        const targetReal = observePathCheck('path.realpath', { path: targetNative, syscall: 'realpath', mode: 'sync' }, () => fs.realpathSync.native(targetNative));
        if (!contains(rootReal, targetReal)) {
          throw pathError(`${label} escapes folder through symlink`, 'PATH_SYMLINK_ESCAPE');
        }
        return targetSource;
      }

      // Start at the target itself. If it already exists as a symlink, checking
      // only its parent would approve a subsequent write that follows outside
      // the folder. Missing suffixes naturally walk up to their first existing
      // ancestor.
      let probe = targetNative;
      while (!observePathCheck('path.exists', { path: probe, syscall: 'existsSync', errors_available: false }, () => fs.existsSync(probe))) {
        const parent = pathApi.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      if (!contains(rootNative, probe)) throw pathError(`${label} escapes folder`, 'PATH_OUTSIDE_ROOT');
      const probeReal = observePathCheck('path.realpath', { path: probe, syscall: 'realpath', mode: 'sync' }, () => fs.realpathSync.native(probe));
      if (!contains(rootReal, probeReal)) {
        throw pathError(`${label} escapes folder through symlink`, 'PATH_SYMLINK_ESCAPE');
      }
      return targetSource;
    });
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
      } catch (error) {
        recordPathCheckError('path.canonical_component', { path: pathApi.join(cursor, segment), fallback: 'caller_spelling' }, error);
        // A create target may have a missing suffix. Preserve caller spelling.
      }
      canonical.push(spelling);
      cursor = pathApi.join(cursor, spelling);
    }
    const result = canonical.join('/');
    writeDiagnosticEvidence('path.canonical_relative', { root, relative_path: relativePath, canonical_relative: result, platform });
    return result;
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
    return writeDiagnosticStep('path_resolution', 'path.resolve_under', async () => {
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
      writeDiagnosticEvidence('path.resolve_under.inputs', { root, relative_path: relativePath, root_source: rootSource, target_source: targetSource, root_native: rootNative, target_native: targetNative, access, platform });
      if (access === 'lexical') return targetSource;

      const rootReal = await realpathNativeAsync(rootNative);
      if (access === 'existing') {
        const targetReal = await realpathNativeAsync(targetNative);
        if (!(await containsAsync(rootReal, targetReal))) {
          throw pathError(`${label} escapes folder through symlink`, 'PATH_SYMLINK_ESCAPE');
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
      if (!(await containsAsync(rootNative, probe))) throw pathError(`${label} escapes folder`, 'PATH_OUTSIDE_ROOT');
      const probeReal = await realpathNativeAsync(probe);
      if (!(await containsAsync(rootReal, probeReal))) {
        throw pathError(`${label} escapes folder through symlink`, 'PATH_SYMLINK_ESCAPE');
      }
      return targetSource;
    });
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
  if (typeof input !== 'string' || input.length === 0) throw pathError('path required', 'PATH_REQUIRED');
}

function defaultCwdFor(platform: FilesystemPlatform): string {
  // A module for another platform than the host's (tests) cannot resolve
  // against the host's working directory, so it starts at that platform's
  // root. A POSIX cwd is rooted in win32 terms too, so compare the platforms.
  if ((platform === 'win32') === (process.platform === 'win32')) return process.cwd();
  return platform === 'win32' ? 'C:\\' : '/';
}

function prepareInput(input: string, platform: FilesystemPlatform): string {
  if (platform !== 'win32') {
    if (/^[A-Za-z]:[\\/]/.test(input)) {
      throw pathError('Windows drive paths are only valid on Windows', 'PATH_PLATFORM_MISMATCH');
    }
    return input;
  }
  const native = input.replace(/\//g, '\\');
  if (/^\\\\\.\\/.test(native)) throw pathError('Windows device paths are not supported', 'PATH_DEVICE_UNSUPPORTED');
  if (/^[A-Za-z]:($|[^\\])/.test(native)) {
    throw pathError('drive-relative Windows paths are not supported', 'PATH_DRIVE_RELATIVE');
  }
  if (/^\\\\\?\\UNC\\/i.test(native)) return `\\\\${native.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(native)) return native.slice(4);
  if (/^\\\\\?\\/.test(native) || /^\\(?:\?\?|GLOBALROOT)\\/i.test(native)) {
    throw pathError('unsupported Windows namespace path', 'PATH_NAMESPACE_UNSUPPORTED');
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
  if (typeof input !== 'string') throw pathError('path required', 'PATH_REQUIRED');
  const source = input.replace(/\\/g, '/');
  if (source.startsWith('/') || (platform === 'win32' && /^[A-Za-z]:/.test(source))) {
    throw pathError('path must be relative to the folder', 'PATH_NOT_RELATIVE');
  }
  const segments = source.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw pathError('invalid path segment', 'PATH_INVALID_SEGMENT');
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

function sameFilesystemEntry(a: string, b: string, includePaths = true): boolean {
  try {
    const aStat = fs.statSync(a);
    const bStat = fs.statSync(b);
    const same = aStat.dev === bStat.dev && aStat.ino === bStat.ino;
    if (includePaths) writeDiagnosticEvidence('path.same_entry', { a, b, a_device: aStat.dev, b_device: bStat.dev, a_inode: aStat.ino, b_inode: bStat.ino, same });
    return same;
  } catch (error) {
    recordPathCheckError('path.same_entry', includePaths ? { a, b, fallback: 'not_same' } : { purpose: 'volume_case_probe', paths: 'unrelated_entries_omitted', fallback: 'not_same' }, error);
    return false;
  }
}

function sameFilesystemAlias(a: string, b: string, includePaths = true): boolean {
  if (!sameFilesystemEntry(a, b, includePaths)) return false;
  try {
    const aReal = fs.realpathSync.native(a), bReal = fs.realpathSync.native(b);
    const same = aReal === bReal;
    if (includePaths) writeDiagnosticEvidence('path.same_alias', { a, b, a_realpath: aReal, b_realpath: bReal, same });
    return same;
  } catch (error) {
    recordPathCheckError('path.same_alias', includePaths ? { a, b, fallback: 'not_same' } : { purpose: 'volume_case_probe', paths: 'unrelated_entries_omitted', fallback: 'not_same' }, error);
    return false;
  }
}

function matchingExistingEntry(cursor: string, segment: string, verifyAlias: boolean): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(cursor);
  } catch (error) {
    recordPathCheckError('path.canonical_readdir', { path: cursor, syscall: 'readdir', fallback: 'caller_spelling' }, error);
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
    await observePathCheckAsync('path.exists', { path: target, syscall: 'access', mode: 'async', fallback_on_error: 'not_exists' }, () => fs.promises.access(target));
    return true;
  } catch {
    return false;
  }
}

async function sameFilesystemEntryAsync(a: string, b: string, includePaths = true): Promise<boolean> {
  try {
    const [aStat, bStat] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
    const same = aStat.dev === bStat.dev && aStat.ino === bStat.ino;
    if (includePaths) writeDiagnosticEvidence('path.same_entry', { a, b, a_device: aStat.dev, b_device: bStat.dev, a_inode: aStat.ino, b_inode: bStat.ino, same });
    return same;
  } catch (error) {
    recordPathCheckError('path.same_entry', includePaths ? { a, b, fallback: 'not_same' } : { purpose: 'volume_case_probe', paths: 'unrelated_entries_omitted', fallback: 'not_same' }, error);
    return false;
  }
}

async function sameFilesystemAliasAsync(a: string, b: string, includePaths = true): Promise<boolean> {
  if (!(await sameFilesystemEntryAsync(a, b, includePaths))) return false;
  try {
    const [aReal, bReal] = await Promise.all([
      includePaths ? realpathNativeAsync(a) : new Promise<string>((resolve, reject) => fs.realpath.native(a, (error, value) => error ? reject(error) : resolve(value))),
      includePaths ? realpathNativeAsync(b) : new Promise<string>((resolve, reject) => fs.realpath.native(b, (error, value) => error ? reject(error) : resolve(value))),
    ]);
    const same = aReal === bReal;
    if (includePaths) writeDiagnosticEvidence('path.same_alias', { a, b, a_realpath: aReal, b_realpath: bReal, same });
    return same;
  } catch (error) {
    recordPathCheckError('path.same_alias', includePaths ? { a, b, fallback: 'not_same' } : { purpose: 'volume_case_probe', paths: 'unrelated_entries_omitted', fallback: 'not_same' }, error);
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
  } catch (error) {
    recordPathCheckError('path.canonical_readdir', { path: cursor, syscall: 'readdir', fallback: 'caller_spelling' }, error);
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
