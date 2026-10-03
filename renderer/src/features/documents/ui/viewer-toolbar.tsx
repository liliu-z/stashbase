/**
 * The floating control strip document viewers share: a page or zoom value the
 * reader can click to edit, and the buttons beside it. One toolbar recipe so
 * PDF, image, and future viewers do not each invent their own.
 */
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import { InlineInput } from '@/components/ui/inline-input';
import { Tooltip } from '@/components/ui/tooltip';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import { SINGLE_CLICK_DELAY_MS } from '@/shared/utils/click-intent';

const VALUE_TYPOGRAPHY_CLASS = 'font-sans text-ui-12 leading-none tabular-nums';

export function ViewerToolbar({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  const shape = useShape();

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
      <div
        aria-label={label}
        className={cn(
          'pointer-events-auto flex h-10 max-w-full items-center gap-1 border border-border bg-[color-mix(in_oklab,var(--surface-3)_72%,transparent)] px-1.5 text-foreground shadow-surface-5 backdrop-blur-xl backdrop-saturate-150 transition-[background-color,box-shadow] duration-fast focus-within:bg-[color-mix(in_oklab,var(--surface-3)_82%,transparent)] focus-within:shadow-surface-6 hover:bg-[color-mix(in_oklab,var(--surface-3)_82%,transparent)] hover:shadow-surface-6',
          shape.container,
          className,
        )}
        role="toolbar"
      >
        {children}
      </div>
    </div>
  );
}

export function ViewerToolbarButton({
  label,
  ...props
}: Omit<ComponentProps<typeof Button>, 'aria-label' | 'size' | 'title' | 'variant'> & {
  label: string;
}) {
  return (
    <Tooltip content={label}>
      <Button {...props} aria-label={label} size="icon-compact" title={label} variant="ghost" />
    </Tooltip>
  );
}

export function ViewerToolbarValue({
  align = 'center',
  editOnClick = false,
  emphasis = 'muted',
  label,
  max,
  min,
  onCommit,
  onSingleClick,
  suffix,
  style,
  title,
  value,
  widthClass,
}: {
  align?: 'center' | 'end';
  editOnClick?: boolean;
  emphasis?: 'default' | 'muted';
  label: string;
  max?: number;
  min?: number;
  onCommit(value: number): void;
  onSingleClick?(): void;
  suffix?: string;
  style?: CSSProperties;
  title: string;
  value: number;
  widthClass?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingClick = () => {
    if (!clickTimer.current) return;
    clearTimeout(clickTimer.current);
    clickTimer.current = null;
  };
  const beginEdit = () => {
    cancelPendingClick();
    setDraft(String(value));
    setEditing(true);
  };
  const cancelEdit = () => {
    setDraft(String(value));
    setEditing(false);
  };
  const commitEdit = () => {
    const next = Number(draft.trim());
    if (Number.isFinite(next)) onCommit(next);
    setEditing(false);
  };

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [editing, value]);

  useEffect(() => cancelPendingClick, []);

  const resolvedWidthClass = widthClass ?? (style?.width ? undefined : 'w-14');
  const typographyClass = cn(
    VALUE_TYPOGRAPHY_CLASS,
    emphasis === 'default' ? 'text-foreground' : 'text-muted-foreground',
  );
  const alignmentClass = align === 'end' ? 'text-right' : 'text-center';

  if (editing) {
    return (
      <span
        className={cn(
          'flex h-7 items-center px-1.5',
          suffix && 'justify-center',
          resolvedWidthClass,
        )}
        style={style}
      >
        <InlineInput
          aria-label={label}
          className={cn('min-w-0', alignmentClass, typographyClass)}
          inputMode="numeric"
          max={max}
          min={min}
          onCancel={cancelEdit}
          onChange={setDraft}
          onCommit={commitEdit}
          spellCheck={false}
          style={suffix ? { width: `${Math.max(1, draft.length)}ch` } : undefined}
          value={draft}
        />
        {suffix && <span className={cn('shrink-0', typographyClass)}>{suffix}</span>}
      </span>
    );
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (editOnClick) {
      beginEdit();
      return;
    }
    if (event.detail === 0) {
      onSingleClick?.();
      return;
    }
    if (event.detail > 1) {
      cancelPendingClick();
      return;
    }
    cancelPendingClick();
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      onSingleClick?.();
    }, SINGLE_CLICK_DELAY_MS);
  };

  return (
    <Button
      aria-label={label}
      className={cn(
        'px-1.5',
        align === 'end' && 'justify-end',
        typographyClass,
        resolvedWidthClass,
      )}
      onClick={handleClick}
      onDoubleClick={(event) => {
        event.preventDefault();
        beginEdit();
      }}
      onKeyDown={(event) => {
        if (!editOnClick && event.key === 'F2') {
          event.preventDefault();
          beginEdit();
        }
      }}
      size="compact"
      style={style}
      title={title}
      type="button"
      variant="ghost"
    >
      {value}
      {suffix}
    </Button>
  );
}
