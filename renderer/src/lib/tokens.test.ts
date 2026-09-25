/** Holds the two spellings of the same token together.
 *
 *  Three ladders are written twice: once in TypeScript, where components read
 *  them, and once in `globals.css`, where plain CSS and the class-driven
 *  utilities read them. Motion steps are `springs.ts` and `--motion-*`; the
 *  input radius is `shape-context.ts` and `--shape-input-radius`; the type
 *  steps are `size-context.tsx` and `--fs-*`. Until now the only thing keeping
 *  the pairs equal was a comment on each side asking a reader to remember, and
 *  a drift would surface as a class transition landing a frame off a spring,
 *  or a focus ring whose corners miss the field's.
 *
 *  So the CSS is parsed and compared. The declarations are read out of the
 *  block each one actually lives in rather than by first match, because the
 *  reduced-motion media query re-declares the motion steps as 1ms and the
 *  compact step re-declares every `--fs-*`.
 *
 *  The focus ring is the fourth pair and the odd one: the TypeScript side is
 *  a literal colour rather than a step, kept as the fallback a copied
 *  primitive draws with. A fallback that stopped matching the token would be
 *  invisible until someone removed the token.
 *
 *  The Appearance preferences are the fifth: `--ui-scale` and
 *  `--reading-font-size` have no TypeScript ladder, so what is held here is
 *  the shape of the CSS — the multiplier on every type step, its absence from
 *  the reading step, and the two scopes keyed on the attributes
 *  shared/runtime/appearance-surface.ts stamps. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

import { FOCUS_RING_FALLBACK } from '@/lib/focus-ring';
import { shapeTokens } from '@/lib/shape-context';
import { sizeMap, type SizeVariant } from '@/lib/size-context';
import { stepMs } from '@/lib/springs';

const stylesheet = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../globals.css'),
  'utf8',
);

/** The declaration block that contains `marker` — a declaration unique to the
 *  block being asked for. Both ends are brace-matched: scanning backwards past
 *  a closed sibling rule would otherwise mistake that rule's opening brace for
 *  this block's, and a nested rule inside would otherwise end it early. */
function blockContaining(marker: string): string {
  const at = stylesheet.indexOf(marker);
  expect(at, `globals.css declares ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  let open = -1;
  for (let index = at; index >= 0; index -= 1) {
    if (stylesheet[index] === '}') depth += 1;
    else if (stylesheet[index] === '{') {
      if (depth === 0) {
        open = index;
        break;
      }
      depth -= 1;
    }
  }
  expect(open, `${marker} sits inside a declaration block`).toBeGreaterThan(-1);
  depth = 0;
  for (let index = open; index < stylesheet.length; index += 1) {
    if (stylesheet[index] === '{') depth += 1;
    else if (stylesheet[index] === '}') {
      depth -= 1;
      if (depth === 0) return stylesheet.slice(open + 1, index);
    }
  }
  throw new Error(`unterminated block around ${marker}`);
}

/** The base number of a type step, which is declared as
 *  `calc(<base>px * var(--ui-scale))` so the interface-size preference
 *  multiplies each step where the step is written. Anchored to that one shape
 *  and nothing wider: `calc(13px + 2px)` has to read as malformed rather than
 *  answer 13, or the reader would launder any arithmetic into a parity pass. */
function scaledPx(block: string, name: string): number | null {
  const scaled = `${name}:\\s*calc\\(\\s*(-?[\\d.]+)px\\s*\\*\\s*var\\(--ui-scale\\)\\s*\\)\\s*;`;
  const match = new RegExp(scaled).exec(block);
  return match ? Number(match[1]) : null;
}

/** A custom property's value, in the numeric unit it is declared with, whether
 *  it is written bare or scaled by `--ui-scale`. */
function customProperty(block: string, name: string): number {
  const bare = new RegExp(`${name}:\\s*(-?[\\d.]+)(ms|px)\\s*;`).exec(block);
  if (bare) return Number(bare[1]);
  const scaled = scaledPx(block, name);
  expect(scaled, `${name} is declared as a bare ms/px value or a scaled px`).not.toBeNull();
  return Number(scaled);
}

/** The pixel size a `text-[13px]` ladder class stands for. */
function ladderPx(className: string): number {
  const match = /^text-\[(\d+)px\]$/.exec(className);
  expect(match, `${className} is an arbitrary px type step`).not.toBeNull();
  return Number(match?.[1]);
}

describe('motion steps', () => {
  const motion = blockContaining('--motion-fast:');

  it.each([
    ['fast', '--motion-fast'],
    ['base', '--motion-base'],
    ['slow', '--motion-slow'],
  ] as const)('publishes the %s step to CSS unchanged', (step, property) => {
    expect(customProperty(motion, property)).toBe(stepMs[step]);
  });

  it('zeroes every step under the reduced-motion query', () => {
    // Not a parity check but the other half of the contract: a step that
    // gained a CSS spelling without a reduced-motion counterpart would keep
    // animating for a viewer who asked it not to.
    const reduced = blockContaining('--motion-fast: 1ms');
    for (const property of ['--motion-fast', '--motion-base', '--motion-slow']) {
      expect(customProperty(reduced, property)).toBe(1);
    }
  });
});

describe('shape', () => {
  it('publishes the input radius to CSS unchanged', () => {
    const radius = customProperty(blockContaining('--shape-input-radius:'), '--shape-input-radius');
    expect(radius).toBe(shapeTokens.bgRadius);
    expect(radius).toBe(shapeTokens.mergedRadius);
  });

  // The pane card's radius rides a `peer-data-*` variant, so it cannot be
  // composed from `shapeTokens.card` — Tailwind scans source for whole
  // class names and would never emit one built by concatenation. The class is
  // therefore written out, and this is what keeps the copy honest.
  it('holds the pane card literal equal to the card role', () => {
    const source = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../components/ui/sidebar-sections.tsx',
      ),
      'utf8',
    );
    const literal = source.match(/peer-data-\[variant=inset\]:(rounded-\[?[\w.]+\]?)/u)?.[1];
    expect(literal).toBe(shapeTokens.card);
  });
});

describe('focus ring', () => {
  it('gives the copied-primitive fallback the same colour as the token', () => {
    const declared = /--focus-ring:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(stylesheet)?.[1];
    const fallback = /#[0-9a-fA-F]{3,8}/.exec(FOCUS_RING_FALLBACK)?.[0];
    expect(declared, 'globals.css declares --focus-ring as a hex colour').toBeDefined();
    expect(fallback, 'lib/focus-ring.ts writes the fallback as a hex colour').toBeDefined();
    expect(fallback?.toLowerCase()).toBe(declared?.toLowerCase());
  });
});

describe('type steps', () => {
  // Keyed on the display step, the one size the two blocks never share:
  // both steps read the same 13px body, so a body locator would find the
  // root block twice over.
  const scopes: Record<SizeVariant, string> = {
    default: blockContaining('--fs-display: calc(22px'),
    compact: blockContaining('--fs-display: calc(20px'),
  };

  it('keys the compact scope on the attribute SizeProvider stamps', () => {
    // The compact `--fs-*` block is only reachable because lib/size-context's
    // outermost provider writes `data-size` on <html>. If either side renames
    // its half, `text-caption` silently stops following `sizeClasses.caption`
    // and every row below still passes.
    expect(stylesheet).toContain("html[data-size='compact']");
    const provider = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'size-context.tsx'),
      'utf8',
    );
    expect(provider).toContain('root.dataset.size = size');
  });

  it.each(['default', 'compact'] as const)('publishes the %s body step to CSS', (variant) => {
    expect(customProperty(scopes[variant], '--fs-body')).toBe(ladderPx(sizeMap[variant].text));
  });

  it.each(['default', 'compact'] as const)('publishes the %s caption step to CSS', (variant) => {
    expect(customProperty(scopes[variant], '--fs-caption')).toBe(
      ladderPx(sizeMap[variant].caption),
    );
  });

  it('keeps caption a notch under text, and one body size across both steps', () => {
    // The pairs above would still pass if `text` and `caption` were equal;
    // within a step the ladder is a ladder because they differ. Across the
    // steps the body is shared on purpose: the label is what is read, and
    // the compact box shrinks around it (the sidebar's 28px row keeps the
    // same 13px label the default row does), so only caption steps down.
    for (const variant of ['default', 'compact'] as const) {
      expect(ladderPx(sizeMap[variant].text)).toBeGreaterThan(ladderPx(sizeMap[variant].caption));
    }
    expect(ladderPx(sizeMap.default.text)).toBe(ladderPx(sizeMap.compact.text));
    expect(ladderPx(sizeMap.default.caption)).toBeGreaterThan(ladderPx(sizeMap.compact.caption));
  });

  it('scales every declared step by the interface-size preference', () => {
    // A step declared bare would render at the same size whatever the reader
    // picked in Appearance, and every parity row above would still pass
    // because the base number is the only part they read.
    const declared = [...stylesheet.matchAll(/^[ \t]*--fs-[a-z-]+:[^;]*;/gm)].map((one) => one[0]);
    expect(declared.length, 'globals.css declares the whole ladder').toBeGreaterThanOrEqual(9);
    for (const declaration of declared) expect(declaration).toContain('* var(--ui-scale)');
  });
});

describe('appearance preferences', () => {
  it('keeps the reading step out of the interface-size multiplier', () => {
    // Interface size moves chrome type only. A reading declaration that
    // picked up `--ui-scale` would enlarge prose along with the furniture,
    // and the two preferences would stop being separable at all.
    const declared = [...stylesheet.matchAll(/^[ \t]*--reading-font-size:[^;]*;/gm)];
    expect(declared, 'globals.css declares a default and both steps per reading font').toHaveLength(
      6,
    );
    for (const [declaration] of declared) {
      expect(declaration).not.toContain('--ui-scale');
      expect(declaration.trim()).toMatch(/^--reading-font-size: \d+px;$/);
    }
  });

  it('keys both scopes on the attributes the applier stamps', () => {
    // The same pairing the compact scope needs: these blocks are reachable
    // only through what shared/runtime/appearance-surface.ts writes on <html>,
    // and a rename on either side leaves both halves valid CSS and valid
    // TypeScript with the preference silently inert.
    expect(stylesheet).toContain("html[data-ui-scale='small']");
    expect(stylesheet).toContain("html[data-ui-scale='large']");
    expect(stylesheet).toContain("html[data-reading-text-size='small']");
    expect(stylesheet).toContain("html[data-reading-text-size='large']");
    expect(stylesheet).toContain("html[data-reading-font='serif']");
    const applier = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../shared/runtime/appearance-surface.ts',
      ),
      'utf8',
    );
    expect(applier).toContain('root.dataset.uiScale = surface.uiScale');
    expect(applier).toContain('root.dataset.readingTextSize = surface.readingTextSize');
    expect(applier).toContain('root.dataset.readingFont = surface.readingFont');
  });
});
