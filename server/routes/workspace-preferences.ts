/** Application-level Workbench preferences. One durable value today: whether
 * eligible hidden dot-directories join folder listings. The server persists
 * and normalizes it; every window's listing applies the same state. */
import type express from 'express';
import { getWorkspacePreferences, setWorkspacePreferences } from '../app-config.ts';
import { sendError } from '../http.ts';
import { noteTreeChanged } from '../watcher.ts';

export function mount(app: express.Express): void {
  app.get('/api/workspace-preferences', (_req, res) => {
    res.json(getWorkspacePreferences());
  });

  app.put('/api/workspace-preferences', (req, res) => {
    const body = req.body ?? {};
    if (body.showHiddenFiles !== undefined && typeof body.showHiddenFiles !== 'boolean') {
      return res.status(400).json({ error: 'showHiddenFiles must be a boolean' });
    }
    try {
      const resolved = setWorkspacePreferences(body);
      // The visible tree may have changed for every open window; the shared
      // tree-version signal makes each of them refetch `/api/files`.
      noteTreeChanged();
      res.json(resolved);
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}
