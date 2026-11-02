/** Tells the reader that a preview took a newer version, and while one is
 *  slow to load, that it is coming. It covers a page of any colour, so it is
 *  an ink pill like a tooltip, ringed in paper so it stands out from a page
 *  of its own tone. It takes no input and leaves on its own. */
import { Check, LoaderCircle } from 'lucide-react';
import { useState } from 'react';

import { fontWeights } from '@/lib/font-weight';
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
            'flex items-center gap-1.5 rounded-full bg-foreground py-1.5 pr-3.5 pl-3 text-caption text-background shadow-md ring-1 ring-background/25 transition-[opacity,translate] duration-slow starting:-translate-y-1 starting:opacity-0',
            status === null && 'opacity-0',
          )}
          style={{ fontVariationSettings: fontWeights.medium }}
        >
          {shown === 'updating' ? (
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 motion-safe:animate-spin"
              strokeWidth={2}
            />
          ) : (
            <Check aria-hidden="true" className="size-3.5" strokeWidth={2} />
          )}
          {LABEL[shown]}
        </span>
      )}
    </div>
  );
}
