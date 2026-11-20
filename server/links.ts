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
 *   - Each path segment is percent-decoded before matching, as the reader
 *     resolves links (`renderer/src/features/documents/domain/link-target.ts`),
 *     so `My%20Note.md` names `My Note.md`. A rewritten path encodes only the
 *     characters that would otherwise break or change the link (spaces, `%`,
 *     `?`, `#`, and the format's own delimiters); other text, including
 *     non-ASCII names, stays as written.
 */
import path from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { decodeHTMLAttribute } from 'entities';
import { Parser } from 'htmlparser2';
import { decodeString } from 'micromark-util-decode-string';
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
  /** Destination after markup escapes/entities, before URL percent decoding. */
  target: string;
  /** Full markup span, confirmed against CommonMark for Markdown links. */
  markupStart: number;
  markupEnd: number;
  /** How the destination was written, which decides how a rewrite encodes it. */
  style: LinkStyle;
}

/** `md-angle` is a Markdown `<destination>`: spaces are literal there, but
 *  `<`, `>` and line breaks are not. */
type LinkStyle = 'md' | 'md-angle' | 'html';

/** Match every `[text](url)` and `![alt](url)` and emit the URL span.
 *  The destination is either `<...>` (group 1) or a bare run that may hold
 *  one level of balanced parentheses, as CommonMark allows (group 2). The
 *  optional title may be `"..."`, `'...'` or `(...)` and is preserved by only
 *  capturing the URL portion. Nested brackets in the text part are tolerated
 *  one level deep — good enough for hand-written docs. */
const MD_LINK =
  /!?\[(?:[^\[\]]|\[[^\[\]]*\])*\]\([ \t]*(?:<([^<>\n]*)>|((?:[^\s()<]|\([^\s()]*\))(?:[^\s()]|\([^\s()]*\))*))(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*\)/gd;

function extractMdLinks(content: string): LinkMatch[] {
  // CommonMark owns recognition: escaped prose and literal examples are
  // not links. The matcher below only locates destinations in supported forms.
  const targets = new Map<string, string>();
  type MarkdownTree = ReturnType<typeof fromMarkdown>;
  function collect(node: MarkdownTree | MarkdownTree['children'][number]): void {
    if (node.type === 'link' || node.type === 'image') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) targets.set(`${start}:${end}`, node.url);
    }
    if ('children' in node) {
      for (const child of node.children) collect(child);
    }
  }
  collect(fromMarkdown(content));
  return hrefMatches(content, MD_LINK, ['md-angle', 'md']).flatMap((match) => {
    const target = targets.get(`${match.markupStart}:${match.markupEnd}`);
    return target === undefined ? [] : [{ ...match, target }];
  });
}

/** HTML owns tag/attribute recognition, so comments, scripts, data-href and
 * duplicate attributes cannot masquerade as the anchor's actual destination.
 * Keep source offsets: parsing never reserializes the user's HTML. */
function extractHtmlLinks(content: string): LinkMatch[] {
  const links: LinkMatch[] = [];
  let anchor = false;
  let hrefSeen = false;
  const parser = new Parser({
    onopentagname(name) {
      anchor = name === 'a';
      hrefSeen = false;
    },
    onattribute(name, target, quote) {
      if (!anchor || name !== 'href' || hrefSeen) return;
      hrefSeen = true;
      if (quote !== '"' && quote !== "'") return;
      const raw = content.slice(parser.startIndex, parser.endIndex);
      const opening = raw.indexOf(quote, raw.indexOf('=') + 1);
      if (opening < 0 || !raw.endsWith(quote)) return;
      const start = parser.startIndex + opening + 1;
      const end = parser.endIndex - 1;
      links.push({
        start, end, href: content.slice(start, end), target, style: 'html',
        markupStart: parser.startIndex, markupEnd: parser.endIndex,
      });
    },
  }, { decodeEntities: true });
  parser.end(content);
  return links;
}

/** Each listed capture group is one alternative form of the href; `d` gives
 *  its offsets, and the style at the same position records which form matched. */
function hrefMatches(content: string, re: RegExp, styles: LinkStyle[]): LinkMatch[] {
  const out: LinkMatch[] = [];
  for (const m of content.matchAll(re)) {
    styles.some((style, index) => {
      const span = m.indices?.[index + 1];
      if (!span) return false;
      out.push({
        start: span[0], end: span[1], href: m[index + 1], target: m[index + 1], style,
        markupStart: m.index, markupEnd: m.index + m[0].length,
      });
      return true;
    });
  }
  return out;
}

/** Percent-decode each `/`-separated segment the way the reader does. A
 *  segment that is not valid percent-encoding is kept as written (a name may
 *  contain a bare `%`). Returns null when decoding would produce a separator
 *  or a dot segment, which the reader refuses to treat as a project link. */
function decodeLinkPath(pathPart: string): string | null {
  const segments: string[] = [];
  for (const raw of pathPart.split('/')) {
    let segment = raw;
    try { segment = decodeURIComponent(raw); } catch { /* keep the literal segment */ }
    if (segment !== raw && (/[\\/]/.test(segment) || segment === '.' || segment === '..')) return null;
    segments.push(segment);
  }
  return segments.join('/');
}

/** Markdown destinations end at whitespace or `)` and treat `<`/`>` as
 *  delimiters; HTML attributes end at their quote. `%`, `?` and `#` would be
 *  read back as an escape, a query or an anchor in either format. */
const LINK_UNSAFE: Record<LinkStyle, RegExp> = {
  md: /[%?&#\s()<>]/gu,
  'md-angle': /[%?&#<>\n\r]/gu,
  html: /[%?&#\s"'<>]/gu,
};

function encodeLinkPath(name: string, style: LinkStyle): string {
  // encodeURIComponent leaves `(`, `)` and `'` as they are, so ASCII is
  // escaped by hand; Unicode whitespace still takes its UTF-8 escape.
  return name.replace(LINK_UNSAFE[style], (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x80 ? `%${code.toString(16).toUpperCase().padStart(2, '0')}` : encodeURIComponent(ch);
  });
}

/** Split a markup-decoded href into its folder-relative path target and any
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
  const decoded = decodeLinkPath(pathPart);
  if (decoded === null) return null;
  pathPart = decoded;

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

/** Keep the original suffix bytes after resolving its markup semantics. A
 * delimiter may itself be an entity or Markdown escape, so find the raw tail
 * whose decoded spelling is the resolved suffix rather than cutting at `#`
 * inside a numeric entity. Never guess when a suffix cannot be retained. */
function originalSuffix(href: string, suffix: string, style: LinkStyle): string | null {
  if (!suffix || href.endsWith(suffix)) return suffix;
  const decode = style === 'html' ? decodeHTMLAttribute : decodeString;
  for (const match of href.matchAll(/[?#&\\]/g)) {
    const candidate = href.slice(match.index);
    if (decode(candidate) === suffix) return candidate;
  }
  return null;
}

/** Decide what the link href should become after the rename. Returns
 *  `null` when the link is untouchable (external, broken, etc.) or
 *  doesn't need rewriting. */
function rewriteOneHref(
  href: string,
  target: string,
  fromDir: string,
  toDir: string,
  renames: RenameEntry[],
  style: LinkStyle,
): string | null {
  const resolved = resolveLink(target, fromDir);
  if (!resolved) return null;
  const newTarget = applyRenameForward(resolved.path, renames);
  // If nothing about the target changed AND the source file didn't
  // move, the relative href is still correct.
  if (newTarget === resolved.path && fromDir === toDir) return null;
  const newPath = toDir
    ? (posix.relative(toDir, newTarget) || '.')
    : newTarget;
  const suffix = originalSuffix(href, resolved.suffix, style);
  if (suffix === null) return null;
  const newHref = encodeLinkPath(newPath, style) + suffix;
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
    const newHref = rewriteOneHref(m.href, m.target, fromDir, toDir, renames, m.style);
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
