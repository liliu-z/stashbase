import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const isolatedEnvNames = [
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'XDG_DATA_HOME',
  'STASHBASE_LOCAL_DATA_ROOT',
] as const;

test('window cleanup route retires its header identity and cannot be undone by a late open', async (t) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-window-route-'));
  const originalEnv = new Map(isolatedEnvNames.map((name) => [name, process.env[name]]));
  let server: HttpServer | undefined;

  t.after(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.LOCALAPPDATA = path.join(testHome, 'LocalAppData');
  process.env.XDG_DATA_HOME = path.join(testHome, 'xdg-data');
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(testHome, 'stashbase-data');

  const [
    { default: express },
    folder,
    { withWindowContext },
    windowContextRoutes,
  ] = await Promise.all([
    import('express'),
    import('./folder.ts'),
    import('./http.ts'),
    import('./routes/window-context.ts'),
  ]);

  const first = path.join(testHome, 'first');
  const second = path.join(testHome, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);

  const app = express();
  app.use(express.json());
  app.use(withWindowContext);
  app.post('/api/test/open', async (req, res) => {
    try {
      await folder.openProjectFolder(req.body.path);
      res.json({ ok: true });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'WINDOW_CLOSED') {
        return res.status(410).json({ error: 'window is closed', code: 'WINDOW_CLOSED' });
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  const released: string[] = [];
  windowContextRoutes.mount(app, async (windowId) => { released.push(windowId); });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server?.once('listening', resolve);
    server?.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const open = (windowId: string, folderPath: string) => fetch(`${base}/api/test/open`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-stashbase-window-id': windowId,
    },
    body: JSON.stringify({ path: folderPath }),
  });
  const close = (windowId: string) => fetch(`${base}/api/window`, {
    method: 'DELETE',
    headers: { 'x-stashbase-window-id': windowId },
  });

  assert.equal((await open('window-1', first)).status, 200);
  assert.equal((await open('window-2', second)).status, 200);
  assert.equal((await close('window-1')).status, 200);
  assert.deepEqual(released, ['window-1']);

  const lateOpen = await open('window-1', first);
  assert.equal(lateOpen.status, 410);
  const latePayload = await lateOpen.json() as { code?: string };
  assert.equal(latePayload.code, 'WINDOW_CLOSED');

  const active = folder.getActiveFolders();
  assert.equal(active.some((entry) => entry.windowId === 'window-1'), false);
  assert.equal(active.some((entry) => entry.windowId === 'window-2'), true);
  for (const entry of active) folder.clearCurrentFolder(entry.windowId);
});
