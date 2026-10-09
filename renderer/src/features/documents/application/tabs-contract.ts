/**
 * The document tabs runtime's Interface: the open set's scope, the token a
 * transition is started under, what a caller may ask of the runtime, and what
 * it is built from. The behaviour lives in `tabs-runtime.ts`; this is the
 * shape every reader of the open set depends on.
 */
import type { StoreApi } from 'zustand/vanilla';

import type { DocumentRuntime } from '@/features/documents/application/document-runtime';
import type { DocumentUsageEvent } from '@/features/documents/application/document-runtime-contract';
import type { DocumentScope } from '@/features/documents/domain/document';
import type { DocumentLocation } from '@/features/documents/domain/location';
import type { DocumentTabsState, RestoredDocumentTabs } from '@/features/documents/domain/tabs';
import type { SourceReference } from '@/shared/domain/source-reference';
import type { CapturedScope } from '@/shared/runtime/scope-guard';

import type { DocumentHistoryRuntime } from './history-runtime';
import type { DocumentNavigationRuntime } from './navigation-runtime';
import type { DocumentQueryScope, DocumentSourcePort } from './ports';

export interface DocumentTabsScope {
  readonly folderPath: string;
  readonly generation: number;
}

/** What one tabs transition was started under: the folder scope, and the
 *  generation of the open set at the time. A transition reads the active tab
 *  before it awaits a save, so the generation is what tells a resumed
 *  transition that the set it read has since moved. */
type CapturedTabsScope = CapturedScope<DocumentTabsScope>;

interface DocumentSessionProjection {
  activeTabId: string | null;
  tabs: Array<{ id: string; path: string }>;
}

export interface DocumentOpenOptions extends DocumentLocation {
  /** True opens the source as a look: it takes the standing preview tab's
   *  place and is left out of the saved session. Absent, the tab is kept. */
  preview?: boolean;
}

export interface DocumentTabsRuntime {
  readonly history: DocumentHistoryRuntime;
  readonly navigation: DocumentNavigationRuntime;
  readonly scope: DocumentTabsScope;
  readonly signal: AbortSignal;
  readonly store: StoreApi<DocumentTabsState>;
  /** Runs `completion` only when `captured` is still the scope this runtime
   *  owns, the open set has not moved since, and the runtime is live. Answers
   *  whether it ran, so a caller can drop the rest of a stale completion too. */
  accept(captured: CapturedTabsScope, completion: () => void): boolean;
  activate(tabId: string): Promise<boolean>;
  /** The source in front of the reader, or null when nothing is open. */
  activeSource(): SourceReference | null;
  /** Reopens the previous visit in the history. An open tab is used as it
   *  is; otherwise the source comes back as the preview, never as a new
   *  kept tab. Answers the document, or null when there was nowhere to go
   *  or the save barrier refused. */
  back(): Promise<DocumentRuntime | null>;
  /** The token a transition is started under: the folder scope this collection
   *  is bound to, which is fixed for its life, and the generation of the open
   *  set as of now, which is not. */
  capture(): CapturedTabsScope;
  close(tabId: string): Promise<boolean>;
  /** Closes the tab a standing close question is about and drops its draft.
   *  Only the reader's answer to that question may call this. */
  closeWithoutSaving(): Promise<boolean>;
  /** Withdraws a standing close question; the tab and its draft stay. */
  dismissCloseDecision(): void;
  dismissOpenFailure(): void;
  retryOpen(): Promise<DocumentRuntime | null>;
  /** Closes the tab in front of the reader, if there is one. */
  closeActive(): Promise<boolean>;
  /** Closes the tab showing `source`, if one is open. */
  closeSource(source: SourceReference): Promise<boolean>;
  dispose(): void;
  flush(): Promise<boolean>;
  /** Saves before a rename (path) or deletion (null). Undefined retains a lock until the original outcome is confirmed. */
  mutate(path: string, operation: () => Promise<string | null | undefined>): Promise<boolean>;
  /** The counterpart of `back`. */
  forward(): Promise<DocumentRuntime | null>;
  getDocument(tabId: string): DocumentRuntime | null;
  /** Whether any document is open. */
  hasDocuments(): boolean;
  /** Turns a preview into a kept tab; answers whether the tab exists. */
  keep(tabId: string): boolean;
  /** The sources behind the open tabs, as one cached array so a reader can
   *  compare it by identity across renders. */
  openSources(): readonly SourceReference[];
  /** Notifies `listener` whenever the open set or the active tab moves. */
  subscribe(listener: () => void): () => void;
  open(source: SourceReference, options?: DocumentOpenOptions): Promise<DocumentRuntime | null>;
  toSession(): DocumentSessionProjection;
}

export interface DocumentTabsRuntimeOptions {
  recordUsage?: ((event: DocumentUsageEvent) => void) | undefined;
  prepare?: (scope: DocumentScope) => Promise<string | null>;
  api: DocumentSourcePort;
  createId: () => string;
  createQueries: (scope: DocumentScope) => DocumentQueryScope;
  folderPath: string;
  generation: number;
  restored?: RestoredDocumentTabs | null;
}
