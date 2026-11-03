import assert from 'node:assert/strict';
import type { Server as HttpServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { createRendererOriginPolicy } from './renderer-origin.ts';

test('renderer origin policy allows the exact app origin and answers preflight', async (t) => {
  const app = express();
  app.use(
    createRendererOriginPolicy(
      new Set(['app://renderer', 'http://127.0.0.1:8090']),
    ),
  );
  app.get('/api/projects', (_req, res) => {
    res.setHeader('x-stashbase-file-version', 'fixture-version');
    res.json({ ok: true });
  });
  app.all(['/asset/font.woff2', '/asset-derived/document.html', '/pdfjs-assets/worker.mjs'], (_req, res) => res.send('resource'));

  let server: HttpServer | undefined = app.listen(0, '127.0.0.1');
  t.after(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('listening', resolve);
    server?.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const allowed = await fetch(`${baseUrl}/api/projects`, {
    headers: { Origin: 'app://renderer' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'app://renderer');
  assert.match(
    allowed.headers.get('access-control-expose-headers') ?? '',
    /x-stashbase-file-version/ui,
  );
  assert.equal(allowed.headers.get('vary'), 'Origin');
  assert.match(allowed.headers.get('access-control-expose-headers') ?? '', /x-request-id/u);

  const preflight = await fetch(`${baseUrl}/api/projects`, {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Headers': 'content-type, x-stashbase-request-id',
      'Access-Control-Request-Method': 'POST',
      Origin: 'app://renderer',
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/u);
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /content-type/u);
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /x-stashbase-request-id/u);
  assert.doesNotMatch(
    preflight.headers.get('access-control-allow-headers') ?? '',
    /x-stashbase-window-id/u,
  );

  const denied = await fetch(`${baseUrl}/api/projects`, {
    headers: { Origin: 'https://example.com' },
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    code: 'BAD_ORIGIN',
    error: 'cross-origin request rejected',
  });

  for (const resource of ['/asset/font.woff2', '/asset-derived/document.html', '/pdfjs-assets/worker.mjs']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(baseUrl + resource, { method, headers: { Origin: 'null' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), 'null');
      assert.equal(response.headers.get('access-control-allow-methods'), 'GET, HEAD');
    }
  }
  for (const [route, method, origin] of [
    ['/api/projects', 'GET', 'null'], ['/api/projects', 'POST', 'null'],
    ['/asset/font.woff2', 'PUT', 'null'], ['/asset/font.woff2', 'OPTIONS', 'null'],
    ['/asset/font.woff2', 'GET', 'https://example.com'], ['/asset-extra/font.woff2', 'GET', 'null'],
  ]) {
    const response = await fetch(baseUrl + route, { method, headers: { Origin: origin } });
    assert.equal(response.status, 403, `${method} ${route} from ${origin}`);
  }
});
