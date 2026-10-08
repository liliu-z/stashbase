/**
 * Gallery proxy routes.
 *
 * The renderer's CSP permits only the local service for Gallery requests;
 * it cannot reach the gallery CDN directly. These two routes are
 * the sanctioned path: the daemon fetches the published index and the
 * curated screenshots, and the renderer talks only to localhost. The
 * image route validates the normalized CDN origin and repository path and
 * refuses redirects, rather than acting as a general-purpose proxy.
 */
import express from 'express';
import { errorMessage } from '../log.ts';
import { galleryIndexSchema, type GalleryIndexWire } from '../../shared/protocols/http/gallery.ts';

/** The gallery's own CDN: an R2 bucket behind Cloudflare on our domain,
 *  published by the gallery repository's Action. Index short-cached,
 *  screenshots content-hash-named and immutable. */
export const GALLERY_INDEX_UPSTREAM = 'https://assets.stashbase.ai/gallery.json';

/** The still-published secondary mirror, retained for index compatibility. */
const GALLERY_INDEX_LEGACY =
  'https://cdn.jsdelivr.net/gh/0-bingwu-0/stashbase-gallery@main/gallery.json';

function galleryImageUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const pathname = decodeURIComponent(url.pathname);
    // Refuse encoded separators/traversal that a CDN might normalize again.
    if (/[\\%]/.test(pathname) || pathname.split('/').some((part) => part === '.' || part === '..')) return null;
    if (url.origin === 'https://assets.stashbase.ai') return url.href;
    if (url.origin === 'https://cdn.jsdelivr.net'
      && /^\/gh\/0-bingwu-0\/stashbase-gallery@[^/]+\/.+/.test(pathname)) return url.href;
  } catch { /* Invalid URLs never reach fetch. */ }
  return null;
}

const INDEX_TTL_MS = 10 * 60_000;
let cachedIndex: { at: number; source: string; body: GalleryIndexWire } | null = null;

export function resetGalleryProxyCacheForTests(): void {
  cachedIndex = null;
}

export function mount(app: express.Express): void {
  // Cache only a whole, validated publication.
  app.get('/api/gallery/index', async (_req, res) => {
    // Dev seam, read per request: point the index at any fresher mirror
    // while editing content (e.g. raw.githubusercontent.com); production
    // defaults to the chain above.
    const configured = process.env.STASHBASE_GALLERY_INDEX_URL;
    const candidates = configured
      ? [configured]
      : [GALLERY_INDEX_UPSTREAM, GALLERY_INDEX_LEGACY];
    const source = candidates.join('\n');
    if (cachedIndex?.source === source && Date.now() - cachedIndex.at < INDEX_TTL_MS) {
      return res.json(cachedIndex.body);
    }
    let lastError = 'gallery index unreachable';
    for (const candidate of candidates) {
      try {
        const upstream = await fetch(candidate, { signal: AbortSignal.timeout(6000), redirect: 'error' });
        if (!upstream.ok) {
          lastError = `gallery index upstream ${upstream.status}`;
          continue;
        }
        const parsed = galleryIndexSchema.safeParse(await upstream.json());
        if (!parsed.success) {
          lastError = 'gallery index schema is invalid';
          continue;
        }
        cachedIndex = { at: Date.now(), source, body: parsed.data };
        return res.json(parsed.data);
      } catch (err: unknown) {
        lastError = errorMessage(err);
      }
    }
    // An error envelope is not a catalog. The renderer keeps its bundled
    // snapshot without producing an HTTP error in every offline session.
    res.json({ error: lastError });
  });

  // One screenshot, passed through. The CDN and the browser cache do the
  // heavy lifting; this route only carries bytes across the CSP line.
  app.get('/api/gallery/image', async (req, res) => {
    const src = galleryImageUrl(typeof req.query.src === 'string' ? req.query.src : '');
    if (!src) {
      return res.status(400).json({ error: 'src is not a gallery asset' });
    }
    try {
      const upstream = await fetch(src, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (!upstream.ok) {
        return res.status(502).json({ error: `gallery image upstream ${upstream.status}` });
      }
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err: unknown) {
      res.status(502).json({ error: errorMessage(err) });
    }
  });
}
