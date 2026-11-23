import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { DocumentTabs } from './tabs';
import { createRuntime } from './tabs.harness';

/** The button that lists every open tab, as `useTabOverflow` sees its share. */
const TRIGGER_WIDTH = 28;

/**
 * The test DOM lays nothing out, so the strip's row is modelled here: the
 * tabs' content has a width, and the list is as wide as that content or as
 * the row leaves it once the trigger, while shown, takes its share. Resizes
 * reach the strip through the ResizeObserver the overflow reading uses.
 */
const layout = { content: 0, row: 0 };
const observers = new Set<() => void>();

function triggerShown(): boolean {
  return globalThis.document.querySelector('[aria-label^="All open tabs"]') !== null;
}

function isTabList(element: HTMLElement): boolean {
  return element.getAttribute('role') === 'tablist';
}

/** Lets the strip read the row as it now is, as a browser would after layout. */
async function relayout(): Promise<void> {
  // Twice: the trigger appearing or leaving changes the list's box again.
  for (let pass = 0; pass < 2; pass += 1) {
    await act(async () => {
      for (const notify of observers) notify();
    });
  }
}

/** The DOM's own measurement, for every element the model does not cover. */
function real(name: 'clientWidth' | 'offsetWidth' | 'scrollWidth') {
  return (
    Object.getOwnPropertyDescriptor(Element.prototype, name)?.get ??
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)?.get
  );
}

const runtimes: ReturnType<typeof createRuntime>[] = [];

beforeEach(() => {
  layout.content = 0;
  layout.row = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly notify: () => void;
      constructor(callback: () => void) {
        this.notify = () => callback();
      }
      observe() {
        observers.add(this.notify);
      }
      disconnect() {
        observers.delete(this.notify);
      }
      unobserve() {}
    },
  );
  const clientWidth = real('clientWidth');
  const offsetWidth = real('offsetWidth');
  const scrollWidth = real('scrollWidth');
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      if (!isTabList(this)) return (clientWidth?.call(this) as number) ?? 0;
      return Math.min(layout.content, layout.row - (triggerShown() ? TRIGGER_WIDTH : 0));
    },
  );
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      return isTabList(this) ? layout.content : ((scrollWidth?.call(this) as number) ?? 0);
    },
  );
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      const holdsTrigger = this.firstElementChild
        ?.getAttribute('aria-label')
        ?.startsWith('All open tabs');
      return holdsTrigger ? TRIGGER_WIDTH : ((offsetWidth?.call(this) as number) ?? 0);
    },
  );
});

afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  observers.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderStrip() {
  const runtime = createRuntime();
  runtimes.push(runtime);
  render(<DocumentTabs runtime={runtime} />);
  return runtime;
}

async function openThird(runtime: ReturnType<typeof createRuntime>) {
  await act(async () => {
    await runtime.open({ folderPath: '/project/notes', path: 'later/third.md' });
  });
}

describe('all open tabs', () => {
  it('lists every open tab while the strip overflows, and brings the chosen one in front', async () => {
    layout.row = 400;
    layout.content = 300;
    const runtime = renderStrip();
    const user = userEvent.setup();

    // Everything fits, so there is nothing to list.
    expect(triggerShown()).toBe(false);

    layout.content = 600;
    await openThird(runtime);
    await relayout();

    await user.click(screen.getByRole('button', { name: 'All open tabs (3)' }));
    const list = await screen.findByRole('menu', { name: 'All open tabs (3)' });
    const rows = within(list).getAllByRole('menuitemradio');
    // Each row names its folder, so files that share a name stay apart.
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'plan.md',
      'other.md. drafts',
      'third.md. later',
    ]);
    expect(
      within(list).getByRole('menuitemradio', { checked: true }).getAttribute('aria-label'),
    ).toBe('third.md. later');

    await user.click(within(list).getByRole('menuitemradio', { name: /plan\.md/u }));
    expect(runtime.store.getState().activeTabId).toBe('tab-1');
    expect(runtime.store.getState().tabs).toHaveLength(3);
  });

  it('decides by the same room whether the pane narrowed or widened to it', async () => {
    // Content 600: the tabs fit a 610 row only once the trigger has gone.
    layout.content = 600;
    layout.row = 500;
    renderStrip();
    await relayout();
    expect(triggerShown()).toBe(true);

    // Widening from narrow: the trigger's own 28px must not keep it shown.
    layout.row = 610;
    await relayout();
    expect(triggerShown()).toBe(false);

    layout.row = 700;
    await relayout();
    expect(triggerShown()).toBe(false);

    // Narrowing from wide to the same width gives the same answer.
    layout.row = 610;
    await relayout();
    expect(triggerShown()).toBe(false);

    layout.row = 590;
    await relayout();
    expect(triggerShown()).toBe(true);
  });

  it('scrolls the document already in front back into view when it is chosen', async () => {
    layout.row = 400;
    layout.content = 600;
    const runtime = renderStrip();
    const user = userEvent.setup();
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);
    await relayout();
    scrollIntoView.mockClear();

    // The restored front document is drafts/other.md, scrolled out of sight.
    await user.click(screen.getByRole('button', { name: 'All open tabs (2)' }));
    const list = await screen.findByRole('menu', { name: 'All open tabs (2)' });
    await user.click(within(list).getByRole('menuitemradio', { name: /other\.md/u }));

    expect(runtime.store.getState().activeTabId).toBe('tab-2');
    expect(scrollIntoView.mock.instances.at(-1)).toBe(
      screen.getByRole('tab', { name: 'other.md' }),
    );
  });
});
