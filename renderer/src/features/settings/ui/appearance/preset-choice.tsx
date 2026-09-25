import { useId } from 'react';

import { FOCUS_RING_TINT } from '@/lib/focus-ring';
import { useShape } from '@/lib/shape-context';
import { useSize } from '@/lib/size-context';
import { surfaceBackground } from '@/lib/surface-classes';
import { useSurface } from '@/lib/surface-context';
import { cn } from '@/lib/utils';

interface PresetOption {
  /** A face to set the label in, so a font preset can show itself. */
  readonly fontFamily?: string;
  readonly label: string;
  readonly value: string;
}

export interface PresetChoiceProps {
  readonly choices: readonly PresetOption[];
  /** The read has not answered yet, so there is no preset to move. */
  readonly disabled?: boolean;
  /** Stretch to the container with equal segments, so stacked pickers with
   *  different preset counts line up as one column. */
  readonly fill?: boolean;
  readonly label: string;
  readonly value: string | null;
  onChoose(value: string): void;
}

/**
 * A segmented preset picker: one bordered track with the chosen preset drawn
 * as a lifted pill: the surface three steps up and no shadow, the same lift
 * the segmented tabs use, so one idiom draws both.
 *
 * Native radios rather than a tablist, so arrow-key navigation, the single
 * roving tab stop and the group semantics come from the platform. They are
 * grouped by their shared `name`, which is why the instance generates one.
 *
 * The group is named from the row's own title rather than from a `<legend>`:
 * the Settings row already renders that title beside the control, and one
 * visible label doing both jobs beats a second copy of the string that can
 * drift out of step with it.
 */
export function PresetChoice({
  choices,
  disabled = false,
  fill = false,
  label,
  onChoose,
  value,
}: PresetChoiceProps) {
  const name = useId();
  const shape = useShape();
  const size = useSize();
  const pill = surfaceBackground(Math.min(useSurface() + 3, 8));

  return (
    <fieldset
      aria-label={label}
      className={cn(
        'm-0 items-center border-0 bg-muted p-0 select-none',
        fill ? 'flex w-full' : 'inline-flex',
        shape.container,
        size.segmentPad,
        disabled && 'opacity-60',
      )}
      disabled={disabled}
      role="radiogroup"
    >
      {choices.map((choice) => {
        const selected = choice.value === value;
        return (
          <label
            className={cn(
              'relative flex items-center px-3 transition-colors duration-fast',
              fill && 'flex-1 justify-center',
              disabled ? 'cursor-default' : 'cursor-pointer',
              shape.bg,
              size.segmentItem,
              size.gap,
              size.text,
              selected ? cn(pill, 'text-foreground') : 'text-muted-foreground',
              FOCUS_RING_TINT,
              'has-[:focus-visible]:ring-1',
            )}
            key={choice.value}
            style={choice.fontFamily ? { fontFamily: choice.fontFamily } : undefined}
          >
            <input
              checked={selected}
              className="sr-only"
              name={name}
              onChange={() => onChoose(choice.value)}
              type="radio"
              value={choice.value}
            />
            {choice.label}
          </label>
        );
      })}
    </fieldset>
  );
}
