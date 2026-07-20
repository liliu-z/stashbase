/**
 * Keep Markdown serialization choices owned by the source file. CodeMirror
 * represents line breaks as LF internally, so an edited CRLF document needs
 * its original convention restored at the filesystem boundary.
 */
export function preserveMarkdownSourceFormat(previous: string, next: string): string {
  const hasBom = previous.startsWith('\uFEFF');
  const content = next.startsWith('\uFEFF') ? next.slice(1) : next;
  const lineEnding = dominantLineEnding(previous);
  const serialized = lineEnding
    ? content.replace(/\r\n|\r|\n/g, lineEnding)
    : content;
  return (hasBom ? '\uFEFF' : '') + serialized;
}

function dominantLineEnding(content: string): '\n' | '\r\n' | null {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf === 0 && lf === 0) return null;
  return crlf > lf ? '\r\n' : '\n';
}
