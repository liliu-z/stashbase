/** The Chat transcript's message primitive. `ChatMessage` draws the reader's
 *  prompt as a right-aligned accent bubble and the Agent's reply as plain
 *  left-aligned text, with an optional row of attachment thumbnails above
 *  either; `ChatMessageAction` is the quiet button (copy, edit) that hovers
 *  beside a settled message on the bubble's own edge. */
'use client';

import { motion, type HTMLMotionProps } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { FileThumbnail } from '@/components/ui/file-thumbnail';
import { focusRing } from '@/lib/focus-ring';
import { keyedByContent } from '@/lib/local/keyed-by-content';
import { useShape } from '@/lib/shape-context';
import { useSize, type SizeVariant } from '@/lib/size-context';
import { spring } from '@/lib/springs';
import { useMotionTier } from '@/lib/use-motion-tier';
import { useTouchPrimary } from '@/lib/use-touch-primary';
import { cn } from '@/lib/utils';
import { fileFingerprint } from '@/shared/utils/file-identity';

interface ChatMessageProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
  /** `user` is a right-aligned accent bubble; `assistant` is left-aligned
   *  plain text with no bubble. */
  from: 'user' | 'assistant';
  /** Optional attachments rendered as square thumbnails above the bubble. */
  files?: File[];
  /** Side length of each attachment thumbnail in pixels. Defaults to 64. */
  thumbnailSize?: number;
  /** When the message happened, shown in the hover-revealed meta row. The
   *  caller pre-formats it (e.g. `"Wednesday 6:08 PM"`, `"3:31 PM · 12s"`). */
  time?: ReactNode;
  /** `ChatMessageAction`s for the meta row (copy, edit, regenerate). They sit
   *  at the message's outer edge: after the time on a user row, before it on
   *  an assistant row. */
  actions?: ReactNode;
  /** Message body. When omitted the text bubble is dropped (attachment-only message). */
  children?: ReactNode;
  /** Pins the message to one step of the size ladder (see /docs/sizes) —
   *  compact tightens bubble type and padding. Omitted, it follows the
   *  surrounding SizeProvider. */
  size?: SizeVariant;
}

/** An action's box is a 20px square around a 14px glyph, so the glyph sits
 *  3px inside it. The cluster overhangs the message's outer edge by that
 *  inset so the glyph — not its hover box — lines up with the bubble's edge
 *  on a user row and with the text on an assistant row. */
const ACTION_OVERHANG = { assistant: '-ml-[3px]', user: '-mr-[3px]' } as const;

// ─── ChatMessage ──────────────────────────────────────────────────────────
// A single transcript entry with baked-in entrance + layout motion. Pairs with
// InputMessage's onSend: render one per sent/received message. `layout="position"`
// lets earlier messages slide up smoothly when a new one is appended.
const ChatMessage = forwardRef<HTMLDivElement, ChatMessageProps>(
  (
    { from, files, thumbnailSize = 64, time, actions, children, size, className, ...props },
    ref,
  ) => {
    const shape = useShape();
    const compact = useSize(size).variant === 'compact';
    const isUser = from === 'user';
    // Hover-reveal is unreachable on touch — keep the meta row visible there.
    const isTouch = useTouchPrimary();
    const showTime = time != null;
    const timeLabel = showTime && <span className="tabular-nums">{time}</span>;

    return (
      <motion.div
        ref={ref}
        layout="position"
        initial={{ opacity: 0, y: 8, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={useMotionTier(spring.moderate)}
        style={{ transformOrigin: isUser ? 'bottom right' : 'bottom left' }}
        className={cn(
          'group flex flex-col gap-1.5',
          isUser ? 'max-w-[72%]' : 'w-full max-w-full',
          isUser ? 'items-end self-end' : 'items-start self-start',
          className,
        )}
        {...props}
      >
        {files && files.length > 0 && (
          <div className={cn('flex flex-wrap gap-1.5', isUser ? 'justify-end' : 'justify-start')}>
            {keyedByContent(files, fileFingerprint).map(({ key, item }) => (
              <FileThumbnail key={key} file={item} size={thumbnailSize} />
            ))}
          </div>
        )}
        {children != null && children !== '' && (
          <div
            className={cn(
              // `items-start` leaves this box content-sized, so unbreakable
              // content — a code block's longest line — sizes it by its own
              // max-content and carries the whole transcript past the pane's
              // edge; the scroller above only asks for vertical scroll, so
              // CSS grants horizontal too and the column slides. The cap
              // hands the width back to the message, letting the code block's
              // own `overflow-auto` scroll the line instead of the panel.
              'max-w-full break-words whitespace-pre-wrap',
              compact ? 'text-ui-13' : 'text-ui-14',
              // Only the bubble carries vertical padding; the flush assistant
              // reply lets the transcript gap set its rhythm.
              isUser && (compact ? 'py-1.5' : 'py-2'),
              // User keeps the bubble chrome (rounded fill + horizontal padding);
              // the assistant reply is flush-left plain text with no background.
              isUser
                ? cn(
                    shape.bg,
                    compact ? 'px-3' : 'px-3.5',
                    // `text-pretty` is reserved for settled user bubbles. On the
                    // assistant reply it's left off on purpose: `text-wrap: pretty`
                    // re-balances the last lines on every content change, so a
                    // word-by-word stream visibly reflows earlier words to new
                    // lines. Default (normal) wrapping appends left-to-right and
                    // stays put as the text grows.
                    'bg-[color-mix(in_oklab,var(--accent),var(--background)_45%)] text-pretty text-accent-foreground',
                  )
                : 'text-foreground',
            )}
          >
            {children}
          </div>
        )}
        {(showTime || actions != null) && (
          // Meta row: time + icon-only actions. Always rendered (so it
          // reserves its height and the gap between messages never shifts)
          // but hidden until the message is hovered or an action is focused.
          // Actions keep to the outer edge, so a user row reads time → icons
          // and an assistant row reads icons → time.
          <div
            className={cn(
              'flex items-center gap-1.5 leading-none text-muted-foreground select-none',
              compact ? 'text-ui-11' : 'text-ui-12',
              !isTouch && [
                'pointer-events-none opacity-0 transition-opacity duration-base',
                'group-hover:pointer-events-auto group-hover:opacity-100',
                'group-focus-within:pointer-events-auto group-focus-within:opacity-100',
              ],
            )}
          >
            {isUser && timeLabel}
            {actions != null && (
              <span className={cn('flex items-center gap-0.5', ACTION_OVERHANG[from])}>
                {actions}
              </span>
            )}
            {!isUser && timeLabel}
          </div>
        )}
      </motion.div>
    );
  },
);

ChatMessage.displayName = 'ChatMessage';

// ─── ChatMessageAction ────────────────────────────────────────────────────

interface ChatMessageActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /** The accessible name, also shown as the tooltip. */
  label: string;
}

/** One icon-only control for the meta row: a 20px square around a 14px
 *  glyph, quiet until hovered, ringed on keyboard focus. The geometry is
 *  fixed here so the row's overhang can line the glyph up with the message. */
const ChatMessageAction = forwardRef<HTMLButtonElement, ChatMessageActionProps>(
  ({ icon: Icon, label, className, ...props }, ref) => {
    const shape = useShape();
    return (
      <button
        aria-label={label}
        className={cn(
          'inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground transition-colors duration-fast outline-none hover:bg-hover hover:text-foreground',
          shape.mark,
          focusRing('focus-visible:ring-offset-0'),
          className,
        )}
        ref={ref}
        title={label}
        type="button"
        {...props}
      >
        <Icon aria-hidden size={14} strokeWidth={1.5} />
      </button>
    );
  },
);

ChatMessageAction.displayName = 'ChatMessageAction';

export { ChatMessage, ChatMessageAction };
