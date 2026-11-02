/** Tells the reader that a preview took a newer version, and while one is
 *  slow to load, that it is coming. It covers the page, so it is a small
 *  floating pill that takes no input and leaves on its own. */
import { Check, LoaderCircle } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

import type { PreviewStatus } from './preview-layers';

const LABEL: Record<PreviewStatus, string> = { updated: 'Updated', updating: 'Updating' };

export function PreviewUpdateStatus({ status }: { status: PreviewStatus | null }) {
  // Keep the last words while the pill fades out.
  const [last, setLast] = useState(status);
  if (status !== null && status !== last) setLast(status);
  const shown = status ?? last;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4"
      role="status"
    >
      {shown && (
        <span
          aria-hidden={status === null || undefined}
          className={cn(
            'flex items-center gap-1.5 rounded-full border border-border/50 bg-background py-1 pr-3 pl-2.5 text-caption text-muted-foreground shadow-sm transition-opacity duration-slow starting:opacity-0',
            status === null && 'opacity-0',
          )}
        >
          {shown === 'updating' ? (
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 motion-safe:animate-spin"
              strokeWidth={1.5}
            />
          ) : (
            <Check aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
          )}
          {LABEL[shown]}
        </span>
      )}
    </div>
  );
}
