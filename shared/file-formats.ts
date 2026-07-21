/**
 * Cross-process file-extension vocabulary.
 *
 * Keep extension membership here so the Node server and renderer cannot drift
 * when a viewable/convertible format is added. Format-specific behavior and
 * MIME types still belong to their owning modules.
 */
export const MARKDOWN_NOTE_EXTENSIONS = ['md', 'markdown'] as const;
export const HTML_NOTE_EXTENSIONS = ['html', 'htm'] as const;
export const NOTE_EXTENSIONS = [...MARKDOWN_NOTE_EXTENSIONS, ...HTML_NOTE_EXTENSIONS] as const;
export const PDF_EXTENSIONS = ['pdf'] as const;
export const IMAGE_SOURCE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;
export const DOCX_EXTENSIONS = ['docx'] as const;
export const AUDIO_SOURCE_EXTENSIONS = [
  'mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus', 'aac', 'aiff', 'aif',
] as const;

export const CONVERTIBLE_SOURCE_EXTENSIONS = [
  ...PDF_EXTENSIONS,
  ...IMAGE_SOURCE_EXTENSIONS,
  ...DOCX_EXTENSIONS,
  ...AUDIO_SOURCE_EXTENSIONS,
] as const;

/** Formats that historically wrote hidden sibling derived notes inside the
 * user folder. Audio launched with AppData-only output and must never broaden
 * this compatibility-only hiding rule. */
export const LEGACY_DERIVED_SOURCE_EXTENSIONS = [
  ...PDF_EXTENSIONS,
  ...IMAGE_SOURCE_EXTENSIONS,
  ...DOCX_EXTENSIONS,
] as const;

export const VIEWABLE_FILE_EXTENSIONS = [
  ...NOTE_EXTENSIONS,
  ...CONVERTIBLE_SOURCE_EXTENSIONS,
] as const;

export const AUDIO_SOURCE_EXTENSION_ALTERNATION = extensionAlternation(AUDIO_SOURCE_EXTENSIONS);
export const PDF_EXTENSION_ALTERNATION = extensionAlternation(PDF_EXTENSIONS);
export const IMAGE_SOURCE_EXTENSION_ALTERNATION = extensionAlternation(IMAGE_SOURCE_EXTENSIONS);
export const DOCX_EXTENSION_ALTERNATION = extensionAlternation(DOCX_EXTENSIONS);
export const CONVERTIBLE_SOURCE_EXTENSION_ALTERNATION = extensionAlternation(CONVERTIBLE_SOURCE_EXTENSIONS);
export const LEGACY_DERIVED_SOURCE_EXTENSION_ALTERNATION = extensionAlternation(LEGACY_DERIVED_SOURCE_EXTENSIONS);
export const VIEWABLE_FILE_EXTENSION_ALTERNATION = extensionAlternation(VIEWABLE_FILE_EXTENSIONS);

function extensionAlternation(extensions: readonly string[]): string {
  return extensions.map(escapeRegExp).join('|');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
