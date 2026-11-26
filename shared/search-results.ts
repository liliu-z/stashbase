/**
 * Search result shapes returned to the renderer. The filter vocabulary a
 * request carries lives in `search-types.ts`; this file is what comes back.
 *
 * Search by meaning returns ranked chunks with a hybrid fusion score and
 * optional source locators. Keyword search returns character ranges within
 * specific lines, which
 * is what lets the renderer highlight in place. Nothing useful is gained by
 * forcing them into one type.
 */
import type { z } from 'zod';
import type { exactSearchResponseSchema } from './protocols/http/search.ts';

export interface SearchHit {
  /** The indexer emits an absolute POSIX source path here; the search route
   *  remaps it to a folder-relative display path before responding, so the
   *  renderer never sees the absolute spelling. */
  fileName: string;
  /** Owning member folder root (absolute) and folder-relative visible path.
   *  Present on project semantic responses so a renderer opens a hit in
   *  its own folder identity without splitting `fileName` against roots. */
  folder?: string;
  path?: string;
  chunkIndex: number;
  /** Indexed chunk body — already heading-prefixed for markdown / html. */
  content: string;
  /** Heading breadcrumb (`A › B › C`), or empty if the chunker didn't tag one. */
  heading: string;
  /** 1-based source-line offsets — useful for "jump to line N" UX. */
  startLine?: number;
  endLine?: number;
  /** For hits remapped from a PDF-derived hidden markdown note:
   *  best-known 1-based PDF page. Present when the derived note carries
   *  page markers. */
  pdfPage?: number;
  /** Hybrid (RRF) score, higher = better. Scale is opaque; compare within a
   *  single response only. */
  score: number;
}

/** One keyword-hit file from an explicit Folder query, as the
 *  `/api/keyword-search` response carries it. `folder` retains the selected
 *  member identity so a caller can open the result directly. */
export type ProjectKeywordFile = z.infer<typeof exactSearchResponseSchema>['files'][number];

/** The folder-local hit file the MFS adapter produces, before the route
 *  stamps the member folder on it. */
export type KeywordHitFile = Omit<ProjectKeywordFile, 'folder'>;
