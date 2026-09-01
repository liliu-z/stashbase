import { useId } from 'react';
import { formatMiB } from '@/common/lib/format';
import { Button } from '@/common/components/ui/button';
import { SectionHeading } from '@/common/components/ui/section';
import { statusVariants } from '@/common/components/ui/status';
import { cn } from '@/common/lib/utils';

/** The Similarity Search preparation notice. Presentational: the surfaces that
 *  show it (the Files panel and the search popup) read the workload through
 *  `useSemanticIndexingNotice` and pass it in. */
export function SemanticIndexingNoticeView({
  awaiting,
  count,
  estimatedBytes,
  failureMessage,
  onStart,
  onDefer,
}: {
  awaiting: boolean;
  count: number;
  estimatedBytes?: number;
  failureMessage?: string;
  onStart: () => void;
  onDefer: () => void;
}) {
  const headingId = useId();
  const size = estimatedBytes ? ` · about ${formatMiB(estimatedBytes)}` : '';
  return (
    /* A named section wearing the warning-status look, NOT a `StatusMessage`:
     * that primitive is a live region (`role="status"`), and a live region
     * must hold only a short self-contained announcement. This card carries
     * a heading and two action buttons — structure a screen reader needs to
     * navigate, not have read at it as one polite interruption. The only
     * live part left is the text-only failure line below. */
    <section
      aria-labelledby={headingId}
      className={cn(statusVariants({ tone: 'warning' }), 'mx-3 mb-2 flex items-start justify-between gap-2.5 px-2.5 py-2')}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The line that NAMES this card, so a real heading rather than a
          * bold div. The type is pinned back to the card's own step: the
          * level is what changed, not the look. */}
        <SectionHeading id={headingId} level={2} className="text-sm">{awaiting ? 'Many files need Similarity Search preparation' : 'Similarity Search preparation paused'}</SectionHeading>
        <div className="leading-snug opacity-90">
          About {count.toLocaleString()} file{count === 1 ? '' : 's'} waiting{size}. Preparing them may take a while and use provider quota. Exact Search remains available.
        </div>
        {failureMessage && (
          <div className="leading-snug opacity-90" role="status" aria-live="polite">
            Search also needs attention: {failureMessage}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="outline" size="xs" onClick={onStart}>
          {awaiting ? 'Prepare files' : 'Resume preparation'}
        </Button>
        {awaiting && <Button variant="outline" size="xs" onClick={onDefer}>Not now</Button>}
      </div>
    </section>
  );
}
