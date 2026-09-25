import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';

/** The editor could not be built; the source on disk is untouched. */
export function MarkdownOpenFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="markdown-status flex-col gap-3" role="alert">
      <div>
        <p className="text-body font-medium">Could not open this Markdown document</p>
        <p className="mt-1 text-caption text-muted-foreground">
          The source is unchanged. Try opening the editor again.
        </p>
      </div>
      <Button leadingIcon={RefreshCw} onClick={onRetry} size="compact" variant="tertiary">
        Try again
      </Button>
    </div>
  );
}
