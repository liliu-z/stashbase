/** The message composer, and the public entry for everything under
 *  `input-message-*`. This file owns the shell — the surface and its hairline
 *  edge, the click target that refocuses the field, the focus ring, the order
 *  the regions stack in — and delegates every behavior beside it.
 *
 *  The composer does not own a field. `editor` is required: the one consumer
 *  supplies a rich mention editor, and the built-in textarea that used to sit
 *  beside it — with a ghost placeholder, history recall and a suggestion
 *  listbox reading its caret — reached no product surface at all. Those were
 *  a second field's worth of keyboard behaviour maintained against stories,
 *  so they are gone and the union that discriminated the two shapes with
 *  them.
 *
 *  What remains is written where it is implemented: each `input-message-*`
 *  module exports the slice it owns (editor, actions, files, queue) and this
 *  file composes them, so a group shrinks where it is owned. */
'use client';

import {
  forwardRef,
  useCallback,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

import {
  ComposerActions,
  type InputMessageActionProps,
  type InputMessageSlotContext,
} from '@/components/ui/input-message-actions';
import {
  ConsumerEditorSlot,
  DROP_HINT,
  type InputMessageEditorContext,
  type InputMessageEditorProps,
  type InputMessageEditorSlot,
} from '@/components/ui/input-message-editor';
import {
  DEFAULT_ACCEPT,
  FilePreviewRow,
  useComposerFiles,
  type InputMessageFileProps,
} from '@/components/ui/input-message-files';
import {
  QueueRegion,
  useComposerQueue,
  type InputMessageQueueProps,
  type QueuedMessage,
} from '@/components/ui/input-message-queue';
import { DROP_TARGET } from '@/lib/local/drop-target';
import { useShape } from '@/lib/shape-context';
import { SizeProvider, type SizeVariant } from '@/lib/size-context';
import { surfaceClasses } from '@/lib/surface-classes';
import { SurfaceProvider } from '@/lib/surface-context';
import { cn } from '@/lib/utils';

/** The composer's lift, kept under every state of the edge below. */
const EDGE_DROP = '0 1px 1px -0.5px var(--shadow-color)';

interface InputMessageProps
  extends
    Omit<HTMLAttributes<HTMLDivElement>, 'onChange'>,
    InputMessageEditorProps,
    InputMessageActionProps,
    InputMessageFileProps,
    InputMessageQueueProps {
  /** Step on the size ladder. Wins over the surrounding SizeProvider and
   *  propagates to the composer's rows, buttons and queued messages. */
  size?: SizeVariant;
  /** Renders the field. The composer owns the chrome around it, never the
   *  control itself. */
  editor: InputMessageEditorSlot;
  /** Controlled draft. */
  value: string;
  /** Called with the new value on every change the field reports. */
  onValueChange: (value: string) => void;
  /** Submits the trimmed draft and files. The owner handles queued delivery. */
  onSend?: (value: string, files: File[], meta?: { queuedId?: string }) => void;
  /** Disables the field, send button, and drag-and-drop. */
  disabled?: boolean;
  /** Locks the field and file changes while leaving consumer-owned actions usable. */
  readOnly?: boolean;
  /** Consumer-owned actions temporarily replace the ordinary action bar. */
  actionSlot?: ReactNode;
  /** When false the field still takes and keeps a draft, but no submit
   *  dispatches it. For a composer whose runtime cannot carry a turn yet:
   *  disabling the whole control would take the draft away with it. */
  sendable?: boolean;
  /** When false, clicking the surrounding container won't refocus the field. */
  clickToFocus?: boolean;
}

const InputMessage = forwardRef<HTMLDivElement, InputMessageProps>(
  (
    {
      size,
      value,
      onValueChange,
      onSend,
      placeholder = 'Ask me anything…',
      placeholderIsPrompt = false,
      leftSlot,
      rightSlot,
      disabled,
      readOnly = false,
      actionSlot,
      minRows = 1,
      maxRows = 8,
      clickToFocus = true,
      sendLabel = 'Send',
      files,
      onFilesChange,
      accept = DEFAULT_ACCEPT,
      maxFiles,
      filePreviewSize = 80,
      acceptsDrag,
      previewSlot,
      editor,
      fieldProps,
      status,
      onStop,
      queue,
      onQueueChange,
      onEditQueued,
      showQueue = true,
      onSteer,
      sendable = true,
      sendableWithoutText = false,
      className,
      style,
      ...props
    },
    ref,
  ) => {
    const shape = useShape();
    const editorHostRef = useRef<HTMLDivElement>(null);
    const [hovered, setHovered] = useState(false);

    /** The consumer's field, found through the host it renders into. */
    const focusInput = useCallback(() => {
      editorHostRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
    }, []);

    const composerFiles = useComposerFiles({
      accept,
      acceptsDrag,
      disabled: disabled || readOnly,
      files,
      maxFiles,
      onFilesChange: readOnly ? undefined : onFilesChange,
    });

    /** Puts a queued message back only when the current draft can be preserved. */
    const restoreQueued = useCallback(
      (item: QueuedMessage) => {
        if (onEditQueued) return onEditQueued(item.id);
        if (value || composerFiles.items.length > 0) return false;
        onValueChange(item.text);
        composerFiles.replace(item.files);
        requestAnimationFrame(focusInput);
        return true;
      },
      [composerFiles, onValueChange, focusInput, onEditQueued, value],
    );
    const composerQueue = useComposerQueue({
      onQueueChange,
      onRestore: restoreQueued,
      queue,
      status,
    });

    const trimmed = value.trim();
    const canSend =
      !disabled &&
      !readOnly &&
      sendable &&
      (trimmed.length > 0 || composerFiles.items.length > 0 || sendableWithoutText);
    const dropHint = composerFiles.dragOver && composerFiles.supported;

    const handleSend = useCallback(
      (options?: { queue?: boolean }) => {
        if (!canSend) return;
        // While the assistant is streaming, a submit goes to the running
        // response when the owner takes that, and otherwise into the queue as
        // a snapshot of the draft (text + attached files). Either way the
        // composer clears and keeps focus.
        if (composerQueue.streaming && composerQueue.supported) {
          if (onSteer && !options?.queue) onSteer(trimmed, composerFiles.items);
          else composerQueue.enqueue(trimmed, composerFiles.items);
          onValueChange('');
          composerFiles.replace([]);
          requestAnimationFrame(focusInput);
          return;
        }
        onSend?.(trimmed, composerFiles.items);
      },
      [canSend, composerQueue, composerFiles, trimmed, onSend, onSteer, onValueChange, focusInput],
    );

    const handleContainerMouseDown = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (!clickToFocus || disabled) return;
        const target = event.target as HTMLElement;
        if (
          target.closest(
            'button, a, input, select, textarea, [contenteditable], [role="button"], [data-im-queue]',
          )
        ) {
          return;
        }
        event.preventDefault();
        focusInput();
      },
      [clickToFocus, disabled, focusInput],
    );

    const slotContext = useMemo<InputMessageSlotContext>(
      () => ({ files: composerFiles.items, openFilePicker: composerFiles.openFilePicker }),
      [composerFiles.items, composerFiles.openFilePicker],
    );

    // The edge is the box-shadow's 1px ring, recoloured on hover so the
    // stroke gains contrast without appearing to thicken; with none active
    // the className's `shadow-surface-2` supplies the resting edge. A drag the
    // composer takes draws no edge of its own: the box wears the one neutral
    // drop-target look every drop target shares (see the className below).
    // Holding focus paints nothing — the caret is the focus indicator.
    // Inline, not a `shadow-*` utility, which mangles multi-layer values.
    const edgeShadow =
      hovered && clickToFocus && !disabled && !composerFiles.dragOver
        ? `0 0 0 1px var(--border), ${EDGE_DROP}`
        : undefined;
    const preview = (
      <FilePreviewRow files={composerFiles} previewSlot={previewSlot} tileSize={filePreviewSize} />
    );

    const composer = (
      // Presentational shell: the consumer's editor is the control. This box
      // only widens the click target and hosts the drop zone, whose keyboard
      // equivalent is the attach button.
      <div
        role="presentation"
        ref={ref}
        onMouseDown={handleContainerMouseDown}
        // Marks the one place a desktop file attaches rather than opens, so
        // a drop zone around the composer leaves this drop to it.
        data-file-drop="attach"
        {...composerFiles.dropHandlers}
        className={cn(
          'flex flex-col gap-1 p-2 transition-[background-color,box-shadow,color] duration-fast',
          surfaceClasses(2, 2),
          shape.card,
          clickToFocus && !disabled && 'cursor-text',
          disabled && 'pointer-events-none opacity-50',
          className,
          // After the caller's classes, so the drop target's faint fill wins
          // over whatever surface the box wears while the drag lasts.
          composerFiles.dragOver && DROP_TARGET,
        )}
        style={edgeShadow ? { boxShadow: edgeShadow, ...style } : style}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        {...props}
      >
        <SurfaceProvider value={2}>
          {composerFiles.input}
          {readOnly ? (
            <div inert className="[&_button]:hidden">
              {preview}
            </div>
          ) : (
            preview
          )}
          <QueueRegion queue={composerQueue} show={showQueue} />
          <ConsumerEditorSlot
            editor={editor}
            field={{
              ariaDescribedBy: fieldProps?.['aria-describedby'],
              ariaLabel: fieldProps?.['aria-label'] ?? 'Message',
              disabled: Boolean(disabled || readOnly),
              maxRows,
              minRows,
              onValueChange,
              acceptPlaceholder: !dropHint && placeholderIsPrompt,
              placeholder: dropHint ? DROP_HINT : placeholder,
              submit: handleSend,
              value,
            }}
            hostRef={editorHostRef}
          />
          {actionSlot ?? (
            <ComposerActions
              canSend={canSend}
              disabled={disabled}
              leftSlot={leftSlot}
              onSend={() => handleSend()}
              onStop={onStop}
              queueable={composerQueue.supported}
              steerable={onSteer !== undefined}
              rightSlot={rightSlot}
              sendLabel={sendLabel}
              slotContext={slotContext}
              streaming={composerQueue.streaming}
            />
          )}
        </SurfaceProvider>
      </div>
    );

    // A size prop pins the whole composer — inner buttons, rows and queued
    // messages included — to one ladder step (matches InputGroup).
    return size ? <SizeProvider size={size}>{composer}</SizeProvider> : composer;
  },
);

InputMessage.displayName = 'InputMessage';

export { InputMessage };
export type { InputMessageEditorContext, QueuedMessage };
