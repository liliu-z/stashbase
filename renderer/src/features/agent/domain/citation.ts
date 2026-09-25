/**
 * A reply's link to a passage in a project file.
 *
 * The Agent is asked to cite with a text fragment, `path#:~:text=phrase`, the
 * browser's own syntax for "scroll to this text". A line number would drift
 * with every edit the Agent itself makes; a phrase survives them, and the
 * document's Find locates it. Anything else after the path is dropped, so a
 * plain file link still opens its file.
 */

/** The longest phrase handed to Find; a citation names a spot, not a page. */
const CITED_PHRASE_LIMIT = 300;

export interface CitationHref {
  /** The decoded path before any `?` or `#`. */
  path: string;
  /** The phrase to locate, or null to open the file at the top. */
  phrase: string | null;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Markdown the Agent may have copied with the words, which the rendered
 *  document does not show: emphasis and code marks, and link syntax. */
function visibleText(phrase: string): string {
  return phrase
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/(\*\*|__|[*`])/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The `start` of a `text=[prefix-,]start[,end][,-suffix]` directive. Its
 *  parts are split before decoding, since an encoded comma belongs to one. */
function directiveStart(fragment: string): string | null {
  const directives = fragment.split(':~:')[1]?.split('&') ?? [];
  const directive = directives.find((part) => part.startsWith('text='))?.slice('text='.length);
  if (!directive) return null;
  const parts = directive.split(',');
  const start = parts.find((part, index) =>
    index === 0 ? !part.endsWith('-') : !part.startsWith('-'),
  );
  if (!start) return null;
  const decoded = decode(start);
  if (decoded === null) return null;
  const phrase = visibleText(decoded).slice(0, CITED_PHRASE_LIMIT).trim();
  return phrase || null;
}

/** Splits a local link into its path and cited phrase. Null for a malformed
 *  path, which the transcript leaves as text. */
export function parseCitationHref(href: string): CitationHref | null {
  const hash = href.indexOf('#');
  const beforeHash = hash < 0 ? href : href.slice(0, hash);
  const path = decode(beforeHash.split('?')[0] ?? '');
  if (path === null) return null;
  return { path, phrase: hash < 0 ? null : directiveStart(href.slice(hash + 1)) };
}
