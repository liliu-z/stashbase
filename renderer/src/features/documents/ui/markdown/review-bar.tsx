import { Button } from '@/components/ui/button';

export interface MarkdownReviewBarProps {
  onUndoAll(): void;
  onKeepAll(): void;
  pending: number;
}

/** The remaining changes from the turn. Keeping the turn's work is the
 * primary action; undoing changes uses the document's normal save path. */
export function MarkdownReviewBar({ onUndoAll, onKeepAll, pending }: MarkdownReviewBarProps) {
  return (
    <div aria-label="Changes from this turn" className="markdown-review-bar" role="group">
      <span className="markdown-review-count" role="status">
        {pending === 1 ? '1 change from this turn' : `${pending} changes from this turn`}
      </span>
      <Button onClick={onKeepAll} size="compact" variant="primary">
        Keep all
      </Button>
      <Button onClick={onUndoAll} size="compact" variant="tertiary">
        Undo all
      </Button>
    </div>
  );
}
