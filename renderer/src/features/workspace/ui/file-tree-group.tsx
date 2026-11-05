/**
 * The tree's motion: the group that opens and closes under a folder, and the
 * highlight that follows the pointer across rows or a drag across folders.
 *
 * Both are presentational. The tree hands them geometry and a settle callback
 * and never reads back from them, so nothing about focus or selection depends
 * on an animation having finished.
 */
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { useState, type ReactNode } from 'react';

import { DROP_TARGET } from '@/lib/local/drop-target';
import { collapseTween, spring, tween } from '@/lib/springs';
import { cn } from '@/lib/utils';

export interface TreeGroupProps {
  /** False for a group that stands at full height from its first frame. */
  appear: boolean;
  children: ReactNode;
  onSettle(): void;
  reduceMotion: boolean;
}

/**
 * The children of an expanded folder. The group eases open from the folder
 * row and closes back into it; while it is leaving, its rows are inert and
 * skipped by the proximity layer so nothing stale can be reached. Clipping
 * applies only while the height moves, so a row's focus ring is never shaved
 * once the group has settled.
 *
 * The height is the whole animation. A fade underneath it would say a second
 * thing — that the rows themselves are going — on top of the one thing that is
 * happening, which is the space closing; folding a branch and folding the
 * navigator's region are then the same gesture at two scales.
 */
export function TreeGroup({ appear, children, onSettle, reduceMotion }: TreeGroupProps) {
  const present = useIsPresent();
  const [moving, setMoving] = useState(false);
  return (
    <motion.div
      animate={{ height: 'auto' }}
      aria-hidden={present ? undefined : true}
      className={moving || !present ? 'overflow-hidden' : undefined}
      data-tree-exiting={present ? undefined : ''}
      exit={{
        height: 0,
        transition: reduceMotion ? { duration: 0 } : collapseTween.moderate.exit,
      }}
      inert={!present}
      initial={appear ? { height: 0 } : false}
      onAnimationComplete={() => {
        setMoving(false);
        onSettle();
      }}
      onAnimationStart={() => setMoving(true)}
      transition={reduceMotion ? { duration: 0 } : collapseTween.moderate}
    >
      {children}
    </motion.div>
  );
}

interface TreeProximityRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface TreeHighlightsProps {
  className: string;
  /** The folder a drag over the tree would land in. */
  drop: TreeProximityRect | null;
  /** The row under the pointer. */
  hover: TreeProximityRect | null;
  /** A new pointer session starts a new hover surface rather than gliding. */
  hoverKey: number;
  reduceMotion: boolean;
}

/** The tree's lit surface: the pointer's row, or, while a drag is over the
 *  tree, the folder it would land in instead. The pointer does not move rows
 *  during a drag, so its row would only be a stale second target. */
export function TreeHighlights({ drop, hover, hoverKey, ...shared }: TreeHighlightsProps) {
  return (
    <AnimatePresence>
      {drop ? (
        <TreeHighlight {...shared} key="drop" kind="drop" rect={drop} />
      ) : (
        hover && <TreeHighlight {...shared} key={hoverKey} kind="hover" rect={hover} />
      )}
    </AnimatePresence>
  );
}

interface TreeHighlightProps {
  className: string;
  kind: 'drop' | 'hover';
  rect: TreeProximityRect;
  reduceMotion: boolean;
}

/** One surface glided between rows rather than drawn per row. A drop target
 *  wears it over its whole folder, with a hairline so the region reads as one
 *  place rather than a stack of rows. */
function TreeHighlight({ className, kind, rect, reduceMotion }: TreeHighlightProps) {
  return (
    <motion.div
      animate={{ ...rect, opacity: 1 }}
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute',
        kind === 'drop' ? DROP_TARGET : 'bg-hover',
        className,
      )}
      {...(kind === 'drop' ? { 'data-tree-drop-target': '' } : { 'data-tree-proximity': '' })}
      exit={{ opacity: 0, transition: spring.fast.exit }}
      initial={{ ...rect, opacity: 0 }}
      transition={
        reduceMotion
          ? { duration: 0, opacity: tween.fast }
          : { ...spring.fast, opacity: tween.fast }
      }
    />
  );
}
