import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Each source owns its failure. Cards stay single click
 * targets; the full screenshot offers a retry through the same image proxy. */
export function GalleryImage({
  src,
  alt,
  className,
  loading,
  retryable = false,
}: {
  src: string;
  alt: string;
  className: string;
  loading?: 'lazy' | 'eager';
  retryable?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  let source = src;
  if (attempt && URL.canParse(src)) {
    const url = new URL(src);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.searchParams.set('galleryRetry', String(attempt));
      source = url.href;
    }
  }
  if (!failed)
    return (
      <img
        alt={alt}
        className={className}
        key={attempt}
        loading={loading}
        onError={() => setFailed(true)}
        src={source}
      />
    );
  return (
    <span
      className={cn(
        className,
        'flex flex-col items-center justify-center gap-2 bg-surface-3 p-3 text-center text-caption text-muted-foreground',
      )}
    >
      <span>{retryable ? 'Could not load this screenshot.' : 'Preview unavailable'}</span>
      {retryable && (
        <Button
          aria-label="Retry screenshot"
          size="compact"
          variant="ghost"
          onClick={() => {
            setAttempt(Date.now());
            setFailed(false);
          }}
        >
          Retry
        </Button>
      )}
    </span>
  );
}
