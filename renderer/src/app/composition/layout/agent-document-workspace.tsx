/**
 * The Agent beside the open document, and the handle between them.
 *
 * Both panes are always mounted: the Agent keeps its transcript and its
 * composer draft while a document is opened and closed beside it, so the split
 * is a width, not a route. The Agent pane's width is the remembered one; the
 * document keeps a floor of its own and the Agent yields, which is what makes
 * a narrow window collapse the chat rather than crush the page being read.
 */
import { motion, useReducedMotionConfig } from 'framer-motion';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { SplitHandle } from '@/components/ui/split-handle';
import { useHasOpenDocuments, type DocumentTabsRuntime } from '@/features/documents/public';
import { AGENT_PANE_WIDTH } from '@/features/workspace/public';
import { collapseTween, exitTween, stepSeconds, tween } from '@/lib/springs';
import { cn } from '@/lib/utils';

/** The document keeps at least this much of the row; the Agent pane yields. */
const MIN_DOCUMENT_WIDTH = 320;

/** The seam's sweep: the collapse ladder's slow step, since a pane crossing
 *  most of the card is the largest thing this row moves. Eased rather than
 *  sprung for the reason every expand and collapse here is — what travels is
 *  the space each pane occupies, not a pane arriving — and because over the
 *  row's whole width a spring's slight bounce carries the seam past the edge
 *  it lands on and back, which reads as a wobble on a rule that is supposed
 *  to come to rest against a wall.
 *
 *  One value, both directions and both panes: the collapse ladder runs a close
 *  at the length it ran the open, and the two panes are halves of one seam, so
 *  anything read per pane or per direction would land them a frame apart and
 *  tear the rule between them. */
const SEAM_SWEEP = collapseTween.slow;

/** Which change is moving the seam, or `none` while it rests. */
type Sweep = 'none' | 'documents' | 'chat';

/** The row's own width in px, or null until it has been measured. */
function useRowWidth(ref: React.RefObject<HTMLDivElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width || null);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * One row that is always mounted: the document slot on the left and the
 * Agent pane on the right. With no document open the slot is zero wide and
 * the Agent has the whole row; opening the first document only changes
 * widths, so the Agent workspace never remounts and keeps its transcript,
 * draft, and focus.
 *
 * Motion is one push. The document slot and the Agent's box ride one sweep,
 * so the Agent's left rule, the seam, sweeps across the row; the Agent's
 * contents follow their edge, re-centring as the pane widens or narrows,
 * the same way they do under a seam drag, so the chat reads as a sheet being
 * pushed rather than a line crossing a jump. The document holds the width
 * it had when its slot began to close and slides under the sheet as one
 * piece, and opens back out at the width its slot is heading for.
 *
 * Hiding and showing the Chat is the same push on the same sweep: the sheet
 * slides off the row's right edge and back onto it, and the document reflows
 * under the travelling seam the way it does under a seam drag, since both
 * ends of that travel are widths the page is read at.
 */
export function AgentDocumentWorkspace({
  agent,
  chatPaneOpen = true,
  document,
  documentsShown = true,
  newTabOpen = false,
  onPaneWidthChange,
  paneWidth,
  runtime,
}: {
  agent: ReactNode;
  chatPaneOpen?: boolean;
  document: ReactNode;
  /** False while the sidebar is in Chats mode: the open documents leave the
   *  row and the Agent has the whole card, whatever the Chat toggle says.
   *  They stay mounted, so Documents mode finds them where they were. */
  documentsShown?: boolean;
  /** True while the strip's New tab is selected: its page takes the
   *  document slot the way a document would, open documents or not. */
  newTabOpen?: boolean;
  onPaneWidthChange(width: number): void;
  paneWidth: number;
  runtime: DocumentTabsRuntime | null;
}) {
  const hasDocuments = (useHasOpenDocuments(runtime) || newTabOpen) && documentsShown;
  // The Chat is the card while documents are off screen; the toggle's hide
  // applies only beside a document.
  const chatShown = chatPaneOpen || !documentsShown;
  const rowRef = useRef<HTMLDivElement>(null);
  const rowWidth = useRowWidth(rowRef);
  const reduceMotion = useReducedMotionConfig() ?? false;

  // The seam animates on two flips and nothing else: a document opening or
  // the last one closing (including the documents leaving and returning with
  // the sidebar mode), and the Chat being hidden or brought back. Every other
  // width change — a drag, a window resize — lands at once. Both are detected
  // synchronously: the transition must be the sweep on the very commit whose
  // animate targets change, and an effect runs too late for that, so the hold
  // state only keeps the sweep through its settle.
  //
  // Which of the two is sweeping decides how the page underneath behaves, so
  // the sweep is named rather than a flag. A documents sweep starts or ends at
  // a zero-wide slot, which is not a width the page can be read at; a Chat
  // sweep moves the seam between two widths that are.
  const previousDocuments = useRef(hasDocuments);
  const previousChat = useRef(chatShown);
  const documentsFlipped = previousDocuments.current !== hasDocuments;
  const chatFlipped = previousChat.current !== chatShown;
  const flipped = documentsFlipped || chatFlipped;
  const animates = !reduceMotion && rowWidth !== null;
  const [settleHold, setSettleHold] = useState<Sweep>('none');
  useLayoutEffect(() => {
    if (!flipped) return;
    previousDocuments.current = hasDocuments;
    previousChat.current = chatShown;
    if (animates) setSettleHold(documentsFlipped ? 'documents' : 'chat');
  }, [animates, chatShown, documentsFlipped, flipped, hasDocuments]);
  const sweep: Sweep = flipped && animates ? (documentsFlipped ? 'documents' : 'chat') : settleHold;
  const settling = sweep !== 'none';

  const agentWidth = hasDocuments
    ? rowWidth === null
      ? paneWidth
      : Math.min(paneWidth, Math.max(AGENT_PANE_WIDTH.min, rowWidth - MIN_DOCUMENT_WIDTH))
    : null;
  const documentWidth = !chatShown
    ? (rowWidth ?? '100%')
    : agentWidth === null
      ? 0
      : rowWidth === null
        ? `calc(100% - ${agentWidth}px)`
        : rowWidth - agentWidth;
  // The width the document's content is laid out at. Open, it is the slot's
  // own; while the slot closes it is the width the slot had, remembered from
  // the last commit that showed it, so the page slides under the seam as
  // one piece instead of re-wrapping as the slot narrows.
  //
  // A Chat sweep is the exception: both ends of that travel are readable
  // widths, so the page follows the slot live and re-wraps under the moving
  // seam exactly as it does under a seam drag. Pinning it to either end
  // instead would jump a centred column sideways before the seam had moved.
  const lastDocumentWidth = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (typeof documentWidth === 'number' && documentWidth > 0) {
      lastDocumentWidth.current = documentWidth;
    }
  });
  const documentContentWidth =
    typeof documentWidth !== 'number' || sweep === 'chat'
      ? '100%'
      : documentWidth > 0
        ? documentWidth
        : settling
          ? (lastDocumentWidth.current ?? undefined)
          : undefined;
  // The Agent's box: its docked width beside a document, else the row. In
  // pixels whenever the row is measured, so the sweep has two numbers to
  // travel between; the transition to and from the row is what sweeps the
  // seam across it. A Chat brought back from hidden has no seam of its own
  // to sweep: its shelf opens from the row's right edge, so the box takes
  // the row at once and rides the shelf's edge in.
  const agentBoxWidth = agentWidth ?? rowWidth ?? '100%';
  const transition = settling ? SEAM_SWEEP : { duration: 0 };
  const boxTransition = chatPaneOpen ? transition : { duration: 0 };
  // The page keeps its ink through the sweep and dissolves only over its last
  // stretch, which is why the fade is a short step held back rather than a
  // long one. The last pixels of a closing slot cross the card's corner
  // radius, and a square strip of the page's own surface standing in that
  // corner reads as a shadow flicking past the wall the seam lands on.
  const contentFade = !settling
    ? { duration: 0 }
    : hasDocuments
      ? tween.fast
      : { ...exitTween.fast, delay: stepSeconds.base };

  return (
    <div className="flex h-full min-h-0 overflow-hidden" ref={rowRef}>
      <motion.div
        animate={{ width: documentWidth }}
        aria-hidden={!hasDocuments}
        className="relative h-full shrink-0 overflow-hidden"
        data-testid="document-slot"
        inert={!hasDocuments}
        initial={false}
        onAnimationComplete={() => setSettleHold('none')}
        transition={transition}
      >
        {/* The seam does the covering, so the page stays whole under it; the
         *  fade only takes away what the seam cannot reach. */}
        <motion.div
          animate={{ opacity: hasDocuments ? 1 : 0 }}
          className="h-full"
          initial={false}
          style={{ width: documentContentWidth }}
          transition={contentFade}
        >
          {document}
        </motion.div>
      </motion.div>
      <div
        data-command-surface="agent"
        aria-hidden={!chatShown}
        className="relative h-full min-w-0 flex-1 overflow-hidden"
        inert={!chatShown}
      >
        {hasDocuments && chatShown && (
          <SplitHandle
            className="left-0 -translate-x-1/2"
            defaultWidth={AGENT_PANE_WIDTH.default}
            label="Resize Agent pane"
            max={AGENT_PANE_WIDTH.max}
            min={AGENT_PANE_WIDTH.min}
            onWidthChange={onPaneWidthChange}
            pane="right"
            width={paneWidth}
          />
        )}
        <motion.div
          animate={{ width: agentBoxWidth }}
          className={cn(
            'ml-auto h-full overflow-hidden bg-surface-2',
            // The rule is the seam. It rides the sweep in both directions and
            // rests only once the Agent has the row.
            (agentWidth !== null || settling) && 'border-l border-border',
          )}
          data-testid="agent-pane"
          initial={false}
          transition={boxTransition}
        >
          {agent}
        </motion.div>
      </div>
    </div>
  );
}
