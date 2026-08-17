/** User-wide opt-ins for ambient knowledge capture. */
import type express from 'express';
import {
  getCapturePreferences,
  setCapturePreferences,
} from '../app-config.ts';
import { sendError } from '../http.ts';

export function mount(app: express.Express): void {
  app.get('/api/capture', (_req, res) => {
    res.json(getCapturePreferences());
  });

  app.put('/api/capture', (req, res) => {
    const body = req.body ?? {};
    if (
      body.clipboardImageImport !== undefined
      && typeof body.clipboardImageImport !== 'boolean'
    ) {
      return res.status(400).json({ error: 'clipboardImageImport must be boolean' });
    }
    try {
      res.json(setCapturePreferences({
        ...(body.clipboardImageImport !== undefined
          ? { clipboardImageImport: body.clipboardImageImport }
          : {}),
      }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}
