'use client';

import { motion, AnimatePresence, useReducedMotionConfig } from 'framer-motion';
import { forwardRef, useState, useEffect, type HTMLAttributes } from 'react';

import { fontWeights } from '@/lib/font-weight';
import { useSize, type SizeVariant } from '@/lib/size-context';
import { ambient, tween } from '@/lib/springs';
import { cn } from '@/lib/utils';

const circleA =
  'M 12 8 C 14.21 8 16 9.79 16 12 C 16 14.21 14.21 16 12 16 C 9.79 16 8 14.21 8 12 C 8 9.79 9.79 8 12 8 Z';

const infinity =
  'M 12 12 C 14 8.5 19 8.5 19 12 C 19 15.5 14 15.5 12 12 C 10 8.5 5 8.5 5 12 C 5 15.5 10 15.5 12 12 Z';

const circleB =
  'M 12 16 C 14.21 16 16 14.21 16 12 C 16 9.79 14.21 8 12 8 C 9.79 8 8 9.79 8 12 C 8 14.21 9.79 16 12 16 Z';

const words = ['Thinking', 'Moonwalking', 'Planning', 'Refining'];

interface ThinkingIndicatorProps extends HTMLAttributes<HTMLDivElement> {
  /** Show the morphing circle⇄infinity glyph before the label. Set to `false`
   *  for a text-only indicator (e.g. inline before a streamed reply). */
  showIcon?: boolean;
  /** Step on the size ladder. Wins over the surrounding SizeProvider. */
  size?: SizeVariant;
}

const ThinkingIndicator = forwardRef<HTMLDivElement, ThinkingIndicatorProps>(
  ({ className, showIcon = true, size, ...props }, ref) => {
    const sizeClasses = useSize(size);
    const compactStep = sizeClasses.variant === 'compact';
    const [index, setIndex] = useState(0);
    // Reduced motion drops the infinite glyph morph and the word cycling — a
    // static glyph and label carry the same meaning without the movement.
    const reduceMotion = useReducedMotionConfig() ?? false;

    useEffect(() => {
      if (reduceMotion) return;
      const interval = setInterval(() => {
        setIndex((i) => (i + 1) % words.length);
      }, ambient.labelCycleMs);
      return () => clearInterval(interval);
    }, [reduceMotion]);

    return (
      <div
        ref={ref}
        role="status"
        className={cn('flex items-center gap-2 px-3 py-2', className)}
        {...props}
      >
        {/* Static announcement — the cycling word display below is aria-hidden
          so screen readers hear one "Thinking…" instead of a re-announcement
          every time the word changes. */}
        <span className="sr-only">Thinking…</span>
        {showIcon && (
          <motion.svg
            aria-hidden
            width={compactStep ? 18 : 20}
            height={compactStep ? 18 : 20}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-muted-foreground"
          >
            {reduceMotion ? (
              <path d={infinity} />
            ) : (
              <motion.path
                d={circleA}
                initial={{ d: circleA }}
                animate={{
                  d: [circleA, infinity, circleB, infinity, circleA],
                }}
                transition={{
                  d: {
                    duration: ambient.glyphMorphSeconds,
                    ease: 'easeInOut',
                    repeat: Infinity,
                    times: [0, 0.25, 0.5, 0.75, 1.0],
                  },
                }}
              />
            )}
          </motion.svg>
        )}
        <span
          aria-hidden="true"
          className={cn('inline-grid overflow-hidden', sizeClasses.text)}
          style={{ fontVariationSettings: fontWeights.medium }}
        >
          <span className="shimmer-text invisible col-start-1 row-start-1">
            {words.reduce((a, b) => (a.length >= b.length ? a : b))}
          </span>
          {reduceMotion ? (
            <span className="shimmer-text col-start-1 row-start-1">{words[0]}</span>
          ) : (
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={words[index]}
                className="shimmer-text col-start-1 row-start-1"
                initial={{ y: '80%', opacity: 0 }}
                animate={{
                  y: 0,
                  opacity: 1,
                  transition: { ...tween.slow, ease: [0.4, 0, 0.2, 1] },
                }}
                exit={{
                  y: '-80%',
                  opacity: 0,
                  transition: { ...tween.base, ease: [0.4, 0, 0.2, 1] },
                }}
              >
                {words[index]}
              </motion.span>
            </AnimatePresence>
          )}
        </span>
      </div>
    );
  },
);

ThinkingIndicator.displayName = 'ThinkingIndicator';

export { ThinkingIndicator };
