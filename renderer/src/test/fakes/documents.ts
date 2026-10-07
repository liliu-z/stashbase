import { vi } from 'vite-plus/test';

import type { AppDependencies } from '@/app/dependencies';
import type {
  DocumentAssetPort,
  DocumentQueryScope,
  DocumentSourcePort,
  DocumentTurnChangesPort,
  DocumentWindowLifecyclePort,
  DocxPreviewPort,
  GenericFilePreviewPort,
} from '@/features/documents/application/ports';
import type { DocumentTabsRuntimeOptions } from '@/features/documents/application/tabs-runtime';
import type { DocumentTextSource } from '@/features/documents/domain/document';
import type { DocumentAdapters } from '@/features/documents/infrastructure/adapters';

/** A loaded Markdown source; every field is overridable. */
export function textSource(overrides: Partial<DocumentTextSource> = {}): DocumentTextSource {
  return { content: '# Plan', format: 'md', version: 'v1', ...overrides };
}

export function sourceApi(overrides: Partial<DocumentSourcePort> = {}): DocumentSourcePort {
  return {
    load: vi.fn(async () => textSource()),
    overwrite: vi.fn(async () => textSource({ version: 'v2' })),
    save: vi.fn(async () => textSource({ version: 'v2' })),
    ...overrides,
  };
}

/** A source API whose every call hangs, for a test that asserts what the
 *  workspace shows while a load is still in flight. */
export function pendingSourceApi(): DocumentSourcePort {
  return sourceApi({
    load: vi.fn(() => new Promise<never>(() => undefined)),
    overwrite: vi.fn(() => new Promise<never>(() => undefined)),
    save: vi.fn(() => new Promise<never>(() => undefined)),
  });
}

export function assetApi(overrides: Partial<DocumentAssetPort> = {}): DocumentAssetPort {
  return {
    load: vi.fn(async () => ({ kind: 'source' as const, url: 'blob:asset', version: 'v1' })),
    ...overrides,
  };
}

export function docxPreviewApi(overrides: Partial<DocxPreviewPort> = {}): DocxPreviewPort {
  return { load: vi.fn(async () => ({ html: '' })), ...overrides };
}

export function genericPreviewApi(
  overrides: Partial<GenericFilePreviewPort> = {},
): GenericFilePreviewPort {
  return {
    load: vi.fn(async () => ({ kind: 'binary' as const, name: 'file.bin', size: 0 })),
    ...overrides,
  };
}

export function turnChangesApi(
  overrides: Partial<DocumentTurnChangesPort> = {},
): DocumentTurnChangesPort {
  return {
    load: vi.fn(async ({ source, turnId }) => ({
      afterVersion: 'v1',
      before: '# Plan',
      source,
      turnId,
    })),
    ...overrides,
  };
}

export function documentWindowLifecycle(
  overrides: Partial<DocumentWindowLifecyclePort> = {},
): DocumentWindowLifecyclePort {
  return { onPrepareContextRelease: vi.fn(() => () => undefined), ...overrides };
}

export function documentQueryScope(
  overrides: Partial<DocumentQueryScope> = {},
): DocumentQueryScope {
  return {
    cancel: vi.fn(async () => undefined),
    remove: vi.fn(),
    replaceSource: vi.fn(),
    ...overrides,
  };
}

/** Options for `createDocumentTabsRuntime`. Ids run `tab-1`, `tab-2`, … per
 *  runtime unless the test pins its own. */
export function documentTabsRuntimeOptions(
  overrides: Partial<DocumentTabsRuntimeOptions> = {},
): DocumentTabsRuntimeOptions {
  let nextId = 0;
  return {
    api: pendingSourceApi(),
    createId: () => `tab-${++nextId}`,
    createQueries: () => documentQueryScope(),
    folderPath: '/project/notes',
    generation: 1,
    ...overrides,
  };
}

/** Every Documents port, as one record. Override one entry at a time. */
export function documentAdapters(overrides: Partial<DocumentAdapters> = {}): DocumentAdapters {
  return {
    asset: assetApi(),
    docxPreview: docxPreviewApi(),
    genericPreview: genericPreviewApi(),
    source: sourceApi(),
    turnChanges: turnChangesApi(),
    windowLifecycle: documentWindowLifecycle(),
    ...overrides,
  };
}

/** The whole `documents` slice of the app dependencies. */
export function documentsApi(
  overrides: Partial<AppDependencies['documents']> = {},
): AppDependencies['documents'] {
  let nextId = 0;
  return {
    adapters: documentAdapters(),
    createId: vi.fn(() => `tab-${++nextId}`),
    openExternal: vi.fn(async () => true),
    ...overrides,
  };
}
