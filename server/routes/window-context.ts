/** Native BrowserWindow lifecycle routes. Kept independent from folder/project
 * setup so closing a renderer can always retire its request identity quickly. */
import express from 'express';
import { currentWindowId, retireWindow } from '../folder.ts';

export function mount(app: express.Express, onRetire?: (window: string) => Promise<void>): void {
  app.delete('/api/window', async (_req, res) => {
    const window = currentWindowId();
    retireWindow();
    await onRetire?.(window).catch(() => {});
    res.json({ ok: true });
  });
}
