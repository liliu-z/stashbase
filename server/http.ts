/**
 * HTTP-layer helpers used by every route module: error envelope,
 * folder-open gate, OpenAI-key validator, and the OS file-manager
 * spawn (used by the reveal route).
 *
 * Kept separate from the route files so they can be imported without
 * pulling in Express route registration side effects.
 */
import express from 'express';
import childProcess from 'node:child_process';
import path from 'node:path';
import { logger, errorMessage, errorCode } from './log.ts';
import { getCurrentFolder, runWithWindowId, WINDOW_ID_HEADER } from './folder.ts';

const log = logger('http');

/** Standard error envelope: `{ error: string, code?: string }` with an
 *  HTTP status code chosen by the situation. `NO_FOLDER` translates a
 *  thrown `requireCurrentFolder` failure from the files layer into the
 *  conventional 412 the client expects. */
export function sendError(res: express.Response, err: unknown): void {
  if (errorCode(err) === 'NO_FOLDER') {
    res.status(412).json({ error: 'no folder open', code: 'NO_FOLDER' });
    return;
  }
  if (errorCode(err) === 'FOLDER_NOT_FOUND') {
    res.status(404).json({ error: 'folder not found', code: 'FOLDER_NOT_FOUND' });
    return;
  }
  if (errorCode(err) === 'FILE_CHANGED') {
    res.status(409).json({
      error: errorMessage(err),
      code: 'FILE_CHANGED',
      currentVersion: (err as { currentVersion?: unknown }).currentVersion ?? null,
    });
    return;
  }
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status <= 599) {
    const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined;
    res.status(status).json({ error: errorMessage(err), ...(code ? { code } : {}) });
    return;
  }
  res.status(500).json({ error: errorMessage(err) });
}

/** Express middleware: 412 when no folder is currently open. Mounted on
 *  the path prefixes (/api/files, /api/folders, /api/search, …) that
 *  rely on `getCurrentFolder()` returning a value. Routes that work
 *  before a folder is open (welcome screen) stay outside the prefix. */
const FOLDER_EXPLICIT_ROUTES = new Set([
  'POST /api/files/prepare',
  'POST /api/files/reprocess',
  'POST /api/files/cancel-preparation',
]);

export const requireFolder: express.RequestHandler = (req, res, next) => {
  if (!getCurrentFolder()) {
    const route = `${req.method.toUpperCase()} ${req.baseUrl}${req.path}`;
    const explicitFolder = req.body?.folder;
    if (FOLDER_EXPLICIT_ROUTES.has(route) && typeof explicitFolder === 'string' && explicitFolder.trim()) {
      return next();
    }
    return res.status(412).json({ error: 'no folder open', code: 'NO_FOLDER' });
  }
  next();
};

export const withWindowContext: express.RequestHandler = (req, _res, next) => {
  // The header is the primary channel — every fetch via `api.ts` sets
  // it. Browser-loaded URLs (`<img src="/asset/…">`, iframe src) can't
  // attach custom headers, so assets carry either a legacy `?windowId=`
  // query or the path form `/asset/__window/<id>/...` /
  // `/asset-derived/__window/<id>/...`. The path form is
  // required for iframe `<base href>` because relative image/css/font
  // URLs inherit the base path, but not its query string.
  const header = req.header(WINDOW_ID_HEADER);
  const fromQuery = typeof req.query.windowId === 'string' ? req.query.windowId : undefined;
  const fromAssetPath = assetWindowIdFromPath(req.path);
  runWithWindowId(header ?? fromQuery ?? fromAssetPath, next);
};

function assetWindowIdFromPath(reqPath: string): string | undefined {
  const prefix = reqPath.startsWith('/asset-audio-preview/__window/')
    ? '/asset-audio-preview/__window/'
    : reqPath.startsWith('/asset-derived/__window/')
    ? '/asset-derived/__window/'
    : reqPath.startsWith('/asset-preview-grant/__window/')
    ? '/asset-preview-grant/__window/'
    : reqPath.startsWith('/asset/__window/')
      ? '/asset/__window/'
      : null;
  if (!prefix) return undefined;
  const rest = reqPath.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return undefined;
  try {
    return decodeURIComponent(rest.slice(0, slash));
  } catch {
    return undefined;
  }
}

export type EmbedderKeyCheck = { ok: true } | { ok: false; status: number; error: string };
const EMBEDDER_KEY_CHECK_TIMEOUT_MS = 15_000;
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

function failedEmbedderKeyCheck(
  providerName: string,
  response: Response,
  detail: string,
): EmbedderKeyCheck {
  const rejected = response.status === 401 || response.status === 403;
  return {
    ok: false,
    status: rejected ? 400 : 502,
    error: rejected
      ? `${providerName} rejected the key (HTTP ${response.status}): ${detail.slice(0, 200)}`
      : `${providerName} key check could not complete (HTTP ${response.status}): ${detail.slice(0, 200)}`,
  };
}

/** Probe an embedding API key against the provider's `/models` endpoint —
 *  cheap auth validation with no embedding credits consumed. OpenAI keys
 *  restricted to the embeddings endpoint cannot list models, so an explicit
 *  `api.model.read` rejection falls back to one minimal request against the
 *  model StashBase actually uses. `status` carries the HTTP status the caller
 *  should respond with: 400 when the provider rejected the key, 502 when the
 *  check could not prove the key invalid (network / transient upstream
 *  failure). */
export async function validateEmbedderKey(
  provider: 'openai' | 'openrouter',
  key: string,
  opts: { timeoutMs?: number } = {},
): Promise<EmbedderKeyCheck> {
  const providerName = provider === 'openrouter' ? 'OpenRouter' : 'OpenAI';
  const modelsUrl = provider === 'openrouter'
    ? 'https://openrouter.ai/api/v1/models'
    : 'https://api.openai.com/v1/models';
  try {
    const r = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? EMBEDDER_KEY_CHECK_TIMEOUT_MS),
    });
    if (r.ok) return { ok: true };
    const detail = await r.text().catch(() => '');
    if (provider === 'openai' && r.status === 403 && detail.includes('api.model.read')) {
      const embeddingResponse = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: OPENAI_EMBEDDING_MODEL, input: 'StashBase' }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? EMBEDDER_KEY_CHECK_TIMEOUT_MS),
      });
      if (embeddingResponse.ok) return { ok: true };
      const embeddingDetail = await embeddingResponse.text().catch(() => '');
      return failedEmbedderKeyCheck(providerName, embeddingResponse, embeddingDetail);
    }
    return failedEmbedderKeyCheck(providerName, r, detail);
  } catch (err: unknown) {
    return { ok: false, status: 502, error: `network: ${errorMessage(err)}` };
  }
}

/** Open the OS file manager focused on the given absolute path. macOS
 *  `open -R` selects the file in Finder; Windows uses `explorer /select`;
 *  Linux falls back to opening the containing directory since most
 *  desktops don't have a portable "reveal one file" command. */
export function revealInOsFileManager(absPath: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = ['-R', absPath];
  } else if (process.platform === 'win32') {
    cmd = 'explorer.exe';
    args = [`/select,${absPath}`];
  } else {
    cmd = 'xdg-open';
    args = [path.dirname(absPath)];
  }
  const proc = childProcess.spawn(cmd, args, { detached: true, stdio: 'ignore' });
  proc.on('error', (err) => {
    log.warn(`reveal: spawn ${cmd} failed: ${err.message}`);
  });
  proc.unref();
}
