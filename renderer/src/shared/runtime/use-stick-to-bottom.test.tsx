import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { useStickToBottom } from './use-stick-to-bottom';

function Log({ conversation }: { conversation: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { followLatest, pauseFollowing } = useStickToBottom(ref, conversation);
  return (
    <>
      <div data-testid="log" ref={ref}>
        <div>
          {conversation}
          <input aria-label="Answer" />
          <div data-testid="output" style={{ overflowY: 'auto' }} />
        </div>
      </div>
      <button onClick={followLatest}>Send</button>
      <button onClick={pauseFollowing}>Inspect process</button>
    </>
  );
}

let resize: () => void = () => undefined;
let now = 0;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A 300px viewport over content of `height`, clamped as a browser clamps. */
function scroller(element: HTMLElement, initial: number) {
  let height = initial;
  let top = 0;
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 300 });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, height - 300));
    },
  });
  return {
    grow(next: number) {
      height = next;
      act(() => resize());
    },
    /** The reader's own scroll: the gesture, then the position it produced. */
    scroll(deltaY: number, to: number) {
      fireEvent.wheel(element, { deltaY });
      this.drag(to);
    },
    /** A position change with no gesture behind it, like a scrollbar drag. */
    drag(to: number) {
      element.scrollTop = to;
      fireEvent.scroll(element);
    },
  };
}

describe('useStickToBottom', () => {
  it('keeps newly expanded process messages in place until the reader sends or follows again', () => {
    const view = render(<Log conversation="a" />);
    const log = view.getByTestId('log');
    const content = scroller(log, 1_000);
    content.grow(1_000);
    fireEvent.click(view.getByRole('button', { name: 'Inspect process' }));
    content.grow(2_000);
    expect(log.scrollTop).toBe(700);
    content.scroll(1_000, 1_700);
    content.grow(2_200);
    expect(log.scrollTop).toBe(1_900);
  });

  it('follows output until the reader scrolls toward the start, however little', () => {
    const view = render(<Log conversation="a" />);
    const log = view.getByTestId('log');
    const content = scroller(log, 1_000);
    content.grow(1_000);
    expect(log.scrollTop).toBe(700);

    content.scroll(-10, 690);
    content.grow(1_200);
    expect(log.scrollTop).toBe(690);

    content.scroll(40, 880);
    content.grow(1_400);
    expect(log.scrollTop).toBe(1_100);

    content.drag(500);
    content.grow(1_600);
    expect(log.scrollTop).toBe(500);

    view.rerender(<Log conversation="b" />);
    expect(log.scrollTop).toBe(1_300);
  });

  it('glides back on send and keeps gliding to output that lands meanwhile', () => {
    const view = render(<Log conversation="a" />);
    const log = view.getByTestId('log');
    const content = scroller(log, 1_000);
    content.grow(1_000);
    const glide = vi.fn();
    log.scrollTo = glide as typeof log.scrollTo;
    content.scroll(-200, 100);

    fireEvent.click(view.getByRole('button', { name: 'Send' }));
    expect(glide).toHaveBeenLastCalledWith({ behavior: 'smooth', top: 1_000 });
    now += 500;
    content.grow(1_200);
    expect(glide).toHaveBeenLastCalledWith({ behavior: 'smooth', top: 1_200 });

    content.drag(900);
    fireEvent(log, new Event('scrollend'));
    content.grow(1_400);
    expect(log.scrollTop).toBe(1_100);
    expect(glide).toHaveBeenCalledTimes(2);
  });

  it('ignores gestures that a nested area or a field takes itself', () => {
    const view = render(<Log conversation="a" />);
    const log = view.getByTestId('log');
    const content = scroller(log, 1_000);
    content.grow(1_000);
    const output = view.getByTestId('output');
    Object.defineProperty(output, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 400 });
    Object.defineProperty(output, 'scrollTop', { configurable: true, value: 200 });

    fireEvent.wheel(output, { deltaY: -40 });
    fireEvent.keyDown(view.getByRole('textbox', { name: 'Answer' }), { key: 'ArrowUp' });
    content.grow(1_200);
    expect(log.scrollTop).toBe(900);

    fireEvent.keyDown(log, { key: 'PageUp' });
    content.grow(1_400);
    expect(log.scrollTop).toBe(900);
  });
});
