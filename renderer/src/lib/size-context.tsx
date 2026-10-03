/** The size ladder: two steps, and every measurement that steps with them.
 *
 *  Density is not one number. A control's height, its type size, its padding,
 *  the gap between it and its label, the glyph inside it and the keycap beside
 *  it all move together, and when a component keeps its own two-entry map of
 *  any of those, the ladder has two definitions and they drift. So the whole
 *  step lives here as one object, and a component reads the fields it needs
 *  rather than re-deriving them from `variant`.
 *
 *  `useSize(override)` resolves explicit prop > provider > default, which is
 *  what lets one control be pinned compact inside an otherwise default
 *  surface without the surface knowing. */

'use client';

import { createContext, useContext, type ReactNode } from 'react';

import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';

type SizeVariant = 'default' | 'compact';

/** The switch's track and thumb, in px. Geometry rather than classes because
 *  the thumb is animated by a motion value: a spring retargets a number, not
 *  a class name. */
interface SwitchGeometry {
  trackWidth: number;
  trackHeight: number;
  thumbSize: number;
  /** How far the thumb stretches into a pill on hover. */
  pillExtend: number;
  /** How far it stretches, and how far it squashes, while pressed. */
  pressExtend: number;
  pressShrink: number;
}

interface SizeClasses {
  /** The variant these classes belong to — handy for conditionals. */
  variant: SizeVariant;
  /** Bounded control height — buttons, inputs, select triggers, subtle tabs —
   *  AND list/menu rows (select options, dropdown, checkbox and radio rows).
   *  One token by design: a popup row lines up with the trigger that opened
   *  it because they share this height. */
  control: string;
  /** `control` as a number, for consumers that need raw pixels. */
  controlHeight: number;
  /** Tab trigger height inside a padded segmented list. Sized so
   *  `segmentPad` + `segmentItem` adds back up to the control height —
   *  the segmented control's outer box stays on the same ladder. */
  segmentItem: string;
  /** A glyph-only segment's width on a track. Wider than `segmentItem` is
   *  tall, so the lifted pill reads as a pill and not a square — and at the
   *  compact step wide enough that the track's own `gap-0.5` carries it to
   *  the 32px glyph pitch the sidebar's band and the Chat header's actions
   *  both keep, so every toolbar in the window runs at one pitch. The
   *  sidebar's mode switch used to spell that width out on each item. */
  segmentGlyphWidth: string;
  /** Padding of the segmented list around its tabs. */
  segmentPad: string;
  /** The segment's own corner. It is the shortest box a highlight lands on —
   *  24px at the compact step — so it cannot borrow `shape.bg`, whose 12 is
   *  exactly half that height and would clamp the segment into a capsule. A
   *  slider's item is a pill only in being wider than tall; its corners stay
   *  corners. */
  segmentRadius: string;
  /** Body text inside controls. Mirrors `--fs-body` in globals.css, which
   *  `lib/tokens.test.ts` holds to this value. */
  text: string;
  /** The query field of a command palette: taller than `control` and a step
   *  above `text`, because the palette's input is the one control on its own
   *  surface and reads as the thing being typed into rather than as a field in
   *  a form. It is on the ladder rather than a literal in the palette so a
   *  compact palette is actually denser instead of only its rows being. */
  prompt: string;
  promptText: string;
  /** The step below `text`: secondary copy, section labels, tooltip text, a
   *  field's error line, the badge label. A component that spelled this out
   *  as its own `compact ? 11 : 12` pair had a second copy of the ladder.
   *  Mirrors `--fs-caption` in globals.css. */
  caption: string;
  /** Horizontal padding of bounded controls (select trigger, inputs). */
  px: string;
  /** Horizontal padding of list/menu rows, which sit inside a padded popup
   *  or group and need less inset than a bounded control. */
  itemPx: string;
  /** Gap between an icon / control glyph and its label, and between
   *  neighbouring controls in a row (toolbars, filter bars, button
   *  clusters). Density is spacing as much as control height, so the
   *  compact step halves it. */
  gap: string;
  /** Glyph size in px: leading/trailing icons inside controls, and the
   *  checkbox square / radio circle. */
  icon: number;
  /** The keycap chip (`⌘K`, `Tab`): its own height and type step. Far below
   *  the control height — a chip that tall would read as a button — but still
   *  a step of this ladder, so it is written here with the rest of it rather
   *  than as a second variant map inside the component. */
  keycap: string;
  /** A button's horizontal padding and icon-to-label gap. A button is wider
   *  around its label than a bounded input is around its value, so it does
   *  not reuse `px`/`gap`; the height and type step it DOES share come from
   *  `control` and `text`. */
  buttonPx: string;
  buttonGap: string;
  /** The corner a bounded control draws. On the ladder rather than in the
   *  shape map because a radius belongs to the size of the box: the same
   *  number that reads generous on the 36px control is half the height of the
   *  28px one, where it would turn an icon-only button into a circle. */
  radius: string;
  /** A square control's box — an icon-only button, the loading spinner that
   *  has to fill the same box. Written out rather than derived from `control`
   *  so the class names stay literal and Tailwind can see them. */
  square: string;
  /** The glyph inside a square control, as a descendant rule so it reaches an
   *  icon the caller passed as a child. */
  squareGlyph: string;
  /** Descendant controls pulled one notch BELOW this step, for a row whose
   *  content is consumer-authored and already sized (a composer's action
   *  footer). The `w-7` it corrects is `square` at the compact step, which is
   *  why the correction belongs beside it rather than in the row. */
  nestedControl: string;
  /** The badge's box. Its label takes `caption`, like every other small
   *  label on the ladder. */
  badge: string;
  /** The badge's leading dot, in px. */
  badgeDot: number;
  /** The toggle switch's track and thumb. */
  switchGeometry: SwitchGeometry;
}

const sizeMap: Record<SizeVariant, SizeClasses> = {
  // 36px — the default control height. Matches a 13px label with comfortable
  // breathing room and keeps controls a workable pointer target.
  default: {
    variant: 'default',
    control: 'h-9',
    controlHeight: 36,
    segmentItem: 'h-7',
    segmentGlyphWidth: 'w-8',
    segmentPad: 'p-1',
    segmentRadius: 'rounded-lg',
    text: 'text-ui-13',
    prompt: 'h-12',
    promptText: 'text-ui-15',
    caption: 'text-ui-12',
    px: 'px-3',
    itemPx: 'px-2',
    gap: 'gap-2',
    icon: 16,
    keycap: 'h-[18px] px-1 text-ui-11',
    buttonPx: 'px-4',
    buttonGap: 'gap-1.5',
    radius: 'rounded-xl',
    square: 'h-9 w-9',
    squareGlyph: '[&_svg]:h-4 [&_svg]:w-4',
    nestedControl: '',
    badge: 'h-6 gap-1.5 px-2.5',
    badgeDot: 7,
    switchGeometry: {
      trackWidth: 34,
      trackHeight: 20,
      thumbSize: 16,
      pillExtend: 2,
      pressExtend: 4,
      pressShrink: 4,
    },
  },
  // 28px — the compact height for dense surfaces: filter bars, toolbars,
  // table headers, sidebars. One step down in icon (14px) and the label at
  // the same 13px the default step reads: a row about twice its type is
  // the density a chat client's sidebar keeps, and the label is what is
  // read, so the box shrinks around it rather than with it.
  compact: {
    variant: 'compact',
    control: 'h-7',
    controlHeight: 28,
    segmentItem: 'h-6',
    segmentGlyphWidth: 'w-[30px]',
    segmentPad: 'p-0.5',
    segmentRadius: 'rounded-md',
    text: 'text-ui-13',
    prompt: 'h-10',
    promptText: 'text-ui-14',
    caption: 'text-ui-11',
    px: 'px-2.5',
    itemPx: 'px-1.5',
    gap: 'gap-1',
    icon: 14,
    keycap: 'h-4 px-1 text-ui-10',
    buttonPx: 'px-3',
    buttonGap: 'gap-1',
    radius: 'rounded-lg',
    square: 'h-7 w-7',
    squareGlyph: '[&_svg]:h-3.5 [&_svg]:w-3.5',
    nestedControl: '[&_button]:h-6 [&_button]:text-ui-11 [&_button.w-7]:w-6',
    badge: 'h-5 gap-1 px-2',
    badgeDot: 6,
    switchGeometry: {
      trackWidth: 28,
      trackHeight: 16,
      thumbSize: 12,
      pillExtend: 2,
      pressExtend: 3,
      pressShrink: 3,
    },
  },
};

/** Just the step. The provider used to publish a `setSize` alongside it and a
 *  piece of internal state for it to write, but the context is not exported
 *  and no hook hands the setter back, so nothing outside this module could
 *  ever call it — which also made the uncontrolled `defaultSize` a value
 *  nothing could change. A region's step is set by the caller that pins it. */
const SizeContext = createContext<SizeVariant | null>(null);

/** Resolve the active size variant: explicit prop > provider > "default".
 *
 *  The context is read unconditionally. Resolving it inside the `??` chain
 *  made `useContext` run only when `override` was nullish, so a control that
 *  gained or lost an explicit `size` between renders changed the number of
 *  hooks it called and React threw on the next commit. */
function useSizeVariant(override?: SizeVariant | null): SizeVariant {
  const inherited = useContext(SizeContext);
  return override ?? inherited ?? 'default';
}

/** Resolve size classes: explicit prop > provider > "default". */
function useSize(override?: SizeVariant | null): SizeClasses {
  return sizeMap[useSizeVariant(override)];
}

/** Publishes the document's step to plain CSS as `html[data-size]`, which is
 *  where the `--fs-*` type-scale roles in globals.css (`text-body`,
 *  `text-caption`, …) read it from. Only the OUTERMOST provider stamps: a
 *  region pinned compact inside a default surface is exactly the case the
 *  ladder exists for, and letting it rewrite the root would drag the whole
 *  document's chrome down with it. So the root provider decides the document
 *  step and a nested one decides only its own subtree — chrome utilities
 *  follow the former, ladder-aware components the latter.
 *
 *  Layout effect rather than an effect: the attribute lands before paint, so
 *  the first frame is never drawn one step off. */
function useDocumentSize(size: SizeVariant, isRoot: boolean): void {
  useIsoLayoutEffect(() => {
    if (!isRoot) return;
    const root = document.documentElement;
    const previous = root.dataset.size;
    root.dataset.size = size;
    return () => {
      if (previous === undefined) delete root.dataset.size;
      else root.dataset.size = previous;
    };
  }, [isRoot, size]);
}

function SizeProvider({
  children,
  size,
}: {
  children: ReactNode;
  /** Pins a whole region to one step (e.g. a compact filter bar). Every
   *  ladder-aware control inside follows it unless it pins itself. */
  size: SizeVariant;
}) {
  useDocumentSize(size, useContext(SizeContext) === null);
  return <SizeContext.Provider value={size}>{children}</SizeContext.Provider>;
}

export { SizeProvider, sizeMap, useSize, useSizeVariant };
export type { SizeVariant };
