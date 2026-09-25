import { Plus, X } from 'lucide-react';

import { FileTypeIcon } from '@/components/ui/file-type-icon';
import { Tooltip } from '@/components/ui/tooltip';
import { focusRing } from '@/lib/focus-ring';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import type { SourceReference } from '@/shared/domain/source-reference';
import { basePathName } from '@/shared/utils/file-path';

/** The document in front of the reader, offered but never bound until the
 *  reader clicks it: a dashed outline with no surface, so it reads as an
 *  option beside the context that is really attached. */
export function SuggestedSourceChip({
  onAttach,
  onDismiss,
  source,
}: {
  onAttach: () => void;
  onDismiss: () => void;
  source: SourceReference;
}) {
  const shape = useShape();
  const name = basePathName(source.path);
  return (
    <div
      className={cn(
        'inline-flex h-7 max-w-64 shrink-0 items-center border border-dashed border-border text-[12px] text-muted-foreground',
        shape.bg,
      )}
    >
      <Tooltip content={`Attach ${source.path}`} side="top">
        <button
          aria-label={`Attach ${name}`}
          className={cn(
            'inline-flex h-full min-w-0 cursor-pointer items-center gap-1.5 pr-1 pl-2 transition-colors duration-fast outline-none hover:text-foreground',
            shape.bg,
            focusRing(),
          )}
          onClick={onAttach}
          type="button"
        >
          <Plus aria-hidden="true" className="shrink-0" size={12} strokeWidth={2.5} />
          <FileTypeIcon aria-hidden="true" className="shrink-0" path={source.path} size={14} />
          <span className="min-w-0 truncate">{name}</span>
        </button>
      </Tooltip>
      <Tooltip content="Don't suggest" side="top">
        <button
          aria-label={`Don't suggest ${name}`}
          className={cn(
            'mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center transition-colors duration-fast outline-none hover:bg-hover hover:text-foreground',
            shape.chip,
            focusRing(),
          )}
          onClick={onDismiss}
          type="button"
        >
          <X aria-hidden="true" size={12} />
        </button>
      </Tooltip>
    </div>
  );
}
