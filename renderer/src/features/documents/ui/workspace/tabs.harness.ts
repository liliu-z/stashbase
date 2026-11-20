import { vi } from 'vite-plus/test';

import type { DocumentSourcePort } from '@/features/documents/application/ports';
import { createDocumentTabsRuntime } from '@/features/documents/application/tabs-runtime';
import { documentQueryScope, sourceApi, textSource } from '@/test/fakes/documents';

export const RESTORED_TABS = [
  { id: 'tab-1', source: { folderPath: '/project/notes', path: 'plan.md' } },
  { id: 'tab-2', source: { folderPath: '/project/notes', path: 'drafts/other.md' } },
];

export function createRuntime(api: DocumentSourcePort = loadedSourceApi, tabs = RESTORED_TABS) {
  let next = 2;
  const runtime = createDocumentTabsRuntime({
    api,
    createId: () => `tab-${++next}`,
    createQueries: () => documentQueryScope(),
    folderPath: '/project/notes',
    generation: 1,
    restored: {
      activeTabId: 'tab-2',
      tabs,
    },
  });
  return runtime;
}

export const loadedSourceApi = sourceApi({
  load: vi.fn(async () => textSource({ content: '# Loaded' })),
});
