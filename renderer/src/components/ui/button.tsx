/** The button primitive: one `<button>` whose variant, size and shape all come
 *  from the surrounding token contexts rather than from class names passed in.
 *  Everything clickable in the renderer that is not a menu row, a tab, or a
 *  sidebar control routes through here, so the press feedback, the focus ring,
 *  the icon-only sizing, and the disabled semantics stay in one place.
 *
 *  Consumers pick behaviour with `variant` and `size`; they never restyle it
 *  with `className` beyond layout. There is no `color` prop — the four
 *  variants below carry every fill this kit draws, and a caller that wanted a
 *  fifth would be asking for a token, not a prop. */

'use client';

import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';

import { FOCUS_RING } from '@/lib/focus-ring';
import type { IconComponent } from '@/lib/icon-context';
import { useSize, useSizeVariant } from '@/lib/size-context';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  [
    'group relative isolate inline-flex cursor-pointer items-center justify-center whitespace-nowrap outline-none',
    'transition-colors duration-fast',
    'disabled:pointer-events-none disabled:opacity-50',
    'aria-disabled:pointer-events-none aria-disabled:opacity-50',
    FOCUS_RING,
  ],
  {
    variants: {
      variant: {
        primary: 'text-background',
        secondary: 'text-foreground',
        tertiary: 'text-foreground',
        // A pressed toggle wears ink, so its state reads in the label as well
        // as in the `active` fill behind it.
        ghost: 'text-muted-foreground hover:text-foreground aria-pressed:text-foreground',
      },
      // Only the icon-only square is a shape decision. Height, type step and
      // padding all come from the size ladder (see size-context), so this
      // component holds no copy of it.
      iconOnly: {
        true: 'p-0',
        false: '',
      },
      iconLeft: { true: '' },
      iconRight: { true: '' },
    },
    compoundVariants: [
      { iconOnly: false, iconLeft: true, className: 'pl-[10px]' },
      { iconOnly: false, iconRight: true, className: 'pr-[10px]' },
    ],
    defaultVariants: {
      variant: 'primary',
      iconOnly: false,
    },
  },
);

/** The button's shape on the ladder. `icon` is the square icon-only button at
 *  whatever step is in force; `compact` pins a button to the dense step on a
 *  surface that is otherwise at the default one. */
type ButtonSize = 'default' | 'compact' | 'icon' | 'icon-compact';

interface ButtonProps
  extends
    ButtonHTMLAttributes<HTMLButtonElement>,
    Omit<VariantProps<typeof buttonVariants>, 'size'> {
  /** Omitted, the button follows the surrounding SizeProvider (default 36px,
   *  compact 28px). */
  size?: ButtonSize;
  /** When true, the given single React-element child becomes the rendered element (slot-style). */
  asChild?: boolean;
  loading?: boolean;
  leadingIcon?: IconComponent;
  trailingIcon?: IconComponent;
  /** Force the visual pressed/held state. Useful when the button drives an
   *  external open piece of UI (a popover, dropdown, etc.) so it reads as
   *  engaged while the menu is showing. */
  active?: boolean;
  /** Keep focus while disabled, announced through `aria-disabled`: for a
   *  toggle that is briefly disabled by its own press, so the keyboard user
   *  is not dropped to the page. */
  focusableWhenDisabled?: boolean;
}

/** The variant names, taken from the one place they are declared. Both maps
 *  below are keyed by this rather than by `string`: a `Record<string, string>`
 *  reads back as `string` for any key at all, so a variant added to the cva
 *  above and forgotten here compiled fine and rendered an unstyled surface at
 *  runtime. */
type ButtonVariant = NonNullable<NonNullable<VariantProps<typeof buttonVariants>['variant']>>;

/* Press effect: the surface layer sits 1px inside the button and a
   same-color box-shadow spread fills it back out to the full bounds.
   Pressing collapses the spread, shrinking the surface by exactly 1px per
   side at any width — a scale would warp (2% of a 400px button is 8px
   sideways but under 1px vertically). Fill colors are opaque color-mix()es
   rather than alpha so the fill and its spread ring never seam.

   The hover and press steps mix the fill toward the opposite pole of the
   monochrome pair — ink toward paper, paper toward ink — and they mix far
   enough to be seen: on a near-black fill a 10% step lands two shades away
   and reads as no change at all, and a light fill stepped toward the page
   background only lost contrast. Primary lightens 16% on hover and 22%
   pressed; secondary darkens 8% on hover and 14% pressed. */
const bgVariants: Record<ButtonVariant, string> = {
  primary:
    '[--btn-bg:var(--foreground)] group-hover:[--btn-bg:color-mix(in_oklab,var(--foreground)_84%,var(--background))] group-active:[--btn-bg:color-mix(in_oklab,var(--foreground)_78%,var(--background))] bg-[var(--btn-bg)] shadow-[0_0_0_1px_var(--btn-bg)] group-active:shadow-[0_0_0_0px_var(--btn-bg)]',
  secondary:
    '[--btn-bg:var(--accent)] group-hover:[--btn-bg:color-mix(in_oklab,var(--accent)_92%,var(--foreground))] group-active:[--btn-bg:color-mix(in_oklab,var(--accent)_86%,var(--foreground))] bg-[var(--btn-bg)] shadow-[0_0_0_1px_var(--btn-bg)] group-active:shadow-[0_0_0_0px_var(--btn-bg)]',
  // The border ring is an outer hairline shadow at rest that hands off to an
  // inset hairline shadow when pressed, so the ring moves inward with the
  // surface. The translucent fill only ever reaches the ring's inner edge
  // (exactly the surface box), so it needs no spread of its own.
  tertiary:
    'bg-transparent shadow-[0_0_0_var(--hairline)_var(--border),inset_0_0_0_0px_var(--border)] group-hover:bg-hover group-active:bg-active group-active:shadow-[0_0_0_0px_var(--border),inset_0_0_0_var(--hairline)_var(--border)]',
  // Translucent fill + same-color spread never double up: outer shadows
  // render only outside the surface box.
  ghost:
    'bg-transparent shadow-[0_0_0_1px_transparent] group-hover:bg-hover group-hover:shadow-[0_0_0_1px_var(--hover)] group-active:bg-active group-active:shadow-[0_0_0_0px_var(--active)]',
};

/* Forced-active (`active` prop): pressed colors at full size; the
   geometric press-collapse still reacts on top. */
const activeBgVariants: Record<ButtonVariant, string> = {
  primary:
    '[--btn-bg:color-mix(in_oklab,var(--foreground)_78%,var(--background))] bg-[var(--btn-bg)] shadow-[0_0_0_1px_var(--btn-bg)] group-active:shadow-[0_0_0_0px_var(--btn-bg)]',
  secondary:
    '[--btn-bg:color-mix(in_oklab,var(--accent)_86%,var(--foreground))] bg-[var(--btn-bg)] shadow-[0_0_0_1px_var(--btn-bg)] group-active:shadow-[0_0_0_0px_var(--btn-bg)]',
  tertiary:
    'bg-active shadow-[0_0_0_var(--hairline)_var(--border),inset_0_0_0_0px_var(--border)] group-active:shadow-[0_0_0_0px_var(--border),inset_0_0_0_var(--hairline)_var(--border)]',
  ghost: 'bg-hover shadow-[0_0_0_1px_var(--hover)] group-active:shadow-[0_0_0_0px_var(--hover)]',
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      leadingIcon: LeadingIcon,
      trailingIcon: TrailingIcon,
      active = false,
      focusableWhenDisabled = false,
      disabled,
      children,
      style,
      ...props
    },
    ref,
  ) => {
    // asChild: the user's element becomes the root while the button's internal
    // structure (bg layer, content wrapper, spinner, icons) survives as its
    // children — the element's own children become the label. We clone the
    // element directly instead of routing through ButtonPrimitive's `render`:
    // Base UI would bolt button semantics (role="button", Space activation)
    // onto e.g. a link, where plain-link output is wanted.
    const asChildElement =
      asChild && isValidElement(children)
        ? (children as ReactElement<{
            children?: ReactNode;
            className?: string;
            style?: React.CSSProperties;
            ref?: React.Ref<HTMLButtonElement>;
          }>)
        : null;
    const label = asChildElement ? asChildElement.props.children : children;
    // `icon`/`icon-compact` say "square", `compact` says "dense step"; both
    // resolve onto the one ladder, which the context owns.
    const isIconOnly = size === 'icon' || size === 'icon-compact';
    const contextSize = useSizeVariant();
    const step =
      size === 'compact' || size === 'icon-compact'
        ? 'compact'
        : size === 'default' || size === 'icon'
          ? 'default'
          : contextSize;
    const sizeClasses = useSize(step);
    const iconSize = sizeClasses.icon;
    const bgClass = active
      ? activeBgVariants[variant ?? 'primary']
      : bgVariants[variant ?? 'primary'];

    const internals = (
      <>
        <span
          aria-hidden
          className={cn(
            // The two durations are the motion tokens, not literals: the surface's
            // shadow settles on the base step and its colour on the fast one, so
            // a reduced-motion viewer gets both from the same @media block that
            // zeroes every other transition in the app.
            // shape-literal: the fill layer takes the button's own corner.
            'absolute inset-px rounded-[inherit] transition-[box-shadow,background-color] [transition-duration:var(--motion-base),var(--motion-fast)] [transition-timing-function:cubic-bezier(0.23,1,0.32,1),ease] group-active:[transition-duration:var(--motion-fast),var(--motion-fast)]',
            bgClass,
          )}
        />
        {/* `min-w-0` on both content wrappers: without it their automatic
            minimum size is the label's full nowrap width, so a caller that
            bounds the button (`max-w-*`, or a row that squeezes it) clipped
            nothing and the label spilled out past the button's own box over
            whatever sat beside it. */}
        <span className="relative inline-flex min-w-0 items-center justify-center gap-[inherit]">
          {loading ? (
            <>
              <span className="flex items-center justify-center gap-[inherit] opacity-0">
                {LeadingIcon && !isIconOnly && <LeadingIcon size={iconSize} strokeWidth={2} />}
                {label}
                {TrailingIcon && !isIconOnly && <TrailingIcon size={iconSize} strokeWidth={2} />}
              </span>
              <span className="absolute inset-0 flex items-center justify-center">
                <svg className={sizeClasses.square} viewBox="0 0 24 24" fill="none">
                  <path
                    d="M 12 12 C 14 8.5 19 8.5 19 12 C 19 15.5 14 15.5 12 12 C 10 8.5 5 8.5 5 12 C 5 15.5 10 15.5 12 12 Z"
                    stroke="currentColor"
                    strokeWidth="1.125"
                    strokeLinecap="round"
                    pathLength="100"
                    style={{
                      strokeDasharray: '15 85',
                      animation:
                        'spinner-move 2s linear infinite, spinner-dash 4s ease-in-out infinite',
                    }}
                  />
                </svg>
              </span>
            </>
          ) : isIconOnly ? (
            <span className="[&_svg]:stroke-[1.5] [&_svg]:transition-[stroke-width] [&_svg]:duration-fast group-hover:[&_svg]:stroke-[2]">
              {label}
            </span>
          ) : (
            <>
              {LeadingIcon && (
                <LeadingIcon
                  size={iconSize}
                  strokeWidth={1.5}
                  className="transition-[stroke-width] duration-fast group-hover:stroke-[2]"
                />
              )}
              {/* text-box only applies to block containers, so the trim lives
                  on the label span (a blockified flex item), not the flex root.
                  The button's height is fixed (h-*), so this doesn't change
                  layout — it just centers the cap-to-baseline box optically. */}
              <span className="min-w-0 [text-box:trim-both_cap_alphabetic]">{label}</span>
              {TrailingIcon && (
                <TrailingIcon
                  size={iconSize}
                  strokeWidth={1.5}
                  className="transition-[stroke-width] duration-fast group-hover:stroke-[2]"
                />
              )}
            </>
          )}
        </span>
      </>
    );

    const rootClassName = cn(
      buttonVariants({
        variant,
        iconOnly: isIconOnly,
        iconLeft: !isIconOnly && !!LeadingIcon,
        iconRight: !isIconOnly && !!TrailingIcon,
      }),
      sizeClasses.control,
      sizeClasses.text,
      isIconOnly
        ? cn(sizeClasses.square, sizeClasses.squareGlyph)
        : cn(sizeClasses.buttonPx, sizeClasses.buttonGap),
      // The corner steps with the control (see size-context `radius`): 16 on
      // the 36px button, 12 on the 28px one, so neither reads as a capsule.
      sizeClasses.radius,
      className,
    );

    if (asChildElement) {
      const childProps = asChildElement.props;
      return cloneElement(
        asChildElement,
        {
          ...props,
          ref,
          className: cn(rootClassName, childProps.className),
          style: { ...style, ...childProps.style },
        },
        internals,
      );
    }

    return (
      <ButtonPrimitive
        // Base UI's `ButtonPrimitive` forwards to an HTMLButtonElement;
        // keep the public ref type narrow so consumers see the right type.
        ref={ref as React.Ref<HTMLButtonElement>}
        className={rootClassName}
        disabled={disabled || loading}
        focusableWhenDisabled={focusableWhenDisabled}
        style={style}
        {...props}
      >
        {internals}
      </ButtonPrimitive>
    );
  },
);

Button.displayName = 'Button';

export { Button };
export type { ButtonProps };
