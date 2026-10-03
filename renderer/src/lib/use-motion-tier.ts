/** Resolving a motion tier against the viewer's reduced-motion preference.
 *
 *  Every animated primitive here used to spell the same conditional out for
 *  itself — `reduceMotion ? { duration: 0 } : tier` — once per animated
 *  property, which meant the answer to "does this respect the setting" was a
 *  count of ternaries rather than a rule. `useMotionTier` is that rule: hand it
 *  the transition the component wants and it hands back the one it should use.
 *
 *  `instant` is the resolved value, exported for the cases where a component
 *  has a second reason to skip the travel (a row that moved under a settled
 *  overlay, a panel opening at mount) and needs to name the same landing. */
'use client';

import { useReducedMotionConfig } from 'framer-motion';

/** Land on the target with no travel. */
export const instant = { duration: 0 } as const;

type Instant = typeof instant;

/**
 * `tier`, or `instant` when the viewer asked for reduced motion.
 *
 * Safe to call several times in one component: it reads a media query, so a
 * component resolving an entry tier, its exit, and a hover tier calls it three
 * times rather than threading a boolean through its own render.
 */
export function useMotionTier<T extends object>(tier: T): T | Instant {
  return (useReducedMotionConfig() ?? false) ? instant : tier;
}
