/** One cover with the same frame in loaded, missing, and retry states. */
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';

import { GalleryImage } from './image';

const HERO_FRAME = { aspectRatio: '16 / 9' } as const;

export function GalleryScreenshot({
  name,
  screenshot,
}: {
  name: string;
  screenshot: string | null;
}) {
  const shape = useShape();
  return (
    <div
      className={cn(
        'relative flex w-full items-center justify-center overflow-hidden border border-border bg-surface-3',
        !screenshot && 'border-dashed',
        shape.panel,
      )}
      style={HERO_FRAME}
    >
      {screenshot ? (
        <GalleryImage
          key={screenshot}
          retryable
          alt={`${name} cover`}
          className="absolute inset-0 size-full object-cover object-top"
          src={screenshot}
        />
      ) : (
        <p className="m-0 max-w-xs text-center text-caption text-muted-foreground">
          The cover for this project isn’t published yet.
        </p>
      )}
    </div>
  );
}
