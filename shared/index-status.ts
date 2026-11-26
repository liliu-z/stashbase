/** The `GET /api/index-status` response contract.
 *
 *  This is the folder-scoped status the sidebar, search banner, and preview
 *  banners poll. It is a superset of the indexer's own status
 *  (`IndexerStatus` in `server/indexer.ts`): the route re-derives the path
 *  lists as folder-relative visible paths and folds in embedding
 *  availability, conversion scheduling, and preparation failures.
 *
 *  The schema in `protocols/http/index-status.ts` is the single source of
 *  truth; these types are what `buildIndexStatus` in `server/index-status.ts`
 *  produces. Types only — no runtime, no Node imports.
 */
import type { z } from 'zod';
import type {
  indexStatusResponseSchema,
  preparationFailureSchema,
  semanticIndexingStateSchema,
} from './protocols/http/index-status.ts';

/** Coarse embedding-readiness label the renderer renders directly. */
export type SemanticIndexingState = z.output<typeof semanticIndexingStateSchema>;

/** Persistent file preparation failure record — subset of the on-disk
 *  entry, with timestamps the UI doesn't need stripped. */
export type PreparationFailure = z.output<typeof preparationFailureSchema>;

/** The fields the server builds. The schema tolerates unknown extra fields
 *  (`passthrough`) for older renderers; `strip` drops that index signature so
 *  the server's own object stays exactly typed. */
export type IndexStatus = z.output<ReturnType<(typeof indexStatusResponseSchema)['strip']>>;
