import { Button } from '@/components/ui/button';
import { FailureLine } from '@/shared/ui/failure-notice';

/** One sentence in place of results: idle guidance, progress, or nothing
 *  found. */
export function StatusLine({ children }: { children: string }) {
  return (
    <p className="px-4 py-2 text-caption text-muted-foreground" role="status">
      {children}
    </p>
  );
}

/** A refused search, with the one recovery the reader has. */
export function SearchFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2">
      <FailureLine tone="input">{message}</FailureLine>
      <Button onClick={onRetry} size="compact" variant="tertiary">
        Retry
      </Button>
    </div>
  );
}

/** A line under the results: what was left out, or what could not be opened.
 *  The two are not the same line said twice — what was left out is a footnote
 *  below the type scale, while a refusal is said at the app's own failure
 *  size and in its voice. */
const FOOTER_EDGE = 'shrink-0 border-t border-border px-4 py-2';

export function FooterNote({ children, tone }: { children: string; tone: 'error' | 'muted' }) {
  if (tone === 'error') {
    return (
      <FailureLine className={FOOTER_EDGE} tone="input">
        {children}
      </FailureLine>
    );
  }
  return (
    <p className={`${FOOTER_EDGE} text-ui-10 text-muted-foreground`} role="status">
      {children}
    </p>
  );
}
