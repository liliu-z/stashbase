/**
 * Cross-reference link maintenance: when a file or folder is renamed
 * or moved, walk every other note in the folder and rewrite any link
 * that resolves to the moved item so it still points at the right
 * place. Also handles re-relativising links inside the moved file
 * itself when its parent depth changed.
 *
 * The async planner captures source versions before rename; apply and rollback
 * share the normal save transaction and refuse newer source content.
 *
 * Scope:
 *   - Markdown `[text](url)` and `![alt](url)`.
 *   - HTML `<a href="...">`.
 *
 * Out of scope (left untouched):
 *   - `<img src>`, `<script src>`, `<link href>` (CSS/font/image refs
 *     resolve against the file's own `<stem>_files/` bundle, which
 *     moves with the note via `renameOnDiskAsync`).
 *   - Reference-style markdown links (`[text][id]` + `[id]: url`).
 *     Possible follow-up; project-style docs rarely use this form.
 *   - External URLs, `mailto:`, fragment-only `#anchor`.
 *
 * Path semantics:
 *   - Hrefs starting with `/` are treated as folder-root absolute
 *     (after stripping the leading slash). Anything that resolves
 *     outside the folder root is skipped.
 *   - `?query` and `#anchor` suffixes are preserved verbatim.
 */
import path from 'node:path';
import { detectFormat } from './format.ts';
import { listFilesAsync } from './file-listing.ts';
import { logger, errorMessage } from './log.ts';
import { fileChanged, readTextSnapshotAsync, replaceTextSnapshotAsync, textVersion, withTextFileTransaction } from './text-file-transaction.ts';

const log = logger('links');

const { posix } = path;

export interface RenameEntry {
  /** `file`: exact path match only. `folder`: also matches paths under `old/`. */
  kind: 'file' | 'folder';
  /** Pre-rename folder-relative POSIX path. */
  old: string;
  /** Post-rename folder-relative POSIX path. */
  new: string;
}

export interface CascadeResult {
  /** Files whose contents were rewritten + saved to disk. Caller is
   *  responsible for re-indexing — `indexer.upsertFile` per entry, or
   *  bundled into whatever follow-up sync the route runs. */
  updated: Array<{ name: string; changes: number }>;
  /** Files that failed to read / write. */
  failed: Array<{ name: string; error: string }>;
}

export interface AppliedRenamePlanAsync extends CascadeResult {
  rollback: () => Promise<void>;
}

export interface PlanEntry {
  /** Path BEFORE the rename. Used to read the source from disk. */
  fromName: string;
  /** Path AFTER the rename. The plan writer saves to this location. */
  toName: string;
  /** Rewritten body. */
  newContent: string;
  /** Exact bytes used to prepare this rewrite. */
  baseVersion: string;
  /** Number of `<a>` hrefs that changed. */
  changes: number;
}

interface LinkMatch {
  /** Inclusive start index of the URL portion within the original content. */
  start: number;
  /** Exclusive end index. */
  end: number;
  /** The raw href text. */
  href: string;
}

/** Match every `[text](url)` and `![alt](url)` and emit the URL span.
 *  Title (`[..](url "title")`) is preserved by only capturing the
 *  URL portion. Nested brackets in the text part are tolerated one
 *  level deep — good enough for hand-written docs. */
function extractMdLinks(content: string): LinkMatch[] {
  return hrefMatches(content, /(!?\[(?:[^\[\]]|\[[^\[\]]*\])*\])\(([^)\s]+?)((?:\s+"[^"]*")?)\)/gd);
}

/** Match every `<a ... href="..." ...>`. Quotes can be `"` or `'`. */
function extractHtmlLinks(content: string): LinkMatch[] {
  return hrefMatches(content, /<a\b[^>]*?\bhref\s*=\s*(["'])([^"']*)\1/gid);
}

/** Every match's second capture group is the href; `d` gives its offsets. */
function hrefMatches(content: string, re: RegExp): LinkMatch[] {
  const out: LinkMatch[] = [];
  for (const m of content.matchAll(re)) {
    const span = m.indices?.[2];
    if (span) out.push({ start: span[0], end: span[1], href: m[2] });
  }
  return out;
}

/** Split a raw href into its folder-relative path target and any
 *  `?query` / `#anchor` tail. Returns null for external URLs,
 *  anchor-only links, or anything that escapes the folder root. */
function resolveLink(href: string, fileDir: string): { path: string; suffix: string } | null {
  if (!href || href.startsWith('#')) return null;
  // Any explicit scheme — http(s), mailto, data, file, ...
  if (/^[a-z][a-z0-9+.\-]*:/i.test(href)) return null;
  // Protocol-relative links (`//example.com/x`) are external too.
  if (href.startsWith('//')) return null;

  let pathPart = href;
  let suffix = '';
  const hashIdx = pathPart.indexOf('#');
  const queryIdx = pathPart.indexOf('?');
  const cuts: number[] = [];
  if (hashIdx >= 0) cuts.push(hashIdx);
  if (queryIdx >= 0) cuts.push(queryIdx);
  if (cuts.length) {
    const cut = Math.min(...cuts);
    suffix = pathPart.slice(cut);
    pathPart = pathPart.slice(0, cut);
  }
  if (!pathPart) return null;

  let resolved: string;
  if (pathPart.startsWith('/')) {
    resolved = pathPart.slice(1);
  } else {
    resolved = posix.normalize(posix.join(fileDir, pathPart));
  }
  resolved = resolved.replace(/^\/+/, '').replace(/\/+$/, '');
  if (resolved === '..' || resolved.startsWith('../') || resolved === '.') return null;

  return { path: resolved, suffix };
}

/** Forward-map a path through the rename mapping (current → future). */
function applyRenameForward(name: string, renames: RenameEntry[]): string {
  for (const r of renames) {
    if (r.kind === 'file') {
      if (name === r.old) return r.new;
    } else {
      if (name === r.old) return r.new;
      if (name.startsWith(r.old + '/')) return r.new + name.slice(r.old.length);
    }
  }
  return name;
}

/** Decide what the link href should become after the rename. Returns
 *  `null` when the link is untouchable (external, broken, etc.) or
 *  doesn't need rewriting. */
function rewriteOneHref(
  href: string,
  fromDir: string,
  toDir: string,
  renames: RenameEntry[],
): string | null {
  const resolved = resolveLink(href, fromDir);
  if (!resolved) return null;
  const newTarget = applyRenameForward(resolved.path, renames);
  // If nothing about the target changed AND the source file didn't
  // move, the relative href is still correct.
  if (newTarget === resolved.path && fromDir === toDir) return null;
  const newPath = toDir
    ? (posix.relative(toDir, newTarget) || '.')
    : newTarget;
  const newHref = newPath + resolved.suffix;
  return newHref === href ? null : newHref;
}

/** Pure-string rewrite of every `<a>` / `[..]` href in `content`,
 *  re-relativised from `fromDir` to `toDir` and remapped through
 *  `renames`. Used both during cascade and exposed for tests. */
function rewriteLinks(opts: {
  content: string;
  format: 'md' | 'html';
  fromDir: string;
  toDir: string;
  renames: RenameEntry[];
}): { content: string; changes: number } {
  const { content, format, fromDir, toDir, renames } = opts;
  const matches = format === 'md' ? extractMdLinks(content) : extractHtmlLinks(content);
  if (matches.length === 0) return { content, changes: 0 };

  let changes = 0;
  let result = content;
  // Splice from the back so earlier offsets stay valid.
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const newHref = rewriteOneHref(m.href, fromDir, toDir, renames);
    if (newHref == null) continue;
    result = result.slice(0, m.start) + newHref + result.slice(m.end);
    changes++;
  }
  return { content: result, changes };
}

function dirOf(name: string): string {
  const d = posix.dirname(name);
  return d === '.' ? '' : d;
}

export async function planRenameLinksAsync(renames: RenameEntry[]): Promise<PlanEntry[]> {
  if (renames.length === 0) return [];
  const out: PlanEntry[] = [];
  for (const file of await listFilesAsync()) {
    const format = detectFormat(file.name);
    if (format !== 'md' && format !== 'html') continue;
    const snapshot = await readTextSnapshotAsync(file.name);
    if (!snapshot) continue;
    const { content } = snapshot;
    const fromName = file.name;
    const toName = applyRenameForward(fromName, renames);
    const rewritten = rewriteLinks({
      content,
      format,
      fromDir: dirOf(fromName),
      toDir: dirOf(toName),
      renames,
    });
    if (rewritten.changes === 0) continue;
    out.push({ fromName, toName, newContent: rewritten.content, changes: rewritten.changes, baseVersion: snapshot.version });
  }
  return out;
}

export async function applyRenamePlanAsync(plan: PlanEntry[]): Promise<AppliedRenamePlanAsync> {
  const updated: CascadeResult['updated'] = [];
  const failed: CascadeResult['failed'] = [];
  const originals: Array<{ name: string; content: string; writtenVersion: string }> = [];
  for (const entry of plan) {
    try {
      await withTextFileTransaction(entry.toName, async () => {
        const original = await readTextSnapshotAsync(entry.toName);
        if (!original || original.version !== entry.baseVersion) throw fileChanged(original?.version ?? null);
        await replaceTextSnapshotAsync(entry.toName, entry.newContent, original.version);
        originals.push({ name: entry.toName, content: original.content, writtenVersion: textVersion(entry.newContent) });
        updated.push({ name: entry.toName, changes: entry.changes });
      });
    } catch (err: unknown) {
      failed.push({ name: entry.toName, error: errorMessage(err) });
    }
  }
  return {
    updated,
    failed,
    rollback: async () => {
      for (const original of [...originals].reverse()) {
        try {
          await withTextFileTransaction(original.name, () =>
            replaceTextSnapshotAsync(original.name, original.content, original.writtenVersion));
        } catch (err: unknown) {
          log.error(`failed to roll back link rewrite in ${original.name}:`, err);
        }
      }
    },
  };
}
