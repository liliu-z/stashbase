import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge's default config has no notion of this project's type-scale
// utilities (text-display/title/subtitle/body/caption, defined via `@utility`
// in globals.css). Without this extension it buckets any of them into the
// same conflict group as text-color utilities (text-foreground,
// text-muted-foreground, text-destructive, ...) purely because both start
// with `text-`, so `cn('text-caption', 'text-muted-foreground')` silently
// drops one of the two — the element falls back to the browser's default
// font size while looking like it has a color class. Registering them as
// their own `font-size` group entries keeps them deduplicating against each
// other and against stock sizes (text-sm, text-lg, ...) while no longer
// colliding with color utilities.
// The motion steps (`duration-fast/base/slow` and `delay-fast/base/slow`,
// defined via `@utility` in globals.css) need the same treatment for the
// opposite reason: tailwind-merge recognises `duration-*` and `delay-*` only
// when the suffix is a number or an arbitrary value, so without this it treats
// the named steps as unknown classes and `cn('duration-fast', 'duration-<n>')`
// would emit both.
// `text-ui-<px>` (the interface-scaled sizes) joins the same font-size group.
const isInteger = (value: string) => /^\d+$/u.test(value);

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        { text: ['display', 'title', 'subtitle', 'body', 'caption', { ui: [isInteger] }] },
      ],
      duration: [{ duration: ['fast', 'base', 'slow'] }],
      delay: [{ delay: ['fast', 'base', 'slow'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
