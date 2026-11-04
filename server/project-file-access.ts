import { assertProjectPath, assertProjectScope } from './project-request-scope.ts';
import { errorMessage } from './log.ts';
import {
  exactRegisteredFolderRootAsync,
  registeredRootForAbsAsync,
  resolveFolderRootAsync,
} from './folder.ts';
import { filesystemPath } from './filesystem-path.ts';
import { normalizeFolderRelativePath } from './folder-relative-path.ts';
import { isDerivedNoteName } from './format.ts';
import { projectOperationError } from './project-operations/errors.ts';
import { unsupportedTextControl } from './text-decoding.ts';
import { escapeDiagnosticPath, writeDiagnosticEvidence, writeDiagnosticStep } from './write-diagnostic-context.ts';

export type { AgentContextFile } from '../shared/project-files.ts';

export interface ProjectSearchScope {
  /** Absolute root of the one Folder this query may search. */
  folderRoot: string;
  /** Absolute path prefix to narrow to, or undefined. */
  pathPrefix?: string;
}
export async function requireMemberFolderRoot(ref: string): Promise<string> {
  if (!filesystemPath.isAbsolute(ref)) throw routeError('folder must be absolute', 400, 'PATH_NOT_ABSOLUTE');
  const root = await resolveFolderRootAsync(ref);
  const memberRoot = await exactRegisteredFolderRootAsync(root);
  if (!memberRoot) {
    throw routeError('folder is not in your folders', 404, 'FOLDER_NOT_FOUND');
  }
  assertProjectScope(memberRoot);
  return memberRoot;
}

export async function normalizeProjectSearchScope(folderRaw: unknown, pathPrefixRaw: unknown): Promise<ProjectSearchScope> {
  const folderRef = typeof folderRaw === 'string' && folderRaw.trim() ? folderRaw : undefined;
  if (!folderRef) {
    throw routeError('search requires one folder from list_projects', 400, 'FOLDER_REQUIRED');
  }
  const folderRoot = await requireMemberFolderRoot(folderRef);
  const pathPrefix = typeof pathPrefixRaw === 'string' && pathPrefixRaw.trim()
    ? await normalizeProjectPathPrefix(pathPrefixRaw)
    : undefined;
  // A prefix outside the requested folder would be dropped downstream and
  // silently widen the search to the whole folder — reject the pair instead.
  if (pathPrefix && await filesystemPath.relativeAsync(folderRoot, pathPrefix) == null) {
    throw routeError('path_prefix must live under folder', 400, 'PROJECT_PATH_OUTSIDE');
  }
  return { folderRoot, pathPrefix };
}

export async function requireProjectStatusFolder(folderRaw: unknown): Promise<string> {
  return (await normalizeProjectSearchScope(folderRaw, undefined)).folderRoot;
}

async function normalizeProjectPathPrefix(value: string): Promise<string> {
  // Resolve to an absolute prefix and require it to live under a member folder.
  // Only explicit absolute paths are accepted.
  const requestedAbs = resolveProjectAbs(value);
  const folderRoot = await registeredRootForAbsAsync(requestedAbs);
  if (!folderRoot) {
    throw routeError('path_prefix must live under one of your folders', 400, 'PROJECT_PATH_OUTSIDE');
  }
  assertProjectPath(requestedAbs);
  const requestedRel = await filesystemPath.relativeAsync(folderRoot, requestedAbs);
  if (requestedRel == null) throw routeError('path_prefix must live under one of your folders', 400, 'PROJECT_PATH_OUTSIDE');
  return filesystemPath.join(folderRoot, await filesystemPath.canonicalRelativeAsync(folderRoot, requestedRel));
}

export interface ProjectPath {
  /** Absolute POSIX source spelling exposed through MCP and passed to workers. */
  abs: string;
  /** Absolute root of the member folder that contains it. */
  folderRoot: string;
  /** Path within that folder (`docs/note.md`). */
  folderRel: string;
}

export interface ProjectDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  format?: string;
  size?: number;
  version?: string;
}

/** Resolve a raw native or POSIX-spelled path to an absolute POSIX path,
 *  rejecting relative paths, traversal, and control characters.
 *  Does NOT check membership; callers do via `registeredRootForAbs`. */
export function resolveProjectAbs(raw: unknown): string {
  return writeDiagnosticStep('path_resolution', 'project_path.resolve_absolute', () => {
    const value = typeof raw === 'string' ? raw : '';
    writeDiagnosticEvidence('project_path.input', {
      raw_path: typeof raw === 'string' ? raw : null,
      escaped_path: typeof raw === 'string' ? escapeDiagnosticPath(raw) : null,
      input_type: typeof raw,
      platform: filesystemPath.platform,
    });
    if (!value.trim()) throw routeError('path required', 400, 'PATH_REQUIRED');
    if (/[\x00-\x1f]/.test(value)) throw routeError('path contains invalid characters', 400, 'PATH_INVALID_CHARACTERS');
    for (const seg of value.replace(/\\/g, '/').split('/')) {
      if (seg === '.' || seg === '..') throw routeError('path contains an invalid segment', 400, 'PATH_INVALID_SEGMENT');
    }
    if (!filesystemPath.isAbsolute(value)) throw routeError('path must be absolute', 400, 'PATH_NOT_ABSOLUTE');
    const normalized = filesystemPath.absolute(value);
    writeDiagnosticEvidence('project_path.absolute', { normalized_path: normalized });
    return normalized;
  });
}

export async function normalizeProjectFilePath(raw: unknown): Promise<ProjectPath> {
  const requestedAbs = resolveProjectAbs(raw);
  const folderRoot = await requireRegisteredRootForPath(requestedAbs);
  assertProjectPath(requestedAbs);
  return writeDiagnosticStep('path_resolution', 'project_path.resolve_file', async () => {
    const requestedRel = await filesystemPath.relativeAsync(folderRoot, requestedAbs);
    const folderRel = requestedRel == null
      ? null
      : await filesystemPath.canonicalRelativeAsync(folderRoot, requestedRel);
    if (folderRel == null || folderRel === '') {
      throw routeError('path must include a file path, not just the folder root', 400, 'FILE_PATH_REQUIRED');
    }
    if (isDerivedNoteName(folderRel)) {
      throw routeError('app-maintained derived notes are hidden; use the visible source file path', 403, 'DERIVED_NOTE_HIDDEN');
    }
    const abs = filesystemPath.join(folderRoot, folderRel);
    writeDiagnosticEvidence('project_path.resolved', { requested_path: requestedAbs, target_path: abs, folder_root: folderRoot, folder_relative: folderRel });
    return { abs, folderRoot, folderRel };
  });
}

function requireRegisteredRootForPath(requestedAbs: string): Promise<string> {
  return writeDiagnosticStep('project_match', 'project_path.require_registered_root', async () => {
    const folderRoot = await registeredRootForAbsAsync(requestedAbs);
    if (!folderRoot) {
      throw routeError('path must live under one of your folders (call list_projects to list them)', 400, 'PROJECT_PATH_OUTSIDE');
    }
    return folderRoot;
  });
}

export async function normalizeProjectDirectoryPath(
  raw: unknown,
): Promise<{ abs: string; folderRoot: string; folderRel: string }> {
  const requestedAbs = resolveProjectAbs(raw);
  const folderRoot = await requireRegisteredRootForPath(requestedAbs);
  assertProjectPath(requestedAbs);
  const requestedRel = await filesystemPath.relativeAsync(folderRoot, requestedAbs);
  const folderRel = requestedRel == null
    ? null
    : await filesystemPath.canonicalRelativeAsync(folderRoot, requestedRel);
  if (folderRel == null) throw routeError('path must live under one of your folders', 400, 'PROJECT_PATH_OUTSIDE');
  return { abs: filesystemPath.join(folderRoot, folderRel), folderRoot, folderRel };
}

/** Agent/file-tool writes are transport-independent text. C0 controls other
 * than normal text whitespace almost always mean a caller constructed Markdown
 * or LaTeX in an interpreted string literal (for example, `\frac` became form
 * feed + `rac`). Refuse the mutation instead of silently corrupting user data.
 */
export function validateProjectTextMutation(content: string): void {
  if (/[\uD800-\uDFFF]/u.test(content)) {
    throw routeError('content contains an unpaired Unicode surrogate and cannot round-trip as UTF-8; no file was changed', 400, 'INVALID_TEXT_CONTENT');
  }
  const control = unsupportedTextControl(content);
  if (control === undefined) return;
  const codePoint = control.codePointAt(0) ?? 0;
  const printable = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  throw routeError(
    `content contains unsupported control character ${printable}. ` +
    'This commonly happens when Markdown or LaTeX backslashes are interpreted by a JavaScript string. ' +
    'Construct the value with String.raw or escape each backslash; no file was changed.',
    400,
    'INVALID_TEXT_CONTENT',
  );
}

export function validateProjectWritableFolderRel(folderRel: string): void {
  try {
    normalizeFolderRelativePath(folderRel, { writable: true, allowQuotes: true });
  } catch (err: unknown) {
    throw routeError(errorMessage(err), 400, 'INVALID_FILE_WRITE');
  }
}

export function routeError(message: string, status = 400, code?: string): Error {
  return projectOperationError(message, status, code);
}
