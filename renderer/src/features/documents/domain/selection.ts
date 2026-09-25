import type { SourceReference } from '@/shared/domain/source-reference';

/** The passage a reader selected in one source, as Markdown in the spelling
 *  of the editor that shows it. */
export interface DocumentSelection {
  source: SourceReference;
  markdown: string;
}
