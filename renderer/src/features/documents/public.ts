/**
 * The Documents feature's whole surface to `renderer/src/app`.
 *
 * Everything here is imported by app composition; nothing else leaves the
 * feature. The viewer registry, the save state, the format vocabulary, and
 * every view below the workspace stay internal, so adding a format or
 * reshaping the save lifecycle never reaches the shell. What only a test
 * builds lives in `test-support.ts`.
 */
export { createDocumentQueryScope, refreshDocumentSources } from './application/queries';
export {
  createDocumentTabsRuntime,
  type DocumentOpenOptions,
  type DocumentTabsRuntime,
} from './application/tabs-runtime';
export type { DocumentRuntime } from './application/document-runtime';
export { turnChangeReviewMessage } from './application/failure-messages';
export { openTurnChangeReview } from './application/open-revision';
export { createDocumentAdapters, type DocumentAdapters } from './infrastructure/adapters';
export { useDocumentCommands } from './hooks/use-document-commands';
export { useDocumentSaveBarrier } from './hooks/use-document-save-barrier';
export {
  useActiveDocumentSource,
  useHasOpenDocuments,
  useOpenDocumentSources,
} from './hooks/use-open-documents';
export { useNewTab, type NewTab } from './hooks/use-new-tab';
export { useRevisionPreview } from './hooks/use-revision-preview';
export { RevisionPreview } from './ui/workspace/revision-preview';
export { NewTabPage } from './ui/workspace/new-tab';
export { DocumentTabs } from './ui/workspace/tabs';
export { DocumentHistoryButtons } from './ui/workspace/history-buttons';
export { DocumentOutline, DocumentOutlineEmpty } from './ui/workspace/outline';
export { DocumentWorkspace } from './ui/workspace/workspace';
export type { DocumentNavigationTarget } from './ui/source/viewer';
export { passageSearchTarget } from './domain/location';
export type { DocumentSelection } from './domain/selection';

export { prepareDocument } from './application/prepare-document';
