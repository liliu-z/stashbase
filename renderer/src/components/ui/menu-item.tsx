/**
 * One row of a menu surface: leading icon, label, optional description,
 * optional trailing action, and the selection check.
 *
 * MenuItem names no primitive. The surrounding surface supplies
 * `renderMenuItem` through context, and the primitive it wraps the row in owns
 * the role, roving highlight, typeahead, and activation; this module owns the
 * styled div and the proximity registration. A second branch used to render
 * its own ARIA div — and its own Enter/Space handling and roving tab stop —
 * for the inline Dropdown panel, which no product surface ever mounted; it
 * went with the panel.
 *
 * A row takes no position from its caller: it registers its element with the
 * surrounding surface and the shared DOM-order registry derives the index (see
 * `@/lib/use-dom-order-registry`), so a list that gains or loses a row never
 * renumbers the ones after it. A checked row marks itself in the same pass,
 * which is how the surface finds its selected background.
 *
 * `DropdownContext` and `MenuItemRenderOptions` are re-exported here because
 * this module has always been their public entry; they are defined in
 * `./menu-item-context` so the registry and the context stay together.
 * `DropdownContextValue` is no longer exported — nothing outside the context
 * module named it.
 */
'use client';

import { forwardRef, type HTMLAttributes } from 'react';

import { MenuItemCheck } from '@/components/internal/menu-item-check';
import { MenuItemSwitch } from '@/components/internal/menu-item-switch';
import { menuRowTone } from '@/components/internal/menu-row-tone';
import { useProximityRow } from '@/components/internal/proximity-row';
import { Badge } from '@/components/ui/badge';
import { WeightedLabel } from '@/components/ui/weighted-label';
import type { IconComponent } from '@/lib/icon-context';
import { useShape } from '@/lib/shape-context';
import { useSize } from '@/lib/size-context';
import { cn } from '@/lib/utils';

import { Button } from './button';
import { useDropdown } from './menu-item-context';

export { DropdownContext, type MenuItemRenderOptions } from './menu-item-context';

type MenuItemLayout = 'stacked' | 'inline' | 'wrap';

interface MenuItemTrailingAction {
  icon: IconComponent;
  label: string;
  onSelect(): void;
}

interface MenuItemProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional leading icon. When omitted, the row renders text-only with no
   *  reserved icon column. */
  icon?: IconComponent;
  label: string;
  /** Optional explanatory copy for choices whose consequence cannot be
   *  understood from the short label alone. */
  description?: string;
  /** A short neutral tag on the label's line, for a fact a reader should
   *  weigh before choosing the row (a model's relative cost). */
  badge?: string;
  /** How the row lays its text out. "stacked" — the default — truncates a
   *  long label on one line and puts any description under it. "inline" puts
   *  a short description beside the label, for compact choice menus.
   *  "wrap" lets a long label run onto a second line instead of truncating.
   *  One option rather than three, because the three that were here were
   *  never chosen independently: every caller picked one of these shapes. */
  layout?: MenuItemLayout;
  /** When a boolean, the item is a radio-style option (role="menuitemradio"
   *  with aria-checked). When undefined, it is a plain action item
   *  (role="menuitem", no checked state announced). */
  checked?: boolean;
  onSelect?: () => void;
  disabled?: boolean;
  /** A compact secondary action at the row's trailing edge. The focused row
   *  also exposes the action through the Delete key. */
  trailingAction?: MenuItemTrailingAction;
  /** A decorative glyph at the trailing edge for a row that leads somewhere
   *  rather than choosing something. It sits where a chosen row draws its
   *  check, so the two never appear together. */
  trailingIcon?: IconComponent;
  /** When a boolean, the row is an on/off toggle (role="menuitemcheckbox")
   *  and draws a switch at its trailing edge. Activating the row flips it
   *  through `onSelect`. Not combined with `checked`. */
  switched?: boolean;
  /** Whether activating the row closes the surface. The primitive's default
   *  (closing) is right for a choice and an action; a row that swaps the
   *  surface's own content for a deeper list passes false. */
  closeOnClick?: boolean;
  /** An action that destroys something, such as Delete. Its label and glyph
   *  wear the error colour at rest and highlighted alike; the row's own tone
   *  would otherwise paint over a colour a caller passed in. The caller sets
   *  it last, after a separator. */
  destructive?: boolean;
}

const MenuItem = forwardRef<HTMLDivElement, MenuItemProps>(
  (
    {
      icon: Icon,
      label,
      description,
      badge,
      layout = 'stacked',
      checked,
      onSelect,
      disabled,
      trailingAction,
      trailingIcon: TrailingIcon,
      switched,
      closeOnClick,
      destructive = false,
      className,
      onClick,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const shape = useShape();
    const { registerItem, activeIndex, itemRegistry, renderMenuItem } = useDropdown();
    const {
      index,
      isActive,
      ref: mergeRef,
      skipAnimation,
    } = useProximityRow<HTMLDivElement>(
      ref,
      { activeIndex, registerItem, registry: itemRegistry },
      checked === true,
    );

    const inlineDescription = Boolean(description && layout === 'inline');
    const wrapsLabel = layout === 'wrap';
    const stackedDescription = Boolean(description && !inlineDescription);
    const sizeClasses = useSize();
    const TrailingActionIcon = trailingAction?.icon;

    const handleActivate = disabled
      ? undefined
      : (e: React.MouseEvent<HTMLDivElement>) => {
          onClick?.(e);
          onSelect?.();
        };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || disabled) return;
      if (trailingAction && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        event.stopPropagation();
        trailingAction.onSelect();
        return;
      }
    };

    const named = badge ? `${label}, ${badge}` : label;
    const accessibleLabel = description ? `${named}. ${description}` : named;
    const itemClassName = cn(
      // Fixed height (was py-2 around a 19.5px line box ≈ 35.5px) so the
      // text-box trim on the label doesn't shrink the row. shrink-0 because
      // menu popups are max-height flex columns — without it a long list
      // compresses rows to fit instead of scrolling.
      `relative z-10 flex ${sizeClasses.control} shrink-0 items-center ${sizeClasses.gap} ${shape.item} ${sizeClasses.itemPx} cursor-pointer outline-none`,
      (wrapsLabel || stackedDescription) && 'h-auto min-h-9 py-2',
      stackedDescription && 'min-h-14',
      disabled && 'pointer-events-none opacity-50',
      className,
    );

    const labelText = (
      <WeightedLabel
        className={cn(
          'min-w-0 flex-1',
          destructive ? 'text-destructive' : menuRowTone(isActive || checked === true),
        )}
        data-menu-item-label
        emphasized={false}
        overflow={wrapsLabel ? 'wrap' : 'truncate'}
      >
        {label}
      </WeightedLabel>
    );

    const content = (
      <>
        {Icon && (
          <span className="inline-grid">
            <span className="invisible col-start-1 row-start-1">
              <Icon size={sizeClasses.icon} strokeWidth={2} />
            </span>
            <Icon
              size={sizeClasses.icon}
              strokeWidth={isActive || checked ? 2 : 1.5}
              className={cn(
                'col-start-1 row-start-1 transition-[color,stroke-width] duration-fast',
                destructive
                  ? 'text-destructive'
                  : isActive || checked
                    ? 'text-foreground'
                    : 'text-muted-foreground',
              )}
            />
          </span>
        )}
        <span
          className={cn(
            'flex min-w-0 flex-1',
            sizeClasses.text,
            inlineDescription ? 'items-center gap-2' : 'flex-col items-stretch',
            // A row with no leading glyph has nothing to align its text
            // against, and sits a hair high against the trailing check. The
            // nudge used to be a className every icon-less caller passed in.
            !Icon && 'translate-y-px',
          )}
          data-menu-item-content
        >
          {badge ? (
            <span className="flex min-w-0 items-center gap-2">
              {labelText}
              <Badge aria-hidden="true" className="-my-1 shrink-0" size="compact">
                {badge}
              </Badge>
            </span>
          ) : (
            labelText
          )}
          {description && (
            <span
              className={cn(
                sizeClasses.caption,
                'font-normal text-muted-foreground',
                inlineDescription
                  ? 'min-w-0 truncate'
                  : 'mt-1 block leading-[17px] whitespace-normal',
              )}
            >
              {description}
            </span>
          )}
        </span>
        {trailingAction && TrailingActionIcon && (
          <Button
            aria-label={trailingAction.label}
            // Shown on the highlighted row only, the way a renamable name
            // offers its pencil on hover: a column of identical glyphs down
            // every row read as clutter. It keeps its room at rest, so the
            // row never reflows, and stays on where there is no hover.
            className={cn(
              '-my-1 -mr-1 shrink-0 transition-[color,opacity] duration-fast',
              isActive ? 'opacity-100' : 'opacity-0 pointer-coarse:opacity-100',
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              trailingAction.onSelect();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            size="icon-compact"
            title={trailingAction.label}
            variant="ghost"
          >
            <TrailingActionIcon aria-hidden="true" />
          </Button>
        )}
        {typeof switched === 'boolean' && <MenuItemSwitch on={switched} />}
        <MenuItemCheck
          checked={checked === true}
          className="shrink-0 text-foreground"
          size={sizeClasses.icon}
          skipAnimation={skipAnimation}
        />
        {TrailingIcon && checked !== true && (
          <TrailingIcon
            aria-hidden="true"
            className="shrink-0 text-muted-foreground"
            size={sizeClasses.icon}
            strokeWidth={1.5}
          />
        )}
      </>
    );

    // The surrounding surface's menu-item primitive owns the role,
    // aria-checked, tabIndex, roving highlight, typeahead, and Enter/Space/
    // click activation (activation synthesizes a click, so handleActivate also
    // fires for keyboard). The styled div carries the Fluid Functionalism
    // visuals and the proximity-hover registration; MenuItem itself imports no
    // primitive.
    // The role is spelled out on each branch rather than computed: the
    // primitive sets the same value when it clones this element, and a literal
    // keeps the row's interactive contract visible to readers and to static
    // analysis.
    const primitiveRow = {
      ref: mergeRef,
      'data-proximity-index': index,
      'aria-label': accessibleLabel,
      'aria-keyshortcuts': trailingAction ? 'Delete' : undefined,
      onClick: handleActivate,
      onKeyDown: handleKeyDown,
      className: itemClassName,
      ...props,
    };
    return renderMenuItem({
      radio: typeof checked === 'boolean',
      toggle: typeof switched === 'boolean' ? { on: switched } : undefined,
      value: index,
      disabled,
      closeOnClick,
      label: accessibleLabel,
      element:
        typeof switched === 'boolean' ? (
          <div role="menuitemcheckbox" aria-checked={switched} {...primitiveRow} />
        ) : typeof checked === 'boolean' ? (
          <div role="menuitemradio" aria-checked={checked} {...primitiveRow} />
        ) : (
          <div role="menuitem" {...primitiveRow} />
        ),
      children: content,
    });
  },
);

MenuItem.displayName = 'MenuItem';

export { MenuItem };
