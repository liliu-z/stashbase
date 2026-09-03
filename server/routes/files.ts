/** Active-folder file surface. This module owns note list/create/read/write
 * and reveal, then composes mutation, ordering, and asset subroutes. */
import express from 'express';
import {
  createTextExclusiveAsync,
  detectFormat,
  fileVersionAsync,
  fileStatVersionAsync,
  getCurrentFolderBasename,
  listFilesAndFoldersAsync,
  pathExists,
  pathExistsAsync,
  readTextAsync,
  resolveExistingAsync,
  sanitizeFilename,
} from '../files.ts';
import { detectViewerFormat, isNoteName } from '../format.ts';
import { getWorkspacePreferences } from '../app-config.ts';
import { exactMemberFolderRootAsync, getCurrentFolderLabel, runWithFolderRoot } from '../folder.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { sendError, revealInOsFileManager } from '../http.ts';
import { noteTreeChanged } from '../watcher.ts';
import { saveFileContent, upsertSavedFile } from '../file-save.ts';
import { readGenericFilePreview } from '../generic-file-preview.ts';
import { mountFileAssetRoutes } from './file-assets.ts';
import { mountFileMutationRoutes } from './file-mutations.ts';
import { mountFileOrderRoutes } from './file-order.ts';

export { prepareFileOperation } from '../file-operation-guard.ts';
export { saveFileContent, validateEditableFileWrite } from '../file-save.ts';

export function fileHeadStatus(name: string): number {
  const format = detectViewerFormat(name);
  if (!format) return 415;
  if (!pathExists(name)) return 404;
  return 204;
}

export async function fileHeadStatusAsync(name: string): Promise<number> {
  const format = detectViewerFormat(name);
  if (!format) return 415;
  return (await pathExistsAsync(name)) ? 204 : 404;
}

/** Run a READ handler against an explicit `?folder=` member folder when the
 *  request carries one; otherwise against the window's own folder. Same
 *  membership rule as the `/api/files?folder=` listing above. */
async function runWithExplicitReadFolder(
  req: express.Request,
  res: express.Response,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  const rawFolder = typeof req.query.folder === 'string' ? req.query.folder.trim() : '';
  if (!rawFolder) {
    await fn();
    return;
  }
  const member = filesystemPath.isAbsolute(rawFolder) ? await exactMemberFolderRootAsync(rawFolder) : null;
  if (!member) {
    res.status(400).json({ error: 'folder is not a registered library folder' });
    return;
  }
  await runWithFolderRoot(member, fn).catch((err: unknown) => sendError(res, err));
}

async function handleWriteFile(req: express.Request, res: express.Response): Promise<void> {
  const content = (req.body ?? {}).content;
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content (string) required' });
    return;
  }
  const name = (req.params as any)[0] as string;
  const baseVersion = typeof (req.body ?? {}).baseVersion === 'string'
    ? (req.body ?? {}).baseVersion
    : undefined;
  try {
    res.json(await saveFileContent(name, content, { baseVersion }));
  } catch (err: unknown) {
    sendError(res, err);
  }
}

export function mount(app: express.Express): void {
  // ----- list -----
  // Optional `?folder=` lists an explicit library-member folder for Agent
  // mention/attachment validation. It intentionally keeps the default-safe
  // listing regardless of the Workbench preference: showing hidden rows never
  // widens Agent discovery. Membership is still validated here.
  app.get('/api/files', async (req, res) => {
    try {
      // Application-level Workbench visibility applies only to the current
      // window listing. Explicit member listings are Agent-facing.
      const showHidden = getWorkspacePreferences().showHiddenFiles;
      const rawFolder = typeof req.query.folder === 'string' ? req.query.folder.trim() : '';
      if (rawFolder) {
        const member = filesystemPath.isAbsolute(rawFolder)
          ? await exactMemberFolderRootAsync(rawFolder)
          : null;
        if (!member) {
          return res.status(400).json({ error: 'folder is not a registered library folder' });
        }
        const result = await runWithFolderRoot(member, async () => ({
          folder: getCurrentFolderLabel() ?? getCurrentFolderBasename(),
          files: await listFilesAndFoldersAsync(),
        }));
        res.json({
          folder: result.folder,
          files: result.files.files,
          folders: result.files.folders,
          showHiddenFiles: false,
        });
        return;
      }
      const listing = await listFilesAndFoldersAsync({ showHidden });
      res.json({
        folder: getCurrentFolderLabel() ?? getCurrentFolderBasename(),
        files: listing.files,
        folders: listing.folders,
        showHiddenFiles: showHidden,
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // ----- create -----
  // Body: { name?, content?, dir? }.
  //  - `name` omitted → auto-pick first free `untitled-N.md` (race-safe via O_EXCL).
  //  - `dir`  optional → place the file inside that folder-relative folder
  //    (must already exist; create with POST /api/folders first).
  // New Note is intentionally Markdown even though existing JSON and TXT
  // sources have their own editing surfaces (HTML remains preview-only here).
  app.post('/api/files', async (req, res) => {
    const requestedName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const dir = typeof req.body?.dir === 'string' ? req.body.dir.trim() : '';
    const ext = '.md';
    const prefix = dir ? dir.replace(/\/+$/, '') + '/' : '';
    try {
      let name: string;
      if (requestedName) {
        // Honour an extension the caller already typed; otherwise
        // attach Markdown. Existing note extensions remain recognized so an
        // explicit .html request is not rewritten to .html.md.
        const hasExt = isNoteName(requestedName);
        const base = hasExt ? requestedName : requestedName + ext;
        // Silently scrub characters that break cross-platform sync —
        // user keeps the original title in the file's first heading.
        name = sanitizeFilename(prefix + base);
        if (!(await createTextExclusiveAsync(name, content))) {
          return res.status(409).json({ error: 'file exists' });
        }
      } else {
        const MAX_TRIES = 10_000;
        let i = 1;
        let claimed = '';
        for (; i <= MAX_TRIES; i++) {
          const candidate = `${prefix}untitled-${i}${ext}`;
          if (await createTextExclusiveAsync(candidate, content)) {
            claimed = candidate;
            break;
          }
        }
        if (!claimed) throw new Error(`could not find a free untitled-N (tried ${MAX_TRIES})`);
        name = claimed;
      }
      const indexWarning = await upsertSavedFile(name, content);
      noteTreeChanged();
      res.json({ name, content, indexWarning, version: (await fileVersionAsync(name)) ?? undefined });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // HEAD and GET accept an optional `?folder=` (validated member folder) so
  // an out-of-folder tab — a search result viewed without switching the
  // window's folder — can read by explicit folder. Reads only: every write
  // route below stays bound to the window's own folder.
  app.head('/api/files/*', (req, res) => {
    const name = (req.params as any)[0] as string;
    void runWithExplicitReadFolder(req, res, async () => {
      try {
        const status = await fileHeadStatusAsync(name);
        if (status === 204) {
          const version = await fileStatVersionAsync(name);
          if (version) res.setHeader('x-stashbase-file-version', version);
        }
        res.sendStatus(status);
      } catch (err: unknown) {
        sendError(res, err);
      }
    });
  });

  // Renderer liveness checks use JSON rather than fetch HEAD: Electron's
  // network observer reports successful HEAD requests as ERR_ABORTED, which
  // makes routine cross-window tab retention indistinguishable from a real
  // request failure in release E2E diagnostics.
  app.get('/api/file-stat/*', (req, res) => {
    const name = (req.params as any)[0] as string;
    void runWithExplicitReadFolder(req, res, async () => {
      try {
        const status = await fileHeadStatusAsync(name);
        if (status !== 204) return res.status(status).json({ error: status === 404 ? 'not found' : 'unsupported format' });
        res.json({ version: (await fileStatVersionAsync(name)) ?? undefined });
      } catch (err: unknown) {
        sendError(res, err);
      }
    });
  });

  // Generic workspace entries are inspected only when selected. Keeping this
  // route separate from `/api/files/*` prevents a workbench-only capability
  // from becoming an editable, indexable, or Agent-readable document.
  app.get('/api/file-preview/*', (req, res) => {
    const name = (req.params as any)[0] as string;
    void runWithExplicitReadFolder(req, res, () => {
      try {
        res.json(readGenericFilePreview(name));
      } catch (err: unknown) {
        sendError(res, err);
      }
    });
  });

  // ----- read -----
  app.get('/api/files/*', (req, res) => {
    const name = (req.params as any)[0] as string;
    void runWithExplicitReadFolder(req, res, async () => {
      try {
        // Refuse anything outside the recognized direct-text formats. Bundle assets
        // (the PNG / CSS / WOFF that live alongside an arxiv html in its
        // `_files/` folder) get saved to disk so the iframe can pull them
        // via `/asset/*`, but they're not viewable through this route —
        // a `readText` of binary bytes would otherwise hand the editor
        // garbled UTF-8 to render.
        const format = detectFormat(name);
        if (!format) return res.status(415).json({ error: 'unsupported format' });
        let content: string | null;
        try {
          content = await readTextAsync(name);
        } catch (err: unknown) {
          if ((err as { code?: unknown })?.code !== 'UNSUPPORTED_ENCODING') throw err;
          return res.json({
            name,
            format,
            content: '',
            version: (await fileVersionAsync(name)) ?? undefined,
            error: { code: 'UNSUPPORTED_ENCODING', message: err instanceof Error ? err.message : String(err) },
          });
        }
        if (content == null) return res.status(404).json({ error: 'not found' });
        // Raw HTML in `content` (what the editor needs); the preview iframe
        // loads its prepared version via `/asset/*` — keeping injected ids +
        // bootstrap script out of the bytes that round-trip through the
        // editor (otherwise autosave would rewrite the file to include them).
        res.json({ name, format, content, version: (await fileVersionAsync(name)) ?? undefined });
      } catch (err: unknown) {
        sendError(res, err);
      }
    });
  });

  // ----- write -----
  // Overwrite a file's content and rebuild its index entry. `upsertFile`
  // deletes existing rows for this source before inserting the freshly
  // chunked + embedded set, so a save reflects edits cleanly.
  app.put('/api/files/*', async (req, res) => {
    await handleWriteFile(req, res);
  });

  // `navigator.sendBeacon()` always sends POST. The renderer uses it in
  // `beforeunload` for the last unsaved buffer, so accept POST on the
  // file-specific path as an unload-safe alias for PUT. Creation remains
  // `POST /api/files` above; this wildcard route does not match that
  // exact path.
  app.post('/api/files/*', async (req, res) => {
    await handleWriteFile(req, res);
  });

  mountFileMutationRoutes(app);

  // ----- reveal in OS -----
  // The renderer sends the folder-relative name and we resolve + shell
  // out here. Fire-and-forget spawn; we just confirm the file exists
  // before launching.
  app.post('/api/reveal/*', async (req, res) => {
    const name = (req.params as any)[0] as string;
    try {
      const abs = await resolveExistingAsync(name);
      if (!abs) return res.status(404).json({ error: 'not found' });
      revealInOsFileManager(abs);
      res.json({});
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  mountFileOrderRoutes(app);
  mountFileAssetRoutes(app);
}
