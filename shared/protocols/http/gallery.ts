import { z } from 'zod';
import { AGENT_PERSONA_ICONS, MAX_AGENT_PERSONA_LENGTH } from '../../agent-persona';
import { parseGitHubRepositoryUrl } from '../../github-import';

/**
 * The Gallery index: ready-made Wikis a reader can copy into a project folder,
 * and ready-made personas a reader can add to their library.
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

/** A ready-made persona a reader can add to their own library. Adding takes
 *  a copy; a later publication never changes a persona already added. */
export const galleryPersonaSchema = z
  .object({
    /** Stable slug, never reused. Also the id an added copy remembers. */
    id: line(96).regex(/^[a-z0-9][a-z0-9-]*$/u),
    name: line(80),
    /** One word: `marketing`, `news`, `fiction`, … */
    category: line(80),
    /** One line under the name. */
    description: line(200),
    /** A lucide icon name from the app's set; any other reads as the default. */
    icon: z.enum(AGENT_PERSONA_ICONS).optional().catch(undefined),
    /** The exact text an added persona gives the Agent. */
    prompt: line(MAX_AGENT_PERSONA_LENGTH),
    /** A real exchange under this persona: the request, then the reply the
     *  Agent wrote. What the entry page shows instead of screenshots. */
    sample: z.object({ request: line(2_000), reply: line(16_000) }).strip().optional(),
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
    /** Added after the first publication, so absent reads as none and the
     *  shop keeps its bundled personas. */
    personas: z.array(galleryPersonaSchema).max(500).optional(),
  })
  .strip();

export type GalleryEntryWire = z.infer<typeof galleryEntrySchema>;
export type GalleryPersonaWire = z.infer<typeof galleryPersonaSchema>;
export type GalleryIndexWire = z.infer<typeof galleryIndexSchema>;
