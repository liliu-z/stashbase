import { z } from 'zod';
import { parseGitHubRepositoryUrl } from '../../github-import';

/**
 * The Gallery index: ready-made projects a reader can copy into a local folder.
 *
 * The whole service contract is one published JSON document, fetched through
 * the daemon's proxy because the renderer's CSP pins `connect-src` to `'self'`.
 * Two rules shape this schema.
 *
 * Validate the fields the product uses and strip unknown fields. There is no
 * version gate: adding metadata does not retire an otherwise usable catalog.
 * One unusable entry refuses the whole publication, so callers fall back to
 * the bundled snapshot instead of quietly dropping projects.
 */
const line = (max: number) => z.string().trim().min(1).max(max);

export const galleryEntrySchema = z
  .object({
    id: line(200),
    name: line(200),
    category: line(80),
    description: line(1_000),
    /** Plain text; a blank line separates introduction paragraphs. */
    about: line(8_000).optional(),
    repo: line(2_048).refine((value) => parseGitHubRepositoryUrl(value).ok, {
      message: 'A public HTTPS GitHub repository URL is required.',
    }),
    /** One cover, loaded through the daemon image proxy. */
    screenshot: line(2_048).optional(),
  })
  .strip();

export const galleryIndexSchema = z
  .object({
    /** Bounded for the same reason every array inside an entry is: this
     *  document arrives from a host outside the machine, and a shelf is
     *  browsed by a reader rather than paged. An index past this is a
     *  publication mistake, and refusing it whole falls back to the bundled
     *  snapshot, which is the same answer as any other unreadable index. */
    wikis: z.array(galleryEntrySchema).max(500),
  })
  .strip();

export type GalleryEntryWire = z.infer<typeof galleryEntrySchema>;
export type GalleryIndexWire = z.infer<typeof galleryIndexSchema>;
