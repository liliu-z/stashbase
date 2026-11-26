import { z } from 'zod';

const folderPathSchema = z.string().trim().min(1).max(4096);
const relativePathSchema = z.string().trim().min(1).max(4096);
const countSchema = z.number().int().nonnegative();
const laneSchema = z.enum(['light', 'heavy']);

export const conversionProgressSchema = z.discriminatedUnion('phase', [
  z.object({ lane: laneSchema, phase: z.literal('queued'), tasksAhead: countSchema }).strict(),
  z.object({ lane: laneSchema, phase: z.literal('yielded'), tasksAhead: countSchema }).strict(),
  z
    .object({
      currentPage: z.number().int().positive().optional(),
      phase: z.literal('extracting'),
    })
    .strict(),
  z.object({ phase: z.literal('indexing') }).strict(),
]);

export const preparationFailureSchema = z
  .object({
    attempts: countSchema,
    lastError: z.string().max(4096),
    path: relativePathSchema,
    status: z.enum(['failed', 'cancelled']),
  })
  .strict();

export const semanticIndexingStateSchema = z.enum([
  'disabled',
  'indexing',
  'partial-indexing',
  'ready',
  'failed',
]);

const semanticIndexingStatusSchema = z
  .object({
    state: semanticIndexingStateSchema,
  })
  .strict();

const indexWarningSchema = z
  .object({ at: z.string().min(1).max(64), message: z.string().max(4096) })
  .strict();

/** `GET /api/index-status?folder=` — the folder-scoped preparation and AI
 *  Index snapshot. Unknown extra fields are tolerated so a server that adds
 *  display-only counters does not invalidate an older renderer. */
export const indexStatusResponseSchema = z
  .object({
    /** Conversion progress keyed by visible source path. Used by PDF/image
     *  preview banners for queue/extraction/indexing copy. */
    conversionProgress: z.record(relativePathSchema, conversionProgressSchema),
    /** Global in-memory scheduler change counter. Display-only notification;
     *  derived artifacts remain the conversion source of truth. */
    conversionRevision: countSchema,
    /** Per-source refresh tokens for derived previews. */
    conversionVersions: z.record(relativePathSchema, countSchema),
    /** Absolute path of the folder this status describes. */
    folder: folderPathSchema,
    /** False until the folder has received at least one daemon status response. */
    indexReady: z.boolean().default(false),
    indexWarning: indexWarningSchema.nullable().default(null),
    /** Files on disk that already have rows in the index. */
    indexed: countSchema,
    /** Index rows whose source is gone from disk. */
    orphaned: z.array(z.string()).max(100_000),
    orphanedCount: countSchema,
    /** UI-visible sources waiting to be embedded, as display paths. Empty
     *  whenever semantic indexing is unavailable — unlike the indexer's own
     *  `pending`, which is absolute and unfiltered. */
    pending: z.array(relativePathSchema).max(100_000),
    /** Sources that are queued or running. */
    pendingConversions: z.array(relativePathSchema).max(100_000),
    pendingCount: countSchema,
    /** Persistent preparation failures; survive app restart (AppData
     *  `state.db`). Drive row markers, viewer banners, and Reprocess. */
    preparationFailures: z.array(preparationFailureSchema).max(100_000),
    semanticIndexing: semanticIndexingStatusSchema,
    /** Files on disk that look indexable. */
    total: countSchema,
    /** Bumped on every external fs event (after self-write filtering); the
     *  renderer refetches `/api/files` on change. */
    treeVersion: countSchema,
    /** True iff the indexer sees no pending and no orphaned rows, over its
     *  unfiltered lists rather than the visible ones above. */
    upToDate: z.boolean(),
    /** True when no UI-visible file is waiting for embedding; ignores
     *  orphaned/hidden rows irrelevant to search readiness. */
    visibleIndexingSettled: z.boolean(),
  })
  .passthrough();

export const indexStatusFailureSchema = z
  .object({
    code: z.string().trim().min(1).max(64).optional(),
    error: z.string().trim().min(1).max(500),
  })
  .passthrough();

export const indexStatusAcknowledgementSchema = z.object({ ok: z.literal(true) }).passthrough();

/** `POST /api/sync?folder=` — the folder-explicit reconcile the renderer
 *  requests after an Agent changes files. Only cancellation matters to the
 *  renderer; the change lists are display-only. */
export const folderSyncResponseSchema = z
  .object({ cancelled: z.boolean().optional() })
  .passthrough();

export type IndexStatusResponseWire = z.infer<typeof indexStatusResponseSchema>;
