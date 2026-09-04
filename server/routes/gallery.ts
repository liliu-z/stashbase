/**
 * Gallery proxy routes.
 *
 * The renderer's CSP pins `connect-src` and `img-src` to 'self' — it can
 * never reach the gallery CDN directly, by design. These two routes are
 * the sanctioned path: the daemon fetches the published index and the
 * curated screenshots, and the renderer talks only to localhost. The
 * image route refuses anything outside the gallery repository's CDN
 * prefix, so it cannot be bent into a general-purpose proxy.
 */
import express from 'express';
import { errorMessage } from '../log.ts';

/** The gallery's own CDN: an R2 bucket behind Cloudflare on our domain,
 *  published by the gallery repository's Action. Index short-cached,
 *  screenshots content-hash-named and immutable. */
export const GALLERY_INDEX_UPSTREAM = 'https://assets.stashbase.ai/gallery.json';

/** Transition fallback while the R2 setup lands: the old jsDelivr
 *  mirror of the gallery repository still serves an index. Remove once
 *  assets.stashbase.ai has been the answer for a while. */
const GALLERY_INDEX_LEGACY =
  'https://cdn.jsdelivr.net/gh/0-bingwu-0/stashbase-gallery@main/gallery.json';

/** Screenshot URLs must live under one of the gallery's own hosts —
 *  nothing else; this proxy must not be bendable into a general one.
 *  The jsDelivr prefix is the same transition legacy as above. */
export const GALLERY_IMAGE_PREFIXES = [
  'https://assets.stashbase.ai/',
  'https://cdn.jsdelivr.net/gh/0-bingwu-0/stashbase-gallery@',
];

const INDEX_TTL_MS = 10 * 60_000;
let cachedIndex: { at: number; body: unknown } | null = null;

export function resetGalleryProxyCacheForTests(): void {
  cachedIndex = null;
}

export function mount(app: express.Express): void {
  // The published index, cached briefly: the gallery is browsed, not
  // watched, and jsDelivr already serves a cached copy upstream.
  app.get('/api/gallery/index', async (_req, res) => {
    if (cachedIndex && Date.now() - cachedIndex.at < INDEX_TTL_MS) {
      return res.json(cachedIndex.body);
    }
    // Dev seam, read per request: point the index at any fresher mirror
    // while editing content (e.g. raw.githubusercontent.com); production
    // defaults to the chain above.
    const configured = process.env.STASHBASE_GALLERY_INDEX_URL;
    const candidates = configured
      ? [configured]
      : [GALLERY_INDEX_UPSTREAM, GALLERY_INDEX_LEGACY];
    let lastError = 'gallery index unreachable';
    for (const candidate of candidates) {
      try {
        const upstream = await fetch(candidate, { signal: AbortSignal.timeout(6000) });
        if (!upstream.ok) {
          lastError = `gallery index upstream ${upstream.status}`;
          continue;
        }
        const body: unknown = await upstream.json();
        cachedIndex = { at: Date.now(), body };
        return res.json(body);
      } catch (err: unknown) {
        lastError = errorMessage(err);
      }
    }
    // Every upstream failed. A 200 envelope with an unsupported
    // schemaVersion, not a 5xx: the renderer's behavior is identical
    // either way (an index it cannot parse falls back WHOLE to the
    // bundled snapshot), and a non-OK response would only stamp a
    // console error into every offline session. `error` names the cause
    // for anyone probing the route directly.
    res.json({ schemaVersion: 0, error: lastError });
  });

  // One screenshot, passed through. The CDN and the browser cache do the
  // heavy lifting; this route only carries bytes across the CSP line.
  app.get('/api/gallery/image', async (req, res) => {
    const src = typeof req.query.src === 'string' ? req.query.src : '';
    if (!GALLERY_IMAGE_PREFIXES.some((prefix) => src.startsWith(prefix))) {
      return res.status(400).json({ error: 'src is not a gallery asset' });
    }
    try {
      const upstream = await fetch(src, { signal: AbortSignal.timeout(15_000) });
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
