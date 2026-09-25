/**
 * Where a reader is taken inside a document: the anchor a link named, or the
 * search occurrence a result pointed at. The location is a value the history
 * keeps beside a source, so it lives here rather than with the Find runtime
 * that eventually delivers it.
 */

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** Why a document is searched on open, which decides how its notices read:
 *  a search result's occurrence, or a passage an Agent reply cited. */
export type DocumentSearchPurpose = 'match' | 'passage';

export interface DocumentSearchTarget extends FindOptions {
  line?: number;
  occurrenceIndex: number;
  pdfPage?: number;
  /** Absent means a search result's match. */
  purpose?: DocumentSearchPurpose;
  query: string;
}

/** A cited passage: its first occurrence, found as the reader would type it. */
export function passageSearchTarget(phrase: string): DocumentSearchTarget {
  return {
    caseSensitive: false,
    occurrenceIndex: 0,
    purpose: 'passage',
    query: phrase,
    wholeWord: false,
  };
}

/** The place inside a document an open lands on. Both absent means the top. */
export interface DocumentLocation {
  scroll?: { top: number; left: number };
  anchor?: string;
  search?: DocumentSearchTarget;
}
