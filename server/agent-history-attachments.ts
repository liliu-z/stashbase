import path from 'node:path';
import { VIEWABLE_FILE_EXTENSIONS } from '../shared/file-formats.ts';
import { AGENT_SESSION_QUOTE_MAX } from '../shared/protocols/http/agent-sessions.ts';
import { isTransientAttachmentPath, transientAttachmentPreviewUrl } from './routes/attach.ts';

export interface RestoredAttachment {
  path: string;
  name: string;
  /** Present only for a transient image restored as a thumbnail. A non-image
   * document card carries no preview URL — it displays a name and grants no
   * read access. */
  previewUrl?: string;
  /** The passage a `Selected passages:` entry quoted from this document. */
  quote?: string;
}

/** Rehydrate the generated `Attached files:` suffix into UI attachment data
 * when replaying either supported Agent runtime's persisted transcript, so a
 * file the user attached reads as ONE chip rather than a chip PLUS its raw
 * path leaking back into the shown message. Images become transient
 * thumbnails (transient-only, so an arbitrary image path never gains a preview
 * URL); every other transient upload becomes a plain name-only card. Known
 * project document paths retain their existing cards, while an arbitrary path
 * outside transient storage stays in the text untouched. A `Selected
 * passages:` block ahead of the suffix becomes quoted document cards. */
export function restoreHistoryAttachments(text: string): { text: string; attachments: RestoredAttachment[] } {
  const marker = '\n\nAttached files:\n';
  const offset = text.lastIndexOf(marker);
  if (offset < 0) return restorePassages(text);
  const before = text.slice(0, offset);
  const attachments: RestoredAttachment[] = [];
  const remaining = text.slice(offset + marker.length).split('\n').filter((line) => {
    if (!line.startsWith('- ')) return true;
    const attachment = historyAttachment(line.slice(2));
    if (!attachment) return true;
    attachments.push(attachment);
    return false;
  });
  const passages = restorePassages(before);
  return {
    text: remaining.length ? `${passages.text}${marker}${remaining.join('\n')}` : passages.text,
    attachments: [...passages.attachments, ...attachments],
  };
}

const PASSAGES_MARKER = 'Selected passages:\n';

/** Lift the `Selected passages:` block that ends `text` (it precedes any
 * `Attached files:` suffix) into quoted attachments. Each entry is a `- path`
 * line followed by its quote, one `  > ` line per quoted line and a bare
 * `  >` for a blank one. A block with any other line is prose someone typed
 * and stays whole; an entry whose path is not a known document, or whose
 * quote is too long to replay, stays in the prose on its own. */
function restorePassages(text: string): { text: string; attachments: RestoredAttachment[] } {
  const found = text.lastIndexOf(`\n\n${PASSAGES_MARKER}`);
  const offset = found < 0 && text.startsWith(PASSAGES_MARKER) ? 0 : found;
  if (offset < 0) return { text, attachments: [] };
  const head = offset === 0 ? 0 : offset + 2;
  const entries: Array<{ path: string; lines: string[]; quote: string[] }> = [];
  for (const line of text.slice(head + PASSAGES_MARKER.length).replace(/\n+$/u, '').split('\n')) {
    const entry = entries.at(-1);
    if (line.startsWith('- ')) entries.push({ path: line.slice(2).trim(), lines: [line], quote: [] });
    else if (entry && (line === '  >' || line.startsWith('  > '))) {
      entry.lines.push(line);
      entry.quote.push(line.slice(4));
    } else return { text, attachments: [] };
  }
  const passages: RestoredAttachment[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    const quote = entry.quote.join('\n');
    if (quote && quote.length <= AGENT_SESSION_QUOTE_MAX && isKnownDocument(entry.path))
      passages.push({ path: entry.path, name: path.basename(entry.path), quote });
    else kept.push(...entry.lines);
  }
  const before = text.slice(0, offset);
  return {
    text: kept.length ? `${text.slice(0, head)}${PASSAGES_MARKER}${kept.join('\n')}` : before,
    attachments: passages,
  };
}

/** Classify one `- ` line of the attachment suffix. A derived-file line carries
 * a trailing `(for text context, …)` hint after the path, so read the path up
 * to that. Returns null for a line we should leave in the prose. */
function historyAttachment(rest: string): RestoredAttachment | null {
  const cut = rest.indexOf(' (');
  const candidate = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
  if (!candidate) return null;
  // Images are preview-capable and therefore require the stronger transient
  // path check before any broader document-card classification.
  if (isPreviewableImage(candidate)) return historyImageAttachment(candidate);
  if (isTransientAttachmentPath(candidate)) {
    return { path: candidate, name: path.basename(candidate) };
  }
  if (isKnownDocument(candidate)) return { path: candidate, name: path.basename(candidate) };
  return null;
}

/** Build a preview only for an image written by StashBase's transient upload
 * route. Transcript text must never grant read access to arbitrary paths. */
export function historyImageAttachment(candidate: string): RestoredAttachment | null {
  if (!isTransientAttachmentPath(candidate) || !isPreviewableImage(candidate)) return null;
  return {
    path: candidate,
    name: path.basename(candidate),
    previewUrl: transientAttachmentPreviewUrl(candidate),
  };
}

function isPreviewableImage(filePath: string): boolean {
  return ['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp'].includes(path.extname(filePath).toLowerCase());
}

/** A non-image file whose extension is in the app's known viewable/attachable
 * vocabulary. Restricting to known types keeps an extension-less or unknown
 * path (e.g. `/etc/passwd`) in the prose instead of lifting it into a card —
 * a card grants no read access regardless, but a genuine attachment always
 * carries a recognised extension. */
function isKnownDocument(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return ext.length > 0 && (VIEWABLE_FILE_EXTENSIONS as readonly string[]).includes(ext);
}
