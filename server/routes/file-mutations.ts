import express from 'express';
import {
  detectFormat,
  sanitizeFilename,
} from '../files.ts';
import { toSourcePath } from '../folder.ts';
import { detectViewerFormat } from '../format.ts';
import { sendError } from '../http.ts';
import { planRenameLinks, type RenameEntry } from '../links.ts';
import { bundleRenameEntry } from '../rename-helpers.ts';
import { deleteLibraryFile, moveLibraryFile } from '../library-file-mutations.ts';

export function mountFileMutationRoutes(app: express.Express): void {
  // Active-folder HTTP is only an adapter. The shared library mutation module
  // owns disk changes, link cascades, derived cleanup, file order, and index
  // completion for both UI and MCP callers.
  app.patch('/api/files/*', async (req, res) => {
    const oldName = (req.params as any)[0] as string;
    const requested = typeof req.body?.new_name === 'string' ? req.body.new_name.trim() : '';
    if (!requested) return res.status(400).json({ error: 'new_name required' });
    const oldFormat = detectViewerFormat(oldName);
    if (!oldFormat) return res.status(415).json({ error: 'unsupported format' });
    const oldStructuredFormat = detectFormat(oldName);
    let newName = requested;
    const requestedHasCompatibleExt = hasCompatibleRenameExtension(oldStructuredFormat, oldFormat, newName);
    if (!requestedHasCompatibleExt) {
      const oldExt = oldName.match(/\.[^./]+$/)?.[0] ?? '.md';
      newName += oldExt;
    }
    newName = renameTargetPath(oldName, newName);
    if (newName === oldName) return res.json({ name: oldName, linksUpdated: 0 });
    try {
      const result = await moveLibraryFile(toSourcePath(oldName), toSourcePath(newName), {
        cascade: req.body?.cascade !== false,
      });
      res.json({
        name: newName,
        linksUpdated: result.linksUpdated,
        indexWarning: result.indexWarning,
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.delete('/api/files/*', async (req, res) => {
    const name = (req.params as any)[0] as string;
    try {
      const result = await deleteLibraryFile(toSourcePath(name));
      res.json({ alreadyGone: result.alreadyGone, indexWarning: result.indexWarning });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/rename-preview', (req, res) => {
    const kind = req.body?.kind === 'folder' ? 'folder' : 'file';
    const oldPath = typeof req.body?.old === 'string' ? req.body.old.trim() : '';
    const newPath = typeof req.body?.new === 'string' ? req.body.new.trim() : '';
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: 'old and new required' });
    }
    if (oldPath === newPath) {
      return res.json({ files: 0, links: 0 });
    }
    const renames: RenameEntry[] = [{ kind, old: oldPath, new: newPath }];
    if (kind === 'file') {
      const bundle = bundleRenameEntry(oldPath, newPath, 'pre');
      if (bundle) renames.push(bundle);
    }
    try {
      const plan = planRenameLinks(renames);
      res.json({
        files: plan.length,
        links: plan.reduce((total, entry) => total + entry.changes, 0),
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}

export function hasCompatibleRenameExtension(
  oldStructuredFormat: ReturnType<typeof detectFormat>,
  oldFormat: NonNullable<ReturnType<typeof detectViewerFormat>>,
  requestedName: string,
): boolean {
  if (!oldStructuredFormat) return detectViewerFormat(requestedName) === oldFormat;
  if (oldStructuredFormat === 'json') return detectFormat(requestedName) === 'json';
  if (oldStructuredFormat === 'csv') return detectFormat(requestedName) === 'csv';
  const newFormat = detectFormat(requestedName);
  return newFormat === 'md' || newFormat === 'html';
}

function renameTargetPath(oldName: string, requested: string): string {
  const normalizedRequest = requested.replace(/\\/g, '/');
  if (normalizedRequest.includes('/')) return sanitizeFilename(normalizedRequest);
  const lastSlash = oldName.lastIndexOf('/');
  const parent = lastSlash >= 0 ? oldName.slice(0, lastSlash + 1) : '';
  return sanitizeFilename(parent + normalizedRequest);
}
