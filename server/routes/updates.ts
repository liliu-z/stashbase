/** Desktop update preferences. Release discovery itself stays in Electron. */
import type express from 'express';
import {
  getUpdatePreferences,
  setUpdatePreferences,
} from '../app-config.ts';
import { sendError } from '../http.ts';

export function mount(app: express.Express): void {
  app.get('/api/updates/preferences', (_req, res) => {
    res.json(getUpdatePreferences());
  });

  app.put('/api/updates/preferences', (req, res) => {
    const body = req.body ?? {};
    if (body.autoCheck !== undefined && typeof body.autoCheck !== 'boolean') {
      return res.status(400).json({ error: 'autoCheck must be boolean' });
    }
    try {
      res.json(setUpdatePreferences({
        ...(body.autoCheck !== undefined ? { autoCheck: body.autoCheck } : {}),
      }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}
