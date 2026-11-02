/**
 * What the composer shows beside the draft's text: which bound items take a
 * tile, and which current document accompanies the next request.
 */
import { isRetrievableViewerFormat, viewerFormatOfPath } from '@/contracts/file-formats';
import type {
  AgentContextItem,
  AgentScopeEnvironment,
  ContextValidation,
} from '@/features/agent/domain/context';
import { isExternalSource } from '@/shared/domain/external-source';
import type { SourceReference } from '@/shared/domain/source-reference';

/** Whether a bound item shows as a tile beside the draft rather than as an
 *  inline mention. A source earns one only while the text does not mention
 *  it; a passage is never a mention; an upload is the composer's own
 *  thumbnail unless it went stale. */
export function isDraftTile(
  validation: ContextValidation,
  mentioned: ReadonlySet<string>,
): boolean {
  switch (validation.item.kind) {
    case 'transient':
      return validation.status === 'stale';
    case 'passage':
      return true;
    case 'source':
      return !mentioned.has(validation.item.source.path);
  }
}

/** The current document to include with the next request: listed in the
 *  chat's folder, or an external file the reader dropped beside it; readable
 *  as text and not already bound. Null when there is nothing to include. */
export function currentContextSource(
  environment: AgentScopeEnvironment | null,
  context: readonly AgentContextItem[],
): SourceReference | null {
  const active = environment?.activeSource;
  if (!active) return null;
  const format = isExternalSource(active)
    ? viewerFormatOfPath(active.path)
    : active.folderPath === environment.folderPath
      ? environment.listing.files.find((file) => file.path === active.path)?.format
      : undefined;
  if (!format || !isRetrievableViewerFormat(format)) return null;
  const bound = context.some((item) => item.kind === 'source' && item.source.path === active.path);
  return bound ? null : active;
}

/** A file bound by its own name rather than a listing entry: an external
 *  file, or one the reader dropped on the document pane. A dropped one
 *  leaves the draft with its tab. */
export function fileContextItem(
  source: SourceReference,
  dropped = false,
): Extract<AgentContextItem, { kind: 'source' }> {
  return {
    boundVersion: null,
    format: viewerFormatOfPath(source.path),
    kind: 'source',
    source,
    ...(dropped ? { dropped: true as const } : {}),
  };
}

/** A file bound because the reader opened it here, by dropping it on the
 *  workspace or as an external file, shows as a document chip rather than
 *  as a tile or a mention. */
export function showsAsDocumentChip(item: Extract<AgentContextItem, { kind: 'source' }>): boolean {
  return item.dropped === true || isExternalSource(item.source);
}
