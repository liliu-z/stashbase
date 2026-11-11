/**
 * The document navigation runtime's Interface: what Find and the outline hold
 * for the active tab, and what a viewer or command may ask of them. The
 * behaviour lives in `navigation-runtime.ts`.
 */
import type { StoreApi } from 'zustand/vanilla';

import type {
  DocumentSearchPurpose,
  DocumentSearchTarget,
  FindOptions,
} from '@/features/documents/domain/location';
import type { DocumentHeading } from '@/features/documents/domain/outline';

export type { FindOptions };

export interface FindMatchInfo {
  current: number;
  total: number;
}

export interface DocumentFindController {
  /** Locate a quoted passage without changing the editor selection. */
  locatePassage?(quote: string): FindMatchInfo | Promise<FindMatchInfo>;
  close(): void;
  next(): FindMatchInfo | Promise<FindMatchInfo>;
  previous(): FindMatchInfo | Promise<FindMatchInfo>;
  restoreQuery?(query: string, options: FindOptions): FindMatchInfo | Promise<FindMatchInfo>;
  setQuery(query: string, options: FindOptions): FindMatchInfo | Promise<FindMatchInfo>;
}

export interface DocumentFindState extends FindOptions, FindMatchInfo {
  available: boolean;
  focusRevision: number;
  open: boolean;
  query: string;
}

export interface DocumentOutlineState {
  activeId: string | null;
  available: boolean;
  headings: DocumentHeading[];
}

interface PendingDocumentAnchor {
  id: string;
  tabId: string;
}

export interface DocumentNavigationState {
  searchNotice: string | null;
  /** The purpose of the last requested search, for notices the viewer adds. */
  searchPurpose: DocumentSearchPurpose;
  outlineFailed: boolean;
  find: DocumentFindState;
  outline: DocumentOutlineState;
  /** Collapsed outline sections of the active tab, kept per tab in `collapsed`. */
  outlineCollapsed: ReadonlySet<string>;
  pendingAnchor: PendingDocumentAnchor | null;
}

export interface DocumentNavigationRuntime {
  readonly store: StoreApi<DocumentNavigationState>;
  activate(tabId: string | null): void;
  dismissSearchNotice(): void;
  setOutlineFailed(tabId: string, failed: boolean): void;
  claimFind(tabId: string, owner: symbol, controller: DocumentFindController): () => void;
  claimOutline(tabId: string, owner: symbol): () => void;
  /** Closes Find; answers whether it was open. */
  closeFind(): boolean;
  consumeAnchor(tabId: string, id: string): void;
  dispose(): void;
  /** Steps Find forward; answers whether Find was open to take the step. */
  findNext(): boolean;
  /** Steps Find backward; answers whether Find was open to take the step. */
  findPrevious(): boolean;
  /** Drops what navigation keeps for a tab that has closed. */
  forgetTab(tabId: string): void;
  openFind(): boolean;
  publishOutline(
    tabId: string,
    owner: symbol,
    outline: Omit<DocumentOutlineState, 'available'>,
    select: (heading: DocumentHeading) => void,
  ): void;
  requestAnchor(tabId: string, id: string): void;
  requestSearch(tabId: string, target: DocumentSearchTarget): void;
  selectHeading(heading: DocumentHeading): void;
  setFindCaseSensitive(value: boolean): void;
  setFindQuery(query: string): void;
  setFindWholeWord(value: boolean): void;
  toggleOutlineSection(headingId: string): void;
}

export interface SearchNotices {
  locating: string;
  missing: string;
  failed: string;
  /** Shown instead of any notice when the open preview has no Find. */
  unavailable: string;
}
