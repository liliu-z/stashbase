/**
 * The one row grammar every Settings section is built from: a pane title,
 * groups (titled where a pane holds more than one), hairline lists, and rows
 * of `lead · title and detail · trailing control`. Rows carry their own title,
 * so a control inside one never renders a label of its own.
 * Nothing here has a surface fill; the only tint is the one pressable
 * controls share.
 *
 * One tone rule runs through all of it: a row that cannot be used right now
 * recedes to `muted` and says why in its own words. Nothing here turns a
 * sentence red. Red belongs to a refusal of what the reader just typed or
 * asked for (`FailureNotice` in its input tone) and to a destructive
 * confirmation, both of which sit outside this grammar.
 */

import { useId, type HTMLAttributes, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import { clamp } from '@/shared/utils/clamp';

export function SettingsPane({
  children,
  lede,
  title,
}: {
  children: ReactNode;
  lede?: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-body font-semibold text-foreground">{title}</h2>
        {lede && (
          <p className="mt-0.5 max-w-[62ch] text-caption leading-relaxed text-muted-foreground">
            {lede}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

export function SettingsGroup({
  children,
  count,
  hint,
  title,
}: {
  children: ReactNode;
  /** A quiet tally beside the title, such as "1 of 3 installed". */
  count?: string;
  /** One sentence under the list that explains what the group's choice does. */
  hint?: ReactNode;
  /** Left off where the pane holds one list: a heading that only repeats the
   *  pane's own title is a level the reader has to look past. Untitled, the
   *  group is the list and the sentence under it, and `count` has no heading
   *  to sit beside. */
  title?: string;
}) {
  const titleId = useId();
  const body = (
    <>
      {children}
      {hint && <p className="px-0.5 text-caption text-muted-foreground">{hint}</p>}
    </>
  );
  if (!title) return <div className="flex flex-col gap-1.5">{body}</div>;
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-1.5">
      <h3 className="text-caption font-semibold text-foreground" id={titleId}>
        {title}
        {count && <span className="ml-1.5 font-normal text-muted-foreground">{count}</span>}
      </h3>
      {body}
    </section>
  );
}

export function SettingsList({
  as: Component = 'div',
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: 'div' | 'ul' }) {
  const shape = useShape();
  return (
    <Component
      className={cn(
        'm-0 list-none overflow-hidden border border-border p-0',
        shape.panel,
        className,
      )}
      {...props}
    />
  );
}

export interface SettingsRowProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  as?: 'div' | 'li';
  /** Content under the title and detail: a bar, an inline editor, a notice. */
  children?: ReactNode;
  detail?: ReactNode;
  /** Leading slot: a runtime icon, a status glyph, or a choice indicator. */
  lead?: ReactNode;
  title: ReactNode;
  /** `muted` is how a row says "not available yet": the whole row recedes
   *  instead of a sentence turning red. */
  titleTone?: 'default' | 'muted';
  /** Trailing slot: the row's control or actions. */
  trail?: ReactNode;
}

export function SettingsRow({
  as: Component = 'div',
  children,
  className,
  detail,
  lead,
  title,
  titleTone = 'default',
  trail,
  ...props
}: SettingsRowProps) {
  const tall = children !== undefined && children !== null && children !== false;
  return (
    <Component
      className={cn(
        'grid gap-x-3 border-t border-border px-3.5 py-2.5 first:border-t-0',
        lead ? 'grid-cols-[auto_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]',
        tall ? 'items-start' : 'items-center',
        className,
      )}
      {...props}
    >
      {lead && <div className={cn('flex shrink-0', tall && 'mt-0.5')}>{lead}</div>}
      <div className="min-w-0">
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-2 gap-y-0.5 text-body font-medium',
            titleTone === 'muted' ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {title}
        </div>
        {detail && (
          <div className="mt-0.5 text-caption leading-snug text-muted-foreground">{detail}</div>
        )}
      </div>
      {trail !== undefined && trail !== null && (
        <div className={cn('flex shrink-0 items-center gap-1 justify-self-end', tall && 'mt-0.5')}>
          {trail}
        </div>
      )}
      {tall && (
        <div className={cn('mt-2.5', lead ? 'col-start-2 -col-end-1' : 'col-span-full')}>
          {children}
        </div>
      )}
    </Component>
  );
}

/** A row that reports a state instead of offering a setting: a read still in
 *  flight, or one that failed and can be tried again. It keeps the list's
 *  shape, so a section does not change grammar the moment something is
 *  missing, and it keeps the list's voice: quiet, with the way out on the
 *  right. */
export function SettingsMessage({
  as = 'div',
  message,
  onRetry,
}: {
  as?: 'div' | 'li';
  message: string;
  onRetry?: () => void;
}) {
  return (
    <SettingsRow
      as={as}
      title={
        // The live region is the sentence, not the row: a list item that took
        // `role="status"` would stop being a list item.
        <span className="font-normal" role="status">
          {message}
        </span>
      }
      titleTone="muted"
      trail={
        onRetry && (
          <Button onClick={onRetry} size="compact" variant="ghost">
            Retry
          </Button>
        )
      }
    />
  );
}

/** State as form: a dot and a word, never a colored sentence. */
export function StatusChip({
  children,
  tone = 'on',
}: {
  children: ReactNode;
  tone?: 'on' | 'muted' | 'warn';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-ui-11 font-medium whitespace-nowrap',
        tone === 'warn'
          ? 'text-decision'
          : tone === 'on'
            ? 'text-foreground'
            : 'text-muted-foreground',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          tone === 'warn' ? 'bg-decision' : tone === 'on' ? 'bg-working' : 'bg-muted-foreground',
        )}
      />
      {children}
    </span>
  );
}

export function ProgressBar({
  className,
  live = false,
  value,
}: {
  className?: string;
  /** In-progress work takes the focus accent; a standing measure stays neutral. */
  live?: boolean;
  value: number;
}) {
  const percent = clamp(Math.round(value), 0, 100);
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-active', className)}>
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-slow ease-out',
          live ? 'bg-[color:var(--focus-ring)]' : 'bg-foreground/70',
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** A quiet disclosure for content most people never open, such as
 *  development-only controls or advanced connection details. */
export function Disclosure({
  badge,
  children,
  summary,
}: {
  badge?: ReactNode;
  children: ReactNode;
  summary: string;
}) {
  return (
    <details className="group/disclosure">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-0.5 py-1.5 text-caption font-semibold text-muted-foreground transition-colors duration-fast hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="size-1.5 -rotate-45 border-r-[1.5px] border-b-[1.5px] border-current transition-transform duration-fast group-open/disclosure:rotate-45"
        />
        {summary}
        {badge}
      </summary>
      <div className="px-0.5 pt-1 pb-2">{children}</div>
    </details>
  );
}
