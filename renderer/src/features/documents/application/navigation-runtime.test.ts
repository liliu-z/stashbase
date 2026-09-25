import { describe, expect, it, vi } from 'vite-plus/test';

import { passageSearchTarget } from '@/features/documents/domain/location';

import { createDocumentNavigationRuntime, SEARCH_NOTICES } from './navigation-runtime';

describe('document navigation runtime', () => {
  it('keeps Find registration active-tab-owned and restores a retained query', async () => {
    const runtime = createDocumentNavigationRuntime('one');
    const first = {
      close: vi.fn(),
      next: vi.fn(() => ({ current: 2, total: 3 })),
      previous: vi.fn(() => ({ current: 3, total: 3 })),
      restoreQuery: vi.fn(() => ({ current: 1, total: 3 })),
      setQuery: vi.fn(() => ({ current: 1, total: 3 })),
    };
    const releaseFirst = runtime.claimFind('one', Symbol('one'), first);
    expect(runtime.openFind()).toBe(true);
    runtime.setFindQuery('plan');
    await vi.waitFor(() => expect(runtime.store.getState().find.total).toBe(3));

    runtime.activate('two');
    expect(first.close).toHaveBeenCalledOnce();
    const second = {
      ...first,
      close: vi.fn(),
      restoreQuery: vi.fn(() => ({ current: 1, total: 1 })),
    };
    runtime.claimFind('two', Symbol('two'), second);
    await vi.waitFor(() =>
      expect(second.restoreQuery).toHaveBeenCalledWith('plan', expect.anything()),
    );
    releaseFirst();

    expect(runtime.store.getState().find.available).toBe(true);
    expect(runtime.store.getState().find.query).toBe('plan');
  });

  it('scopes outline selection and pending anchors to the active tab', () => {
    const runtime = createDocumentNavigationRuntime('one');
    const owner = Symbol('outline');
    const select = vi.fn();
    const heading = { id: 'part', level: 2, position: 10, text: 'Part' };
    runtime.claimOutline('one', owner);
    runtime.publishOutline('one', owner, { activeId: 'part', headings: [heading] }, select);
    runtime.selectHeading(heading);
    runtime.requestAnchor('one', 'part');

    expect(select).toHaveBeenCalledWith(heading);
    expect(runtime.store.getState().pendingAnchor).toEqual({ id: 'part', tabId: 'one' });
    runtime.consumeAnchor('two', 'part');
    expect(runtime.store.getState().pendingAnchor).not.toBeNull();
    runtime.consumeAnchor('one', 'part');
    expect(runtime.store.getState().pendingAnchor).toBeNull();
  });

  it('delivers a pending search to the active viewer and selects its requested occurrence', async () => {
    const runtime = createDocumentNavigationRuntime('one');
    const controller = {
      close: vi.fn(),
      next: vi
        .fn()
        .mockReturnValueOnce({ current: 2, total: 3 })
        .mockReturnValueOnce({ current: 3, total: 3 }),
      previous: vi.fn(() => ({ current: 1, total: 3 })),
      setQuery: vi.fn(() => ({ current: 1, total: 3 })),
    };

    runtime.requestSearch('one', {
      caseSensitive: false,
      occurrenceIndex: 2,
      query: 'evidence',
      wholeWord: false,
    });
    runtime.claimFind('one', Symbol('viewer'), controller);

    await vi.waitFor(() => expect(runtime.store.getState().find.current).toBe(3));
    expect(controller.setQuery).toHaveBeenCalledWith('evidence', {
      caseSensitive: false,
      wholeWord: false,
    });
    expect(controller.next).toHaveBeenCalledTimes(2);
    expect(runtime.store.getState().find).toMatchObject({
      current: 3,
      open: false,
      query: 'evidence',
      total: 3,
    });
  });

  it('words a cited passage as a passage while locating, missing, and failing', async () => {
    const runtime = createDocumentNavigationRuntime('one');
    const notice = () => runtime.store.getState().searchNotice;
    const controller = {
      close: vi.fn(),
      next: vi.fn(() => ({ current: 0, total: 0 })),
      previous: vi.fn(() => ({ current: 0, total: 0 })),
      setQuery: vi
        .fn()
        .mockReturnValueOnce({ current: 0, total: 0 })
        .mockImplementationOnce(() => Promise.reject(new Error('preview gone'))),
    };

    runtime.requestSearch('one', passageSearchTarget('rising tides'));
    expect(notice()).toBe(SEARCH_NOTICES.passage.locating);
    expect(runtime.store.getState().searchPurpose).toBe('passage');
    runtime.claimFind('one', Symbol('viewer'), controller);
    await vi.waitFor(() => expect(notice()).toBe(SEARCH_NOTICES.passage.missing));
    expect(controller.setQuery).toHaveBeenCalledWith('rising tides', {
      caseSensitive: false,
      wholeWord: false,
    });

    runtime.requestSearch('one', passageSearchTarget('rising tides'));
    await vi.waitFor(() => expect(notice()).toBe(SEARCH_NOTICES.passage.failed));
  });
});
