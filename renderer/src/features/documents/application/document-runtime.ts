/**
 * One open document's coordination seam: it owns the abortable scope, keeps
 * saves serialized so two writes never race, and turns a refused save into
 * the domain's conflict or failure state. Reader-facing sentences come from
 * `failure-messages`, never from here.
 */
import { createStore } from 'zustand/vanilla';

import { enterDocumentConflict } from '@/features/documents/domain/conflict-state';
import {
  acceptDocumentSave,
  beginDocumentSave,
  changeDocumentText,
  createDocumentState,
  detachDocumentSave,
  documentAccess,
  disposeDocumentState,
  isDocumentDirty,
  reconcileDocumentSource,
  rejectDocumentSave,
  sameSource,
  setDocumentJsonSession,
  setDocumentMarkdownMode,
  setDocumentPdfPage,
  type DocumentScope,
  type DocumentState,
} from '@/features/documents/domain/document';
import { documentTextFormat } from '@/features/documents/domain/document-format';
import {
  publishDocumentRevisionCount,
  startDocumentRevision,
} from '@/features/documents/domain/revision';
import { createScopeGuard } from '@/shared/runtime/scope-guard';

import { watchAutosave } from './autosave';
import { resolveDocumentConflict, type ConflictResolutionContext } from './conflict-resolution';
import type {
  DocumentOperationScope,
  DocumentRuntime,
  DocumentRuntimeOptions,
} from './document-runtime-contract';
import { documentFailure, DOCUMENT_SAVE_MESSAGES } from './failure-messages';
import { DocumentSaveError, DocumentSourceError, type DocumentSourcePort } from './ports';

export type { DocumentRuntime, DocumentRuntimeOptions } from './document-runtime-contract';

export function createDocumentRuntime({
  api: autosaveApi,
  activeFolderPath,
  generation,
  id,
  queries,
  source,
}: DocumentRuntimeOptions): DocumentRuntime {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Document runtime generation must be a positive safe integer.');
  }
  if (id.trim().length === 0) throw new Error('Document runtime ID must not be empty.');
  if (source.folderPath.trim().length === 0 || source.path.trim().length === 0) {
    throw new Error('Document source paths must not be empty.');
  }

  let scope: DocumentScope = Object.freeze({
    generation,
    id,
    source: Object.freeze({ ...source }),
  });
  let controller = new AbortController();
  const store = createStore<DocumentState>(() =>
    createDocumentState(scope, documentAccess(source, activeFolderPath)),
  );
  let disposed = false;
  let saveInFlight: Promise<boolean> | null = null;

  const { accept, capture, retireOperations } = createScopeGuard<DocumentScope>({
    disposed: () => disposed,
    sameScope: (captured, live) =>
      captured.generation === live.generation &&
      captured.id === live.id &&
      sameSource(captured.source, live.source),
    scope: () => scope,
  });

  const performSave = async (api: DocumentSourcePort, merging = false): Promise<boolean> => {
    const before = store.getState();
    const editor = before.editor;
    if (!editor || !isDocumentDirty(editor) || before.lifecycle === 'disposed') return true;
    const captured = capture();
    const capturedRevision = editor.revision;
    const input = { baseVersion: editor.version, content: editor.value };
    if (merging)
      store.setState((state) => ({
        ...state,
        editor: state.editor && {
          ...state.editor,
          save: { kind: 'merging', finishing: true, message: null },
        },
      }));
    else store.setState(beginDocumentSave);
    try {
      const saved = await api.save(captured.scope.source, input, controller.signal);
      return accept(captured, () => {
        queries.replaceSource(saved);
        store.setState((state) => acceptDocumentSave(state, capturedRevision, saved));
      });
    } catch (error) {
      const conflict = error instanceof DocumentSaveError && error.kind === 'conflict';
      if (conflict) {
        try {
          const diskSource = await api.load(captured.scope.source, controller.signal);
          accept(captured, () => {
            queries.replaceSource(diskSource);
            store.setState((state) => enterDocumentConflict(state, diskSource));
          });
        } catch (loadError) {
          // The write was refused against a version the file no longer has,
          // and the read confirms why: there is no file. That is not a
          // comparison the reader can make, so the draft detaches instead.
          const gone =
            loadError instanceof DocumentSourceError && loadError.kind === 'missing'
              ? DOCUMENT_SAVE_MESSAGES.missing
              : null;
          accept(captured, () =>
            store.setState((state) =>
              gone === null
                ? rejectDocumentSave(state, DOCUMENT_SAVE_MESSAGES.conflict)
                : detachDocumentSave(state, gone),
            ),
          );
        }
        return false;
      }
      const message = documentFailure(error, 'DocumentSaveError', DOCUMENT_SAVE_MESSAGES).message;
      // A missing destination is not a write that might work next time. It
      // becomes the document's standing state so autosave stops and the reader
      // is left with the explicit restore.
      const detached = error instanceof DocumentSaveError && error.kind === 'missing';
      accept(captured, () =>
        store.setState((state) =>
          detached ? detachDocumentSave(state, message) : rejectDocumentSave(state, message),
        ),
      );
      return false;
    }
  };

  /** The one write that may create a file the app did not find. It is reached
   *  only from `restore`, after a save has re-confirmed the source is gone. */
  const performCreate = async (
    api: DocumentSourcePort,
    captured: DocumentOperationScope,
    capturedRevision: number,
    content: string,
  ): Promise<boolean> => {
    try {
      const created = await api.overwrite(captured.scope.source, { content }, controller.signal);
      return accept(captured, () => {
        queries.replaceSource(created);
        store.setState((state) => acceptDocumentSave(state, capturedRevision, created));
      });
    } catch (error) {
      const message = documentFailure(error, 'DocumentSaveError', DOCUMENT_SAVE_MESSAGES).message;
      accept(captured, () => store.setState((state) => detachDocumentSave(state, message)));
      return false;
    }
  };

  const save = async (api: DocumentSourcePort): Promise<boolean> => {
    while (true) {
      const pendingSave = saveInFlight;
      if (pendingSave) {
        if (!(await pendingSave)) return false;
        continue;
      }
      const editor = store.getState().editor;
      if (!editor) return true;
      if (editor.save.kind === 'conflict' || editor.save.kind === 'merging') return false;
      if (!isDocumentDirty(editor)) return true;
      const run = performSave(api);
      saveInFlight = run;
      let succeeded: boolean;
      try {
        succeeded = await run;
      } finally {
        if (saveInFlight === run) saveInFlight = null;
      }
      if (!succeeded) return false;
    }
  };

  const resolutionContext: ConflictResolutionContext = {
    accept,
    capture,
    queries,
    retireOperations,
    get scope() {
      return scope;
    },
    signal: controller.signal,
    store,
  };

  const autosave = watchAutosave({ api: autosaveApi, save, store });

  return {
    readingPosition: null,
    get scope() {
      return scope;
    },
    get signal() {
      return controller.signal;
    },
    store,
    accept,
    capture,
    change(value) {
      if (disposed) return;
      store.setState((state) => changeDocumentText(state, value));
    },
    publishRevisionCount(reviewId, pending) {
      if (disposed) return;
      store.setState((state) => publishDocumentRevisionCount(state, reviewId, pending));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      autosave.dispose();
      retireOperations();
      controller.abort();
      // Cancelling in-flight reads is best effort during teardown.
      // swallowed: the document is already gone, so a rejected cancellation has no reader.
      void queries.cancel().catch(() => undefined);
      queries.remove();
      store.setState(disposeDocumentState);
    },
    setMutationPending(pending) {
      autosave.cancelPending();
      store.setState((state) => ({ ...state, mutationPending: pending }));
    },
    rebind(nextSource, createQueries) {
      if (disposed) return;
      retireOperations();
      controller.abort();
      controller = new AbortController();
      queries.remove();
      scope = Object.freeze({
        ...scope,
        generation: scope.generation + 1,
        source: Object.freeze({ ...nextSource }),
      });
      queries = createQueries(scope);
      const editor = store.getState().editor;
      const format = documentTextFormat(nextSource.path);
      if (editor && format)
        queries.replaceSource({ content: editor.baseline, format, version: editor.version });
      store.setState((state) => ({ ...state, scope }));
    },
    reconcile(nextSource) {
      if (disposed) return;
      const next = reconcileDocumentSource(store.getState(), nextSource);
      if (next === store.getState()) return;
      // The bytes under the editor were replaced, so a save still in flight is
      // no longer about the text this document holds.
      retireOperations();
      store.setState(next);
    },
    async finishMerge(api) {
      const editor = store.getState().editor;
      if (disposed || saveInFlight || editor?.save.kind !== 'merging' || editor.save.finishing)
        return false;
      if (/^(?:<<<<<<< Editor Version|>>>>>>> Disk Version)\s*$/mu.test(editor.value)) {
        store.setState((state) =>
          rejectDocumentSave(state, 'Resolve the marked conflicts before finishing the merge.'),
        );
        return false;
      }
      const run = performSave(api, true);
      saveInFlight = run;
      try {
        return await run;
      } finally {
        if (saveInFlight === run) saveInFlight = null;
      }
    },
    resolveConflict(api, resolution) {
      return disposed
        ? Promise.resolve(false)
        : resolveDocumentConflict(resolutionContext, api, resolution);
    },
    /**
     * Writes a detached draft back to the path its file was deleted from.
     *
     * An ordinary save runs first, because the file may have come back since
     * the draft detached: that lands, or it becomes the comparison the reader
     * decides in. Only a save that re-confirms the file is gone reaches the
     * create below, so this can never overwrite something that reappeared.
     */
    async restore(api) {
      if (disposed || store.getState().editor?.save.kind !== 'detached') return false;
      if (await save(api)) return true;
      const editor = store.getState().editor;
      if (disposed || editor?.save.kind !== 'detached') return false;
      const captured = capture();
      const capturedRevision = editor.revision;
      const content = editor.value;
      store.setState(beginDocumentSave);
      const run = performCreate(api, captured, capturedRevision, content);
      saveInFlight = run;
      try {
        return await run;
      } finally {
        if (saveInFlight === run) saveInFlight = null;
      }
    },
    retireOperations,
    save,
    startRevision(review, currentBody) {
      if (disposed) return 'not-editable';
      const started = startDocumentRevision(store.getState(), review, currentBody);
      if (started.kind === 'refused') return started.reason;
      store.setState(() => started.state);
      return null;
    },
    setJsonSession(patch) {
      if (disposed) return;
      store.setState((state) => setDocumentJsonSession(state, patch));
    },
    setMarkdownMode(mode) {
      if (disposed) return;
      store.setState((state) => setDocumentMarkdownMode(state, mode));
    },
    setPdfPage(page) {
      if (disposed) return;
      store.setState((state) => setDocumentPdfPage(state, page));
    },
  };
}
