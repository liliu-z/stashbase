/**
 * The Gallery index transport.
 *
 * Both the published index and screenshots cross the daemon's proxy. The
 * packaged app origin serves bundled files, so proxy URLs use the server origin.
 * The proxy bounds which external hosts the shop can reach.
 *
 * Nothing here throws. An unreachable index and an unreadable one are the same
 * outcome to a shop that always has the bundled snapshot to fall back to, and
 * the route already answers total failure with a success envelope carrying an
 * error envelope so an offline session prints no console error. Treating a
 * refusal as an exception would put that error back.
 */
import type { GalleryPort } from '@/features/gallery/application/ports';
import type { GalleryEntry } from '@/features/gallery/domain/entry';
import type { GalleryPersona } from '@/features/gallery/domain/persona';
import type { HttpClient } from '@/platform/http/client';
import {
  galleryIndexSchema,
  type GalleryEntryWire,
  type GalleryPersonaWire,
} from '@/protocols/http/gallery';

const GALLERY_INDEX_PATH = '/api/gallery/index';
const GALLERY_IMAGE_PATH = '/api/gallery/image';

/** Published screenshot URLs are absolute CDN links the renderer may not load.
 *  Anything already relative passes through: a future local asset is not a
 *  proxy's business. */
function proxied(url: string, serverOrigin: string): string {
  return /^https?:\/\//iu.test(url)
    ? new URL(`${GALLERY_IMAGE_PATH}?src=${encodeURIComponent(url)}`, serverOrigin).href
    : url;
}

function toEntry(wire: GalleryEntryWire, serverOrigin: string): GalleryEntry {
  return {
    about: wire.about ?? null,
    category: wire.category,
    description: wire.description,
    id: wire.id,
    name: wire.name,
    repo: wire.repo,
    screenshot: wire.screenshot ? proxied(wire.screenshot, serverOrigin) : null,
  };
}

function toPersona(wire: GalleryPersonaWire): GalleryPersona {
  return {
    category: wire.category,
    description: wire.description,
    icon: wire.icon ?? null,
    id: wire.id,
    name: wire.name,
    prompt: wire.prompt,
    sample: wire.sample ?? null,
  };
}

export function createGalleryIndexAdapter(
  client: HttpClient,
  serverOrigin: string,
): Pick<GalleryPort, 'loadIndex'> {
  return {
    async loadIndex(signal) {
      try {
        const response = await client.request({ path: GALLERY_INDEX_PATH, signal });
        if (response.status < 200 || response.status >= 300) return null;
        const index = galleryIndexSchema.safeParse(response.body);
        if (!index.success) return null;
        return {
          personas: index.data.personas?.map(toPersona) ?? null,
          wikis: index.data.wikis.map((entry) => toEntry(entry, serverOrigin)),
        };
      } catch {
        return null;
      }
    },
  };
}
