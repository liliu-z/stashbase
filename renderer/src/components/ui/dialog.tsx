/** Modal dialog built on Base UI's dialog: backdrop, focus trap, escape and
 *  outside-press dismissal, and the enter/exit motion that the portal stays
 *  mounted for. `Dialog` is the state owner; `DialogContent` is the surface,
 *  and the header/footer/title/description parts exist so the accessible name
 *  and description are wired by structure rather than by hand. */

'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { motion } from 'framer-motion';
import { forwardRef, useRef, type ReactNode, type HTMLAttributes } from 'react';

import { Button } from '@/components/ui/button';
import { useIcon } from '@/lib/icon-context';
import { motionStyle } from '@/lib/local/motion-style';
import { useMergedRef } from '@/lib/merge-refs';
import { useShape } from '@/lib/shape-context';
import { useSize, useSizeVariant } from '@/lib/size-context';
import { spring } from '@/lib/springs';
import { surfaceClasses } from '@/lib/surface-classes';
import { SurfaceProvider, useSurface } from '@/lib/surface-context';
import { useMotionTier } from '@/lib/use-motion-tier';
import { cn } from '@/lib/utils';

const DIALOG_OFFSET = 4;

/**
 * Every dialog paints the same panel, wherever it was opened from.
 *
 * The background used to climb with whatever surface was underneath, so the
 * same dialog read as a different panel depending on the pane that opened it,
 * and Settings kept a local override to escape that. The elevation still
 * climbs — it is carried by the shadow, which is what elevation is for — but
 * a dialog sits on the scrim rather than on the surface it covers, so its own
 * colour is fixed. The Command palette keeps the derived surface: it is a
 * floating overlay rather than a panel.
 */
const DIALOG_SURFACE = 2;

interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children?: ReactNode;
}

function Dialog({ children, open, defaultOpen, onOpenChange, modal }: DialogProps) {
  // Base UI's Root handles controlled/uncontrolled state internally. We only
  // narrow the (open, eventDetails) callback to (open) for our public prop.
  return (
    <DialogPrimitive.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={(next) => onOpenChange?.(next)}
      modal={modal}
    >
      {children}
    </DialogPrimitive.Root>
  );
}

const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

interface DialogContentProps extends HTMLAttributes<HTMLDivElement> {
  closeDisabled?: boolean;
  presentation?: 'dialog' | 'command' | 'shell';
  /** How much of the viewport the panel claims; density comes from the size ladder. */
  width?: 'narrow' | 'wide';
  /** Where focus lands when the panel opens. `first` is Base UI's default: the
   *  first tabbable element, which is the first field of a form and the right
   *  place for one. `panel` opens on the panel itself, for a dialog whose only
   *  controls are the answers to its question — opening on one of those draws
   *  a focus ring around an answer the reader has not given. @default 'first' */
  initialFocus?: 'first' | 'panel';
  /** Portal target. When set, the overlay and panel render inside this element
   *  (positioned `absolute`) instead of covering the viewport (`fixed`). Pair
   *  with a `position: relative; overflow: hidden` container — and usually
   *  `<Dialog modal={false}>` — to scope a dialog to a bounded region, e.g. a
   *  docs preview. Defaults to the document body / full-viewport behaviour. */
  container?: HTMLElement | null;
}

const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      className,
      children,
      closeDisabled = false,
      initialFocus = 'first',
      presentation = 'dialog',
      width = 'narrow',
      container,
      ...props
    },
    ref,
  ) => {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const popupRef = useMergedRef(panelRef, ref);
    const XIcon = useIcon('x');
    const shape = useShape();
    const substrate = useSurface();
    const command = presentation === 'command';
    const shell = presentation === 'shell';
    const dialogLevel = Math.min(substrate + (command ? 2 : DIALOG_OFFSET), 8);
    // The size ladder narrows the dialog one notch in compact regions —
    // width only, the padding stays put (see /docs/sizes).
    const compact = useSize().variant === 'compact';
    // One resolved pair for both surfaces: the backdrop and the panel are one
    // arrival, so they honour the reduced-motion preference together.
    const arrive = useMotionTier(spring.slow);
    const leave = useMotionTier(spring.slow.exit);

    // No `if (!open) return null` here — Base UI's `<DialogPrimitive.Popup>`
    // handles mount/unmount itself, and waits for the framer-motion opacity
    // tween below to finish (via `element.getAnimations()`) before unmounting.
    // Returning null early would short-circuit the closing animation.
    return (
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Backdrop
          render={(backdropProps, state) => {
            const exiting = state.transitionStatus === 'ending';
            const {
              style: _style,
              onDrag: _onDrag,
              onDragStart: _onDragStart,
              onDragEnd: _onDragEnd,
              onAnimationStart: _onAnimationStart,
              onAnimationEnd: _onAnimationEnd,
              onAnimationIteration: _onAnimationIteration,
              ...rest
            } = backdropProps as React.HTMLAttributes<HTMLDivElement>;
            return (
              <motion.div
                {...rest}
                className={cn(
                  container ? 'absolute' : 'fixed',
                  'inset-0 z-50',
                  command ? 'bg-transparent' : 'bg-scrim',
                )}
                initial={{ opacity: 0 }}
                animate={{ opacity: exiting ? 0 : 1 }}
                transition={exiting ? leave : arrive}
              />
            );
          }}
        />
        <DialogPrimitive.Popup
          ref={popupRef}
          initialFocus={initialFocus === 'panel' ? panelRef : undefined}
          render={(popupProps, state) => {
            const exiting = state.transitionStatus === 'ending';
            const {
              style: baseStyle,
              onDrag: _onDrag,
              onDragStart: _onDragStart,
              onDragEnd: _onDragEnd,
              onAnimationStart: _onAnimationStart,
              onAnimationEnd: _onAnimationEnd,
              onAnimationIteration: _onAnimationIteration,
              ...rest
            } = popupProps as React.HTMLAttributes<HTMLDivElement>;
            return (
              <motion.div
                // Base UI's props first (data attrs, refs, role, etc.)…
                {...rest}
                // …then the consumer's `<DialogContent>` props (className,
                // event handlers, data-*, etc.) land on the visible motion.div.
                {...(props as Omit<
                  React.HTMLAttributes<HTMLDivElement>,
                  | 'onDrag'
                  | 'onDragStart'
                  | 'onDragEnd'
                  | 'onAnimationStart'
                  | 'onAnimationEnd'
                  | 'onAnimationIteration'
                >)}
                className={cn(
                  container ? 'absolute' : 'fixed',
                  'left-1/2 z-50 w-[calc(100%-2rem)]',
                  command ? 'top-16 max-w-[680px] overflow-hidden p-0' : 'top-1/2',
                  shell ? 'overflow-hidden p-0' : !command && 'p-6',
                  surfaceClasses(command ? dialogLevel : DIALOG_SURFACE, dialogLevel),
                  'focus:outline-none',
                  shell && (compact ? 'max-w-[min(94vw,480px)]' : 'max-w-[min(92vw,820px)]'),
                  !command &&
                    !shell &&
                    width === 'narrow' &&
                    (compact ? 'max-w-[360px]' : 'max-w-[400px]'),
                  !command &&
                    !shell &&
                    width === 'wide' &&
                    (compact ? 'max-w-[480px]' : 'max-w-[540px]'),
                  shape.card,
                  className,
                )}
                style={{ ...motionStyle(baseStyle), ...motionStyle(props.style) }}
                initial={{
                  opacity: 0,
                  scale: command ? 0.985 : 0.97,
                  x: '-50%',
                  y: command ? -4 : '-50%',
                }}
                animate={{
                  opacity: exiting ? 0 : 1,
                  scale: exiting ? (command ? 0.985 : 0.97) : 1,
                  x: '-50%',
                  y: command ? 0 : '-50%',
                }}
                transition={exiting ? leave : arrive}
              >
                <SurfaceProvider value={command ? dialogLevel : DIALOG_SURFACE}>
                  {children}
                  {!command && (
                    <DialogPrimitive.Close
                      render={
                        <Button
                          className="absolute top-3 right-3"
                          disabled={closeDisabled}
                          size="icon-compact"
                          variant="ghost"
                        >
                          <XIcon />
                          <span className="sr-only">Close</span>
                        </Button>
                      }
                    />
                  )}
                </SurfaceProvider>
              </motion.div>
            );
          }}
        />
      </DialogPrimitive.Portal>
    );
  },
);
DialogContent.displayName = 'DialogContent';

function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1.5', className)} {...props} />;
}

function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-6 flex justify-end gap-2', className)} {...props} />;
}

const DialogTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => {
    // The title role of the type scale — see /docs/sizes.
    const compact = useSizeVariant() === 'compact';
    return (
      <DialogPrimitive.Title
        ref={ref}
        className={cn(
          compact ? 'text-ui-15' : 'text-ui-16',
          'leading-tight text-foreground',
          className,
        )}
        style={{ fontVariationSettings: "'wght' 700" }}
        {...props}
      />
    );
  },
);
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => {
    const sizeClasses = useSize();
    return (
      <DialogPrimitive.Description
        ref={ref}
        className={cn(sizeClasses.text, 'text-muted-foreground', className)}
        {...props}
      />
    );
  },
);
DialogDescription.displayName = 'DialogDescription';

export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
};
