import type express from 'express';

const ALLOWED_METHODS = 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT';
const ALLOWED_HEADERS = 'content-type, x-stashbase-request-id';
const EXPOSED_HEADERS = 'x-stashbase-file-version, x-request-id';

export function createRendererOriginPolicy(
  allowedOrigins: ReadonlySet<string>,
): express.RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    // Sandboxed HTML has an opaque origin. Fonts and modules use CORS even
    // though ordinary images do not. Only reads of independently scoped
    // resources cross this boundary; an opaque frame gains no API authority.
    const documentResource = origin === 'null'
      && (req.method === 'GET' || req.method === 'HEAD')
      && /^\/(?:asset|asset-derived|pdfjs-assets)\//u.test(req.path);
    if (!allowedOrigins.has(origin) && !documentResource) {
      res.status(403).json({ error: 'cross-origin request rejected', code: 'BAD_ORIGIN' });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', documentResource ? 'GET, HEAD' : ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
