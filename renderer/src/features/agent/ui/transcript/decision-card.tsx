/** The frame a decision sits in — an approval, a clarifying question — with
 *  the heading focus returns to once the reader has decided, and the status
 *  line that takes the controls' place afterwards. Both cards draw this one
 *  frame so their look cannot drift apart. */
import type { ComponentType, ReactNode, Ref } from 'react';

import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';

import { STATUS_LABELS, type AgentToolBlock } from './tool-presentation';

type DecisionIcon = ComponentType<{
  'aria-hidden'?: boolean;
  className?: string;
  strokeWidth?: number;
}>;

export function AgentDecisionCard({
  children,
  heading,
  headingId,
  headingRef,
  icon: Icon,
}: {
  children: ReactNode;
  heading: string;
  /** The heading's id, for a group below that takes its name from it. */
  headingId?: string | undefined;
  headingRef: Ref<HTMLHeadingElement>;
  icon: DecisionIcon;
}) {
  const shape = useShape();
  return (
    <div
      className={cn(
        'relative flex min-h-[60px] min-w-0 flex-col overflow-hidden border border-border bg-surface-2 pb-4',
        shape.panel,
      )}
    >
      <div className="p-3">
        <div className="flex items-start gap-2">
          <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-decision" strokeWidth={1.5} />
          <h3
            className="text-ui-13 font-medium text-foreground outline-none"
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
          >
            {heading}
          </h3>
        </div>
        {children}
      </div>
    </div>
  );
}

/** What the card says once the decision is made and the controls are gone. */
export function AgentDecisionStatus({ status }: { status: AgentToolBlock['status'] }) {
  return (
    <p className="mt-1 text-right text-ui-12 text-muted-foreground" role="status">
      {STATUS_LABELS[status]}
    </p>
  );
}
