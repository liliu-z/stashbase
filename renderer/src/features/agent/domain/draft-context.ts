/**
 * What the composer shows beside the draft's text: which bound items take a
 * tile, and which document it offers to attach.
 */
import { isRetrievableViewerFormat } from '@/contracts/file-formats';
import type {
  AgentContextItem,
  AgentScopeEnvironment,
  ContextValidation,
} from '@/features/agent/domain/context';
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

/** The document in front of the reader that the composer may offer to
 *  attach: listed in the chat's folder, readable as text, and not already
 *  bound. Null when there is nothing to offer. */
export function suggestedContextSource(
  environment: AgentScopeEnvironment | null,
  context: readonly AgentContextItem[],
): SourceReference | null {
  const active = environment?.activeSource;
  if (!active || active.folderPath !== environment.folderPath) return null;
  const listed = environment.listing.files.find((file) => file.path === active.path);
  if (!listed || !isRetrievableViewerFormat(listed.format)) return null;
  const bound = context.some((item) => item.kind === 'source' && item.source.path === active.path);
  return bound ? null : active;
}
