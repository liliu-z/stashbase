/** The StashBase mark.
 *
 *  The two colours are brand tokens (`--brand-*` in globals.css) rather than
 *  literals: the mark is only ever rendered inside the app, so it inherits the
 *  stylesheet, and keeping the values with the rest of the palette means a
 *  brand change is one edit. The background is transparent — the mark sits on
 *  whatever surface hosts it. The S edge carries the theme's ink (a
 *  light-dark() pair); only the frame gray is fixed. The strokes are weighed
 *  for the mark's one in-app size, 40px on the welcome lockup: the ink edges
 *  land at 2.5px there, the same stroke a Lucide glyph draws at that size, so
 *  the mark carries the weight of the icon system beside the medium wordmark
 *  rather than a hairline. The frame stays a step lighter, and sits inset
 *  from the cube's true edges: with the ink's corners rounded, a frame on the
 *  edge itself would poke past the S's silhouette, so it is drawn a step
 *  inside and its ends stop inside the ink's fillet tangents, which is what
 *  makes it read as the back edges seen through the box. */

import type { SVGProps } from 'react';

export interface LogoProps extends SVGProps<SVGSVGElement> {
  /** Multiplies both stroke weights for a size the lockup's were not drawn
   *  for. The mark also stands for the bundled Agent, where it paints at
   *  14px and the lockup's strokes would land under a pixel. The scale stays
   *  below 1.5: past that a stroke's half-width passes the 24-unit fillet
   *  radius, the joins stop rounding, and the frame pokes past the ink's
   *  silhouette. */
  strokeScale?: number;
}

export function Logo({ strokeScale = 1, ...props }: LogoProps) {
  return (
    <svg fill="none" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M104 210 L104 321.1 A24 24 0 0 0 116.1 342 L216.9 399.7"
        stroke="var(--brand-frame)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={24 * strokeScale}
      />
      {/* One ribbon threaded through a cube. Every turn is a circular fillet
       *  of one radius (24), the frame's corner included, so the mark rounds
       *  as one shape. The cube's acute corners (60°) take a deeper cut than
       *  its obtuse ones (120°) to reach the same radius; an equal cut would
       *  leave the acute corners visibly sharper. */}
      <path
        d="M338 111 L267.9 70.84 A24 24 0 0 0 244.1 70.84 L128.3 137.2 A24 24 0 0 0 128.3 178.8 L244.1 245.2 A24 24 0 0 0 267.9 245.2 L384.1 178.6 A24 24 0 0 1 420 199.4 L420 328.1 A24 24 0 0 1 407.9 348.9 L291.9 415.4 A24 24 0 0 1 256 394.6 L256 344"
        stroke="var(--brand-accent)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={32 * strokeScale}
      />
    </svg>
  );
}
