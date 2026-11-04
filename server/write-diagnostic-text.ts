import { isWriteDiagnosticActive } from './write-diagnostic-context.ts';

/** Structural evidence only: never include the source or replacement text. */
export function writeDiagnosticTextMetrics(text: string): Record<string, number | boolean> {
  if (!isWriteDiagnosticActive()) return {};
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\r') {
      if (text[index + 1] === '\n') { crlf++; index++; }
      else cr++;
    } else if (text[index] === '\n') lf++;
  }
  return {
    utf16_length: text.length,
    utf8_bytes: Buffer.byteLength(text, 'utf8'),
    crlf_count: crlf,
    lone_lf_count: lf,
    lone_cr_count: cr,
    has_bom: text.startsWith('\uFEFF'),
    is_nfc: text.normalize('NFC') === text,
    is_nfd: text.normalize('NFD') === text,
  };
}
