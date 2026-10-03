/** Controlled queue presentation. The conversation owns delivery and advancement. */
'use client';

import { AnimatePresence, Reorder } from 'framer-motion';
import { useCallback, useMemo, useRef } from 'react';

import { Collapse, useClippedHeight } from '@/components/internal/collapse';
import { Tooltip } from '@/components/ui/tooltip';
import { FOCUS_RING } from '@/lib/focus-ring';
import { fontWeights } from '@/lib/font-weight';
import { useIcon } from '@/lib/icon-context';
import { useShape } from '@/lib/shape-context';
import { useSize } from '@/lib/size-context';
import { spring } from '@/lib/springs';
import { useMotionTier } from '@/lib/use-motion-tier';
import { useTouchPrimary } from '@/lib/use-touch-primary';
import { cn } from '@/lib/utils';

/** A message held in the queue while the assistant is responding. Carries the
 *  trimmed text plus a snapshot of the files attached when it was queued, so
 *  double-click-to-edit can restore both. `id` is a stable key minted on enqueue. */
export interface QueuedMessage {
  id: string;
  text: string;
  files: File[];
}

/** The slice of `InputMessage`'s public surface this concern owns. */
export interface InputMessageQueueProps {
  /** Execution state controls Send / Queue / Stop presentation only. */
  status?: 'idle' | 'streaming';
  onEditQueued?: (id: string) => boolean;
  /** Controlled queue of pending messages. Requires `status` to be controlled. */
  queue?: QueuedMessage[];
  /** Called when the queue changes (enqueue, edit, delete, reorder, dispatch). */
  onQueueChange?: (queue: QueuedMessage[]) => void;
  /** Render the built-in reorderable queue rows above the textarea. Set to
   *  `false` to suppress them and render the queue yourself (e.g. as full-width
   *  rows above the composer). */
  showQueue?: boolean;
}

interface ComposerQueueOptions {
  /** Assistant response state. Undefined leaves the queue off entirely. */
  status: 'idle' | 'streaming' | undefined;
  /** Controlled queue. */
  queue: QueuedMessage[] | undefined;
  /** Called with the next queue on every transition. Its presence, with a
   *  controlled `status`, is the opt-in. */
  onQueueChange: ((queue: QueuedMessage[]) => void) | undefined;
  /** Puts a queued message back into the composer for editing. Called before
   *  the item leaves the queue, so the draft is written first. */
  onRestore: (item: QueuedMessage) => boolean;
}

/** Everything the composer needs to know about its queue. */
interface ComposerQueue {
  /** The queued messages, head first — the head is next to dispatch. */
  items: QueuedMessage[];
  /** Both a controlled status and a change handler are wired. */
  supported: boolean;
  /** The assistant is responding, so a submit stages instead of sending. */
  streaming: boolean;
  /** Stages a draft. Call only while `supported && streaming`. */
  enqueue: (text: string, files: File[]) => void;
  /** Pulls an item back into the composer and out of the queue. */
  edit: (item: QueuedMessage) => void;
  remove: (item: QueuedMessage) => void;
  /** Swaps an item with its neighbour (keyboard reorder). */
  move: (item: QueuedMessage, direction: -1 | 1) => void;
  /** Adopts a dragged order wholesale. */
  reorder: (next: QueuedMessage[]) => void;
}

export function useComposerQueue({
  status,
  queue,
  onQueueChange,
  onRestore,
}: ComposerQueueOptions): ComposerQueue {
  const items = useMemo(() => queue ?? [], [queue]);
  // Always-current view of the queue, so enqueue/edit/remove/move read the
  // latest value even if a handler closure is stale (e.g. two submits land
  // before the controlled `queue` prop round-trips back).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const supported = status !== undefined && onQueueChange !== undefined;
  const streaming = status === 'streaming';

  const enqueue = useCallback(
    (text: string, files: File[]) => {
      onQueueChange?.([...itemsRef.current, { id: crypto.randomUUID(), text, files }]);
    },
    [onQueueChange],
  );

  const remove = useCallback(
    (item: QueuedMessage) =>
      onQueueChange?.(itemsRef.current.filter((queued) => queued.id !== item.id)),
    [onQueueChange],
  );

  const edit = useCallback(
    (item: QueuedMessage) => {
      if (!supported) return;
      // Only remove a row after the owner accepts restoring its draft.
      if (!onRestore(item)) return;
      onQueueChange?.(itemsRef.current.filter((queued) => queued.id !== item.id));
    },
    [supported, onRestore, onQueueChange],
  );

  const move = useCallback(
    (item: QueuedMessage, direction: -1 | 1) => {
      const current = itemsRef.current;
      const from = current.findIndex((queued) => queued.id === item.id);
      const to = from + direction;
      const moving = current[from];
      const displaced = current[to];
      if (!moving || !displaced) return;
      const next = [...current];
      next[from] = displaced;
      next[to] = moving;
      onQueueChange?.(next);
    },
    [onQueueChange],
  );

  const reorder = useCallback((next: QueuedMessage[]) => onQueueChange?.(next), [onQueueChange]);

  return { edit, enqueue, items, move, remove, reorder, streaming, supported };
}

interface QueuedRowProps {
  item: QueuedMessage;
  index: number;
  total: number;
  isTouch: boolean;
  onEdit: (item: QueuedMessage) => void;
  onRemove: (item: QueuedMessage) => void;
  onMove: (item: QueuedMessage, direction: -1 | 1) => void;
}

/** A pending message in the queue: a recessed, draggable row that reads as
 *  "staged, not live". Double-click (or Enter/F2) edits it back into the
 *  composer; the hover-revealed × (or Delete) removes it; drag — or Alt+↑/↓ —
 *  reorders. Top of the list is next to dispatch. */
function QueuedRow({ item, index, total, isTouch, onEdit, onRemove, onMove }: QueuedRowProps) {
  const XIcon = useIcon('x');
  const ImageIcon = useIcon('image');
  const shape = useShape();
  const compactStep = useSize().variant === 'compact';
  const enter = useMotionTier(spring.fast);
  const leave = useMotionTier(spring.fast.exit);
  const fileCount = item.files.length;
  const label = item.text || `${fileCount} attachment${fileCount === 1 ? '' : 's'}`;

  return (
    <Reorder.Item
      value={item}
      layout
      // Enter: spring-fast chip category. Exit slightly faster (0.06s linear),
      // per animation-guidelines.md.
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, transition: leave }}
      transition={enter}
      aria-label={`Queued message ${index + 1} of ${total}: ${label}`}
      tabIndex={0}
      onDoubleClick={() => onEdit(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault();
          onEdit(item);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          onRemove(item);
        } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          onMove(item, e.key === 'ArrowUp' ? -1 : 1);
        }
      }}
      className={cn(
        // Fixed height (was py-1.5 around a 19.5px line box ≈ 31.5px) so the
        // text-box trim on the label doesn't shrink the row.
        `group/qrow flex items-center gap-2 ${shape.item} bg-muted`,
        compactStep ? 'h-7 px-2 text-ui-12' : 'h-8 px-2.5 text-ui-13',
        'text-foreground/85 outline-none select-none',
        'cursor-grab active:cursor-grabbing',
        FOCUS_RING,
      )}
      style={{ fontVariationSettings: fontWeights.normal }}
    >
      {fileCount > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
          <ImageIcon size={13} />
          {item.text && <span className="tabular-nums">{fileCount}</span>}
        </span>
      )}
      {/* py-1/-my-1 keeps truncate's overflow:hidden from clipping
          ascenders/descenders outside the trimmed box. */}
      <span className="-my-1 min-w-0 flex-1 truncate py-1 [text-box:trim-both_cap_alphabetic]">
        {label}
      </span>
      <Tooltip content="Remove" side="top">
        <button
          type="button"
          // Stop the pointer-down from starting a Reorder drag, and the click
          // from bubbling to the row's double-click/edit handler.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item);
          }}
          aria-label={`Remove queued message: ${label}`}
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
            'text-muted-foreground hover:bg-hover hover:text-foreground',
            // Hover devices reveal × on row-hover; touch has no hover, so keep
            // it persistently visible there.
            isTouch
              ? 'opacity-100'
              : 'opacity-0 group-hover/qrow:opacity-100 focus-visible:opacity-100',
            'cursor-pointer transition-opacity duration-fast outline-none',
            FOCUS_RING,
          )}
        >
          <XIcon size={13} strokeWidth={2.5} />
        </button>
      </Tooltip>
    </Reorder.Item>
  );
}

interface QueueRegionProps {
  /** The composer's queue state. */
  queue: ComposerQueue;
  /** Whether to render the built-in rows. False when the consumer renders the
   *  queue itself — enqueue and queue callbacks still run either way. */
  show: boolean;
}

/** The queued messages above the editor. The region collapses when the queue
 *  empties; the Reorder.Group handles drag-reorder (top = next to dispatch)
 *  and AnimatePresence handles per-row enter/exit. */
export function QueueRegion({ queue, show }: QueueRegionProps) {
  const region = useClippedHeight();
  // Touch devices have no hover, so a hover-revealed affordance (a queued
  // row's × button) would never appear; those are shown persistently instead.
  const isTouch = useTouchPrimary();
  if (!queue.supported || !show) return null;

  return (
    <Collapse
      height={region.size}
      open={queue.items.length > 0}
      presence="unmount"
      regionKey="queue-row"
    >
      <Reorder.Group
        ref={region.ref}
        axis="y"
        values={queue.items}
        onReorder={queue.reorder}
        data-im-queue
        className="flex flex-col gap-1 pb-1"
      >
        <AnimatePresence initial={false}>
          {queue.items.map((item, index) => (
            <QueuedRow
              key={item.id}
              item={item}
              index={index}
              total={queue.items.length}
              isTouch={isTouch}
              onEdit={queue.edit}
              onRemove={queue.remove}
              onMove={queue.move}
            />
          ))}
        </AnimatePresence>
      </Reorder.Group>
    </Collapse>
  );
}
