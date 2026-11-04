/** The motion tokens every renderer animation reads. Three entry steps, the
 *  matching exit steps, and the three spring tiers built from them. Written
 *  once here and published to CSS as `--motion-fast/base/slow` (globals.css),
 *  so a class-driven transition and a framer one meeting on the same element
 *  land together; `tokens.test.ts` reads both files and fails when the two
 *  spellings disagree. Nothing outside this module writes a duration
 *  literal. */

/** Entry steps, in seconds. */
const step = {
  /** Sub-perceptual: an acknowledgement mark, not a movement. */
  snap: 0.04,
  fast: 0.08,
  base: 0.16,
  slow: 0.24,
} as const;

/** Exit steps, in seconds. An exit runs shorter than the entry that opened
 *  it: the element is already understood, so leaving should not be waited on. */
const exitStep = {
  fast: 0.06,
  base: 0.12,
  slow: step.base,
} as const;

/** The steps as framer transitions, for motion that is NOT a spring: an
 *  opacity cross-fade riding alongside one, a colour swap, a filter. */
export const tween = {
  snap: { duration: step.snap },
  fast: { duration: step.fast },
  base: { duration: step.base },
  slow: { duration: step.slow },
} as const;

/** The exit steps as framer transitions, for the fade half of a leaving
 *  element — the spring tiers below carry their own `exit` for the movement. */
export const exitTween = {
  fast: { duration: exitStep.fast },
  base: { duration: exitStep.base },
  slow: { duration: exitStep.slow },
} as const;

/** Expand and collapse: the one travel in this kit that is NOT a spring.
 *  A region's size is a box of space opening and closing, not an object
 *  arriving, and a spring's launch reads as a shove when what it displaces is
 *  every row below it or the whole column beside it. What it takes instead is
 *  a symmetric ease: the same shape entering and leaving, because opening and
 *  closing are one reversible state rather than two events.
 *
 *  Its own steps, one rung above the interaction ladder. A hover tint or a
 *  dropdown is read once it lands, so it should get there; a region opening is
 *  read WHILE it travels, because what the eye follows is the rows arriving
 *  and the content below them making way, and at the ladder's pace that
 *  arrival is over before it has been seen.
 *
 *  The numbers are the host platform's, since this is a desktop app whose
 *  windows sit beside Finder's: `0.25` is what AppKit animates in by default
 *  (`NSAnimationContext`, and Core Animation's implicit transactions), `0.35`
 *  is SwiftUI's default for `.easeInOut`, and the curve is Core Animation's
 *  `kCAMediaTimingFunctionEaseInEaseOut` exactly. A symmetric ease costs a
 *  slow first few pixels, which is the trade the platform already made and
 *  which the longer steps absorb.
 *
 *  These do NOT shorten on the way out, which is the one place the collapse
 *  steps part company with the spring tiers above. A leaving OBJECT is already
 *  understood and should not be waited on, so its exit runs short; a region is
 *  not an object, and AppKit closes one over exactly the length it opened it.
 *  A sidebar that shuts faster than it opened reads as two different controls
 *  rather than one reversible state.
 *
 *  Shaped like a spring tier — a transition carrying its own `exit` — so a
 *  collapse reads `collapseTween[tier]` exactly where it read `spring[tier]`,
 *  and `exitFallbackMs` has a duration to derive from. It is the same step,
 *  named twice rather than measured twice. */
const collapseEase: [number, number, number, number] = [0.42, 0, 0.58, 1];

/** In seconds. `moderate` is a region inside a pane and takes AppKit's default;
 *  `slow` is a whole column or a pane-wide seam crossing the card, which
 *  travels further and so takes the longer step rather than the same one at a
 *  higher speed. Two numbers, and both directions of both tiers read them. */
const collapseStep = {
  moderate: 0.25,
  slow: 0.35,
} as const;

export const collapseTween = {
  moderate: {
    type: 'tween' as const,
    duration: collapseStep.moderate,
    ease: collapseEase,
    exit: { type: 'tween' as const, duration: collapseStep.moderate, ease: collapseEase },
  },
  /** A whole column or the seam between two panes: the sidebar's width, the
   *  Agent/document split, and a box opening space for content that has just
   *  arrived, where the travel is the arrival. */
  slow: {
    type: 'tween' as const,
    duration: collapseStep.slow,
    ease: collapseEase,
    exit: { type: 'tween' as const, duration: collapseStep.slow, ease: collapseEase },
  },
} as const;

export const spring = {
  fast: {
    type: 'spring' as const,
    duration: step.fast,
    bounce: 0,
    exit: exitTween.fast,
  },
  // Critically damped: same perceived speed as a bouncier tier, but lands
  // exactly with no overshoot — for short travel and panels/sheets that must
  // settle precisely (dropdowns, tabs, drawers, merged selection backgrounds).
  moderate: {
    type: 'spring' as const,
    duration: step.base,
    bounce: 0,
    exit: exitTween.base,
  },
  slow: {
    type: 'spring' as const,
    duration: step.slow,
    bounce: 0.12,
    exit: exitTween.slow,
  },
} as const;

/** The entry steps as seconds, for the places that need the bare number
 *  rather than a transition object — a stagger delay on an animation whose
 *  own duration is a different step. Same numbers as `tween`, exposed so a
 *  call site never types `0.08` beside it. */
export const stepSeconds = step;

/** The entry steps as milliseconds, for the JS timers that have to land with
 *  the CSS and framer steps rather than beside them, and for the token test
 *  that reads the `--motion-*` declarations back out of globals.css. Derived
 *  from the same numbers, so a step moves in one place. */
export const stepMs = {
  snap: Math.round(step.snap * 1000),
  fast: Math.round(step.fast * 1000),
  base: Math.round(step.base * 1000),
  slow: Math.round(step.slow * 1000),
} as const;

/** The delays that are neither a transition nor a fallback, but a deliberate
 *  wait: how long a surface holds still so the user can read what it just
 *  did, and how long a hover has to mean it. Built from the steps above rather
 *  than typed as round numbers at each call site, so "how long does the app
 *  pause" has one answer to change. */
export const delayMs = {
  /** A chosen row stays visible as chosen before its popup closes, so the
   *  checkmark drawing in and the selected background springing across are
   *  seen rather than cut off by the close fade. */
  acknowledge: stepMs.slow + stepMs.fast,
  /** Hover-intent to open: long enough that a pointer crossing an edge on its
   *  way elsewhere never triggers it. */
  intent: stepMs.base,
  /** Hover-intent to dismiss: longer than opening, so crossing a gap between
   *  two affordances of the same surface does not close it. */
  dismissIntent: stepMs.slow,
  /** Hover-intent before a tooltip opens. A perception threshold rather than
   *  a multiple of a motion step: short enough to read as an answer, long
   *  enough that a pointer crossing a toolbar never flashes four labels. */
  tooltip: 200,
  /** After one tooltip closes, the window in which moving to an adjacent
   *  trigger skips the delay entirely, so a row of controls reads as one
   *  surface rather than four separate waits. */
  tooltipGroup: 300,
} as const;

/** Ambient loops: motion that runs while the app waits rather than in
 *  response to anything. These are reading times, not interaction steps —
 *  a label has to stay long enough to be read — so they are their own group
 *  rather than a multiple of the ladder above. */
export const ambient = {
  /** How long each word of a waiting label holds before the next arrives. */
  labelCycleMs: 4000,
  /** One full circle ⇄ infinity ⇄ circle morph of the thinking glyph. */
  glyphMorphSeconds: 6,
} as const;

// Fallback delay (ms) for deferred-unmount timers that guard an exit tween:
// popups keep their portal mounted until onAnimationComplete fires, but a
// throttled/background tab can stall the animation, so a timer force-unmounts
// after the tier's exit duration plus a safety buffer. Deriving it here keeps
// the timers in step with the tokens above.
export const exitFallbackMs = (tier: { exit: { duration: number } }) =>
  Math.round(tier.exit.duration * 1000) + 100;
