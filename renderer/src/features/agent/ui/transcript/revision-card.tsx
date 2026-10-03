/** The review an agent parked, as the reader sees it in the conversation: the
 *  document it is open on, how much is left to decide, and the two ways to end
 *  it in one step. The count and the controls belong to the document; this
 *  card only presents them, so the panel and the document's own header bar
 *  cannot say two different things about one review. */
import { FileText } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { AgentDecisionCard } from './decision-card';

export interface AgentRevisionReview {
  /** Changes still to decide. */
  readonly pending: number;
  acceptAll(): void;
  rejectAll(): void;
}

export function AgentRevisionCard({
  name,
  review,
}: {
  /** The document's own name, for the heading. */
  name: string;
  /** The review open on that document, or null when none is. */
  review: AgentRevisionReview | null;
}): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [decided, setDecided] = useState(false);
  // A review the reader already ended here, or one that was never open, has
  // nothing left to act on, so the card offers no control rather than one that
  // would do nothing.
  const open = review !== null && !decided;
  const resolve = (end: 'acceptAll' | 'rejectAll') => {
    if (!review || decided) return;
    setDecided(true);
    review[end]();
    requestAnimationFrame(() => headingRef.current?.focus());
  };
  return (
    <AgentDecisionCard
      heading={`Suggested changes in ${name}`}
      headingRef={headingRef}
      icon={FileText}
    >
      {open ? (
        <>
          <p className="mt-1 pl-6 text-ui-12 text-muted-foreground">
            {review.pending === 1 ? '1 suggested change' : `${review.pending} suggested changes`}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button onClick={() => resolve('rejectAll')} size="compact" variant="tertiary">
              Reject all
            </Button>
            <Button onClick={() => resolve('acceptAll')} size="compact" variant="primary">
              Accept all
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-1 text-right text-ui-12 text-muted-foreground" role="status">
          This review is no longer open here.
        </p>
      )}
    </AgentDecisionCard>
  );
}
