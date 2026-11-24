/** Prepare explicit transient attachments for the bundled model runtime.
 * Upload ownership stays in the attachment store; no prompt prose grants access.
 * Preparation never imports a project source or starts indexing. */
import path from 'node:path';
import type { FilePartInput } from '@opencode-ai/sdk';
import { readSubmittedAttachment } from './routes/attach.ts';
import { extractDocxInWorker } from './docx.ts';
import { analyzeHtml } from './html.ts';

const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 200_000;

function mediaType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return null;
}

export async function prepareAgentAttachments(
  paths: readonly string[], folder: string, signal: AbortSignal,
): Promise<FilePartInput[]> {
  if (paths.length > 10) throw new Error('The StashBase Agent accepts up to 10 attachments per message.');
  const parts: FilePartInput[] = [];
  let total = 0;
  let textLength = 0;
  for (const reference of paths) {
    signal.throwIfAborted();
    const bytes = await readSubmittedAttachment(reference, folder, signal);
    signal.throwIfAborted();
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('The StashBase Agent accepts up to 8 MiB of attachments per message.');
    const filename = path.basename(reference);
    if (!bytes.length) throw new Error(`${filename} is empty. Choose a file with content.`);
    let mime = mediaType(bytes);
    let content = bytes;
    if (!mime) {
      let text: string;
      if (/\.docx$/i.test(filename)) {
        const result = await extractDocxInWorker(bytes, signal);
        text = `Extracted text from ${filename} (embedded images and page layout are not included):\n\n${analyzeHtml(result.html).plaintext}`;
      } else {
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (/[\x00-\x08\x0e-\x1f]/u.test(text) || /\.(?:png|jpe?g|gif|webp|pdf)$/i.test(filename)) throw new Error('binary');
        } catch {
          throw new Error(`${filename}: The StashBase Agent supports UTF-8 text, PNG, JPEG, GIF, WebP, PDF, and DOCX attachments.`);
        }
      }
      signal.throwIfAborted();
      textLength += text.length;
      if (textLength > MAX_TEXT_CHARACTERS) throw new Error('Attachment text exceeds 200,000 characters. Attach a smaller excerpt.');
      content = Buffer.from(text);
      mime = 'text/plain';
    }
    parts.push({ source: { type: 'file', path: reference, text: { value: filename, start: 0, end: filename.length } }, type: 'file', mime, filename, url: `data:${mime};base64,${content.toString('base64')}` });
  }
  return parts;
}
