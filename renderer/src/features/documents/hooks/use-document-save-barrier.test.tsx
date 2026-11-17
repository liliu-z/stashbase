import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createDocumentTabsRuntime } from '@/features/documents/application/tabs-runtime';
import {
  documentQueryScope,
  documentWindowLifecycle,
  sourceApi,
  textSource,
} from '@/test/fakes/documents';

import { useDocumentSaveBarrier } from './use-document-save-barrier';

afterEach(cleanup);

describe('document native save barrier', () => {
  it('answers from the live runtime and retains a failed draft', async () => {
    const handlers: Array<() => boolean | Promise<boolean>> = [];
    const lifecycle = documentWindowLifecycle({
      onPrepareContextRelease: vi.fn((handler) => {
        const release = () => handler('close');
        handlers.push(release);
        return () => {
          handlers.splice(handlers.indexOf(release), 1);
        };
      }),
    });
    const api = sourceApi({
      save: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    const runtime = createDocumentTabsRuntime({
      api,
      createId: vi.fn(),
      createQueries: () => documentQueryScope(),
      folderPath: '/project/notes',
      generation: 1,
      restored: {
        activeTabId: 'plan',
        tabs: [{ id: 'plan', source: { folderPath: '/project/notes', path: 'plan.md' } }],
      },
    });
    const document = runtime.getDocument('plan');
    document?.reconcile(textSource({ content: 'before' }));
    document?.change('draft');

    const hook = renderHook(({ current }) => useDocumentSaveBarrier(current, lifecycle), {
      initialProps: { current: runtime as typeof runtime | null },
    });

    let ready = true;
    await act(async () => {
      ready = (await handlers[0]?.()) ?? true;
    });

    expect(ready).toBe(false);
    expect(document?.store.getState().editor?.value).toBe('draft');
    expect(document?.signal.aborted).toBe(false);

    hook.rerender({ current: null });
    expect(await handlers[0]?.()).toBe(true);
  });
});
