/** Executes the accessibility assertion `.storybook/preview.tsx` declares.
 *
 *  The preview sets `parameters.a11y.test = 'error'`, which only means
 *  anything where a Storybook test runner is running the stories — and CI runs
 *  neither the Storybook test runner nor a browser. So the declaration was
 *  inert: a story could ship a violation and nothing would say so.
 *
 *  This file closes that gap for EVERY story in the renderer, feature stories
 *  included — a Settings panel is as much a shipped surface as a Button. Each
 *  story is mounted inside `StoryFrame`, the same stack the preview decorator
 *  mounts (the two import it from one module, so the claim is structural
 *  rather than a comment), and scored with axe over the whole body — the body
 *  rather than the render container because the overlay primitives portal
 *  their surfaces out of it. The stylesheet is imported for the same reason:
 *  several axe rules read computed visibility, and a story judged without its
 *  CSS is not the story anyone sees.
 *
 *  Each story runs once at default size in light mode. Theme, target size and
 *  contrast need a painted browser; repeating structural axe checks in
 *  happy-dom does not prove them. Each story's `play` runs first, so
 *  the state a story exists to show — a menu open, a value picked — is the
 *  state that gets scored rather than the closed shell in front of it. */
import { composeStories } from '@storybook/react-vite';
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { applyStoryTheme, StoryFrame } from '@/test/story-canvas';

import '@/globals.css';

/** The story runner scores the whole body rather than one container, so it
 *  needs its own axe context — `@/test/axe` scores an element.
 *
 *  The one suppression is `color-contrast`: happy-dom computes no layout and
 *  resolves no cascade, so every ratio it could report would be measured
 *  against colours nothing painted. Contrast is a visual-review and browser-run
 *  concern; scoring it here would produce noise, not findings.
 *
 *  The exclusion is Base UI's focus-trap sentinels. Every overlay primitive
 *  brackets its trapped subtree with `aria-hidden` spans that are deliberately
 *  in the tab order, which is exactly what `aria-hidden-focus` looks for.
 *  Assistive technology never lands on one — focus is moved past them
 *  programmatically — and they are the vendor's implementation, not a choice
 *  any story or primitive here makes. */
const BASE_RULES = { 'color-contrast': { enabled: false } } as const;
const FOCUS_GUARDS = '[data-base-ui-focus-guard]';

/** `body`, not the document: page-level rules (document-title, html-has-lang)
 *  score the harness, not the story. */
const documentContext = (exclude: string[]) => ({
  include: [['body']],
  exclude: exclude.map((selector) => [selector]),
});

const describeViolations = (results: axe.AxeResults): string[] =>
  results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.html).join(', ')})`,
  );

/**
 * Two passes, because `region` and the portals disagree about what a story is.
 *
 * The first pass scores everything in the document — portalled popups very
 * much included, since a dropdown's rows are the story — under every rule but
 * `region`. The second turns `region` on alone and looks at the document minus
 * the portal roots: content outside a landmark is a real finding, and the
 * story frame is a `<main>` so ordinary story content is inside one, but WHERE
 * an overlay's portal lands relative to the page's landmarks is the composing
 * app's decision and not something a primitive's story can assert.
 */
async function documentViolations(): Promise<string[]> {
  const everythingElse = await axe.run(documentContext([FOCUS_GUARDS]), {
    rules: { ...BASE_RULES, region: { enabled: false } },
  });
  const landmarks = await axe.run(documentContext([FOCUS_GUARDS, '[data-base-ui-portal]']), {
    runOnly: ['region'],
  });
  return [...describeViolations(everythingElse), ...describeViolations(landmarks)];
}

type StoryModule = Parameters<typeof composeStories>[0];

/** A composed story is a component, and — where the story declares one — the
 *  `play` that drives it into the state it exists to show. */
type ComposedStory = ComponentType & {
  play?: (context: { canvasElement: HTMLElement }) => Promise<void> | void;
  parameters?: { ownsLandmarks?: boolean };
};

const storyModules = import.meta.glob<StoryModule>('./**/*.stories.tsx', { eager: true });

afterEach(() => {
  cleanup();
  applyStoryTheme('light');
});

/** `["components/ui/dialog", …]` in a stable order, so a failure names the
 *  same story on every machine. */
const modulePaths = Object.keys(storyModules).toSorted();

/** The glob hands back the widened module type, so what `composeStories`
 *  returns is opaque here. Every composed story is a callable component, so
 *  the guard both narrows the entry and states the one thing being relied on. */
function composedStories(storyModule: StoryModule): [string, ComposedStory][] {
  const composed: Record<string, unknown> = composeStories(storyModule);
  return Object.entries(composed).filter(
    (entry): entry is [string, ComposedStory] => typeof entry[1] === 'function',
  );
}

const composedByModule = modulePaths.map((modulePath) => {
  const storyModule = storyModules[modulePath];
  return {
    name: modulePath.replace('./', '').replace('.stories.tsx', ''),
    stories: storyModule ? composedStories(storyModule) : [],
  };
});

async function scoreStory(Story: ComposedStory): Promise<string[]> {
  applyStoryTheme('light');
  const view = render(
    <StoryFrame ownsLandmarks={Story.parameters?.ownsLandmarks === true} size="default">
      <Story />
    </StoryFrame>,
  );
  // The story's own interaction runs before the score, so an overlay that only
  // exists once opened is scored open rather than never scored at all.
  await Story.play?.({ canvasElement: view.container });
  return documentViolations();
}

describe('story accessibility', () => {
  it('composes at least one story out of every story module', () => {
    // A module that composes to nothing would be scored by nobody, and the
    // absence would look exactly like a passing run.
    expect(composedByModule.filter((module) => module.stories.length === 0)).toEqual([]);
    expect(composedByModule.length).toBeGreaterThan(0);
  });

  for (const { name, stories } of composedByModule) {
    for (const [storyName, Story] of stories) {
      it(`${name} · ${storyName} has no accessibility violations`, async () => {
        expect(await scoreStory(Story), `${name} · ${storyName}`).toEqual([]);
        // Full workspace stories include rich editors and their actual stylesheets.
      }, 60_000);
    }
  }
});
