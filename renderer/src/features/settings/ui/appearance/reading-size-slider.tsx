/** Document text size as an e-reader offers it: a slider of steps between a
 *  small A and a large A. The pick lands on release, so a drag across several
 *  steps is one saved change. */
import { Slider } from '@base-ui/react/slider';
import { useState } from 'react';

import {
  DEFAULT_READING_TEXT_SIZE,
  READING_TEXT_SIZE_STEPS,
} from '@/features/settings/domain/appearance';
import type { AppearanceViewModel } from '@/features/settings/hooks/use-appearance';
import { FOCUS_RING_FALLBACK } from '@/lib/focus-ring';
import { cn } from '@/lib/utils';

const STEPS = Array.from({ length: READING_TEXT_SIZE_STEPS }, (_, index) => index + 1);

export function ReadingSizeSlider({
  appearance,
  className,
}: {
  appearance: AppearanceViewModel;
  className?: string | undefined;
}) {
  const saved = appearance.preferences?.readingTextSize ?? null;
  const [moving, setMoving] = useState<number | null>(null);
  const value = moving ?? saved ?? DEFAULT_READING_TEXT_SIZE;
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span aria-hidden="true" className="text-ui-11 leading-none text-muted-foreground">
        A
      </span>
      <Slider.Root
        className="min-w-0 flex-1"
        disabled={saved === null}
        max={READING_TEXT_SIZE_STEPS}
        min={1}
        onValueChange={(next) => setMoving(next)}
        onValueCommitted={(next) => {
          setMoving(null);
          if (next !== saved) appearance.change({ readingTextSize: next });
        }}
        step={1}
        value={value}
      >
        {/* The control is the hit area and pads the track by the thumb's
         *  radius, so the thumb and the end stops sit inside the track. */}
        <Slider.Control className="relative flex h-6 w-full cursor-pointer touch-none items-center px-(--thumb-r) select-none [--thumb-r:8px]">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted"
          />
          <Slider.Track className="relative h-1.5 w-full">
            <Slider.Indicator className="-ml-(--thumb-r) box-content h-full rounded-full bg-foreground pl-(--thumb-r)" />
            {STEPS.map((step) => (
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full',
                  step <= value ? 'bg-background/60' : 'bg-muted-foreground/45',
                )}
                key={step}
                style={{ left: `${((step - 1) / (READING_TEXT_SIZE_STEPS - 1)) * 100}%` }}
              />
            ))}
            <Slider.Thumb
              aria-label="Text size"
              className={cn(
                'size-[calc(var(--thumb-r)*2)] rounded-full bg-card shadow-sm ring-1 ring-black/10 outline-none',
                FOCUS_RING_FALLBACK,
                'has-[:focus-visible]:ring-[color:var(--focus-ring,var(--focus-ring-fallback))]',
              )}
              getAriaValueText={(_formatted, step) =>
                `${step} of ${READING_TEXT_SIZE_STEPS}${
                  step === DEFAULT_READING_TEXT_SIZE ? ', default' : ''
                }`
              }
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <span aria-hidden="true" className="text-ui-17 leading-none text-muted-foreground">
        A
      </span>
    </div>
  );
}
