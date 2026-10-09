import { afterEach, expect, it, vi } from 'vite-plus/test';

import {
  documentQueryScope,
  documentTabsRuntimeOptions,
  sourceApi,
  textSource,
} from '@/test/fakes/documents';

import { createDocumentRuntime } from './document-runtime';
import { DocumentSaveError, DocumentSourceError, type DocumentSourcePort } from './ports';
import { createDocumentTabsRuntime, type DocumentTabsRuntime } from './tabs-runtime';

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

it('autosaves a hidden document while navigation remains available after a save failure', async () => {
  vi.useFakeTimers();
  const api = sourceApi({ save: vi.fn().mockRejectedValue(new Error('offline')) });
  const runtime = createDocumentTabsRuntime(documentTabsRuntimeOptions({ api }));
  disposers.push(() => runtime.dispose());
  const document = await runtime.open({ folderPath: '/project/notes', path: 'a.txt' });
  if (!document) throw new Error('Document did not open.');
  document.reconcile(textSource({ format: 'txt' }));
  document.change('local draft');
  await runtime.open({ folderPath: '/project/notes', path: 'b.txt' });
  await vi.advanceTimersByTimeAsync(600);
  expect(api.save).toHaveBeenCalledOnce();
  expect(document.store.getState().editor?.save.kind).toBe('failed');
  expect(runtime.activeSource()?.path).toBe('b.txt');
  expect(await runtime.close(document.scope.id)).toBe(false);
  expect(document.store.getState().editor?.value).toBe('local draft');
});

it('compares again if the reviewed disk version changes before Keep my version', async () => {
  const api = sourceApi({
    save: vi.fn().mockRejectedValue(new DocumentSaveError('conflict', 'changed')),
    load: vi
      .fn()
      .mockResolvedValueOnce(textSource({ content: 'disk two', version: 'v2' }))
      .mockResolvedValueOnce(textSource({ content: 'disk three', version: 'v3' })),
  });
  const document = createDocumentRuntime({
    activeFolderPath: '/project/notes',
    source: { folderPath: '/project/notes', path: 'a.md' },
    generation: 1,
    id: 'a',
    queries: documentQueryScope(),
  });
  disposers.push(() => document.dispose());
  document.reconcile(textSource({ content: 'initial', version: 'v1' }));
  document.change('local draft');
  expect(await document.save(api)).toBe(false);
  expect(await document.resolveConflict(api, 'overwrite')).toBe(false);
  expect(api.save).toHaveBeenLastCalledWith(
    document.scope.source,
    { baseVersion: 'v2', content: 'local draft' },
    expect.any(AbortSignal),
  );
  expect(document.store.getState().editor?.save).toMatchObject({
    kind: 'conflict',
    conflict: { diskContent: 'disk three', editorContent: 'local draft', diskVersion: 'v3' },
  });
});

it('retains an uncertain rename, blocks edits at the old path, and rebinds after confirmation', async () => {
  const runtime: DocumentTabsRuntime = createDocumentTabsRuntime(documentTabsRuntimeOptions());
  disposers.push(() => runtime.dispose());
  const document = await runtime.open({ folderPath: '/project/notes', path: 'a.md' });
  if (!document) throw new Error('Document did not open.');
  document.reconcile(textSource({ content: 'saved' }));
  expect(await runtime.mutate('a.md', async () => undefined)).toBe(false);
  document.change('would target an unknown path');
  expect(document.store.getState().editor?.value).toBe('saved');
  expect(await runtime.close(document.scope.id)).toBe(false);
  expect(await runtime.mutate('a.md', async () => 'renamed.md')).toBe(true);
  document.change('new edit');
  expect(document.store.getState().editor?.value).toBe('new edit');
  expect(runtime.getDocument(document.scope.id)).toBe(document);
  expect(document.scope.source.path).toBe('renamed.md');
});

/** A dirty draft whose file was deleted outside the app: the save is refused
 *  against a version the file no longer has, and the read confirms it is gone. */
async function detachedDraft(overrides: Partial<DocumentSourcePort> = {}) {
  const api = sourceApi({
    load: vi.fn().mockRejectedValue(new DocumentSourceError('missing', 'gone')),
    save: vi.fn().mockRejectedValue(new DocumentSaveError('conflict', 'changed')),
    ...overrides,
  });
  const runtime = createDocumentTabsRuntime(documentTabsRuntimeOptions({ api }));
  disposers.push(() => runtime.dispose());
  const document = await runtime.open({ folderPath: '/project/notes', path: 'a.txt' });
  if (!document) throw new Error('Document did not open.');
  document.reconcile(textSource({ format: 'txt' }));
  document.change('local draft');
  await vi.advanceTimersByTimeAsync(600);
  expect(document.store.getState().editor?.save.kind).toBe('detached');
  return { api, document, runtime };
}

it('stops writing and asks before closing once the source file is gone', async () => {
  vi.useFakeTimers();
  const { api, document, runtime } = await detachedDraft();
  expect(api.save).toHaveBeenCalledOnce();

  // Typing does not bring the file back, so no further write may be queued
  // against a path that no longer exists.
  document.change('local draft, longer');
  await vi.advanceTimersByTimeAsync(600);
  expect(api.save).toHaveBeenCalledOnce();
  expect(document.store.getState().editor?.save.kind).toBe('detached');

  // Neither a close nor a release can be settled by saving, so both refuse and
  // put the question to the reader instead of failing silently.
  expect(await runtime.close(document.scope.id)).toBe(false);
  expect(runtime.store.getState().closeDecision?.tabId).toBe(document.scope.id);
  runtime.dismissCloseDecision();
  expect(await runtime.flush()).toBe(false);
  expect(runtime.store.getState().closeDecision?.tabId).toBe(document.scope.id);
  expect(api.save).toHaveBeenCalledOnce();
  expect(document.store.getState().editor?.value).toBe('local draft, longer');

  expect(await runtime.closeWithoutSaving()).toBe(true);
  expect(runtime.store.getState().tabs).toHaveLength(0);
  expect(runtime.store.getState().closeDecision).toBeNull();
});

it('restores a detached draft by creating its file again, and autosaves after', async () => {
  vi.useFakeTimers();
  const { api, document } = await detachedDraft();

  expect(await document.restore(api)).toBe(true);
  // The create is the unconditional write, so it carries no base version.
  expect(api.overwrite).toHaveBeenCalledWith(
    document.scope.source,
    { content: 'local draft' },
    expect.anything(),
  );
  expect(document.store.getState().editor?.save.kind).toBe('saved');

  // The draft has a file again, so the ordinary writer takes over. Restore
  // re-attempted the save itself before creating, so only the increase matters.
  const writes = vi.mocked(api.save).mock.calls.length;
  document.change('after restore');
  await vi.advanceTimersByTimeAsync(600);
  expect(api.save).toHaveBeenCalledTimes(writes + 1);
});

it('compares a source that came back instead of overwriting it on restore', async () => {
  vi.useFakeTimers();
  const { api, document } = await detachedDraft();
  vi.mocked(api.load).mockResolvedValue(textSource({ content: 'someone else', format: 'txt' }));

  expect(await document.restore(api)).toBe(false);
  expect(api.overwrite).not.toHaveBeenCalled();
  expect(document.store.getState().editor?.save.kind).toBe('conflict');
});

it('records an actual edit without source content, while reconciliation and no-change callbacks stay silent', async () => {
  const recordUsage = vi.fn();
  const runtime = createDocumentTabsRuntime({ ...documentTabsRuntimeOptions(), recordUsage });
  disposers.push(() => runtime.dispose());
  const document = await runtime.open({ folderPath: '/project/notes', path: 'private.md' });
  if (!document) throw new Error('Document did not open.');
  document.reconcile(textSource({ content: 'private content' }));
  document.change('private content');
  expect(recordUsage).not.toHaveBeenCalled();
  document.change('changed private content');
  expect(recordUsage.mock.calls).toEqual([
    [{ event: 'document_engaged', activity: 'edit', format: 'md' }],
  ]);
  document.dispose();
  document.change('after disposal');
  expect(recordUsage).toHaveBeenCalledTimes(1);
});
