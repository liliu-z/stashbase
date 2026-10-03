import { useReducedMotionConfig } from 'framer-motion';
import { useEffect, useState } from 'react';

import { ambient } from '@/lib/springs';

/**
 * The prompt a blank composer shows right now, cycling through `prompts` at
 * the ambient reading cadence. `paused` holds the current one still, because
 * a placeholder must not change under a caret or a pointer. Reduced motion
 * shows the first prompt and never cycles. Null when there is nothing to
 * show.
 */
export function useRotatingPrompt(prompts: readonly string[], paused: boolean): string | null {
  const reduceMotion = useReducedMotionConfig() ?? false;
  const [index, setIndex] = useState(0);
  const count = prompts.length;

  useEffect(() => {
    if (paused || reduceMotion || count < 2) return;
    const timer = setInterval(
      () => setIndex((current) => (current + 1) % count),
      ambient.labelCycleMs,
    );
    return () => clearInterval(timer);
  }, [count, paused, reduceMotion]);

  if (count === 0) return null;
  return prompts[reduceMotion ? 0 : index % count] ?? null;
}
