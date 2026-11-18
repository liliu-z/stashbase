/** What one Agent turn changed in the folder's Markdown, as a quiet list
 *  under the turn: each file once, with its line counts and the one thing
 *  the reader can do with it. Nothing opens on its own; Review is the reader
 *  choosing to see the turn's changes inside the document. */
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { AgentTurnChangedFile } from '@/features/agent/domain/session';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import type { SourceReference } from '@/shared/domain/source-reference';
import { basePathName } from '@/shared/utils/file-path';

import { ChangedFileLabel } from './changed-file-label';
import { Counts } from './file-change';

/** The reader asking to review one file a turn changed. */
export interface AgentTurnChangeReview {
  readonly source: SourceReference;
  readonly turnId: string;
}

const CHANGE_LABEL: Record<AgentTurnChangedFile['change'], string> = {
  created: 'Created',
  deleted: 'Deleted',
  edited: 'Edited',
};

const COLLAPSED_FILE_COUNT = 3;

/** One file's action, repeated down the list, so it is the quiet outlined
 *  button every row action is: no icon, the button's own type, and its box
 *  inside the row rather than reaching past it. */
function FileAction({
  file,
  name,
  onOpenSource,
  onReview,
  source,
}: {
  file: AgentTurnChangedFile;
  name: string;
  onOpenSource?: ((source: SourceReference, phrase: string | null) => void) | undefined;
  onReview?: ((source: SourceReference) => void) | undefined;
  source: SourceReference | null;
}) {
  if (!source || file.change === 'deleted') return null;
  // A created file has no earlier text to compare against, so the whole file
  // is the change and opening it is the review.
  if (file.change === 'created') {
    return onOpenSource ? (
      <Button
        aria-label={`Open ${name}`}
        onClick={() => onOpenSource(source, null)}
        size="compact"
        variant="tertiary"
      >
        Open
      </Button>
    ) : null;
  }
  return onReview ? (
    <Button
      aria-label={`Review changes to ${name}`}
      onClick={() => onReview(source)}
      size="compact"
      variant="tertiary"
    >
      Review
    </Button>
  ) : null;
}

export function AgentTurnChangesCard({
  files,
  onOpenSource,
  onReviewTurnChange,
  projectPathFor,
  sourceFor,
  turnId,
}: {
  files: readonly AgentTurnChangedFile[];
  onOpenSource?: ((source: SourceReference, phrase: string | null) => void) | undefined;
  onReviewTurnChange?: ((review: AgentTurnChangeReview) => void) | undefined;
  projectPathFor?: ((path: string) => string | null) | undefined;
  sourceFor?: ((path: string) => SourceReference | null) | undefined;
  turnId: string;
}) {
  const shape = useShape();
  const headingId = useId();
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const visibleFiles = expanded ? files : files.slice(0, COLLAPSED_FILE_COUNT);
  const hiddenCount = Math.max(0, files.length - COLLAPSED_FILE_COUNT);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const onReview = onReviewTurnChange
    ? (source: SourceReference) => onReviewTurnChange({ source, turnId })
    : undefined;
  return (
    // A card set in the transcript is paper: no fill of its own, only a
    // hairline, so the chat shows through it.
    <section aria-labelledby={headingId} className={cn('border border-border/50', shape.panel)}>
      <div className="flex flex-col items-start gap-1 border-b border-border/50 px-3 py-3">
        <h3 className="text-ui-13 font-medium text-foreground" id={headingId}>
          Changed {files.length} {files.length === 1 ? 'file' : 'files'}
        </h3>
        <div className="flex">
          <Counts additions={additions} deletions={deletions} />
        </div>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 px-3 py-2" id={listId}>
        {visibleFiles.map((file) => {
          const name = basePathName(file.path);
          const source = sourceFor?.(file.path) ?? null;
          return (
            <li
              className={cn('flex min-h-7 items-center gap-2 text-ui-12', shape.item)}
              key={file.path}
            >
              <ChangedFileLabel
                iconSize={14}
                layout="path-first"
                path={file.path}
                shownPath={projectPathFor?.(file.path) ?? source?.path}
              />
              <Counts additions={file.additions} deletions={file.deletions} />
              <span
                className={cn(
                  'shrink-0 text-muted-foreground',
                  file.additions === 0 && file.deletions === 0 && 'ml-auto',
                )}
              >
                {CHANGE_LABEL[file.change]}
              </span>
              <FileAction
                file={file}
                name={name}
                onOpenSource={onOpenSource}
                onReview={onReview}
                source={source}
              />
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 && (
        // The toggle's box starts on the rows' edge, with its padding drawn in
        // so the label sits just inside it: at rest and on hover it lines up
        // with the list above instead of reaching past it.
        <Button
          aria-controls={listId}
          aria-expanded={expanded}
          className="mx-3 mb-2 px-1.5"
          onClick={() => setExpanded((value) => !value)}
          size="compact"
          trailingIcon={expanded ? ChevronUp : ChevronDown}
          variant="ghost"
        >
          {expanded
            ? 'Collapse files'
            : `Show ${hiddenCount} more ${hiddenCount === 1 ? 'file' : 'files'}`}
        </Button>
      )}
    </section>
  );
}
