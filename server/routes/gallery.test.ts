import assert from 'node:assert/strict';
import express from 'express';
import type { Server as HttpServer } from 'node:http';
import test from 'node:test';
import { mount, resetGalleryProxyCacheForTests } from './gallery.ts';

async function listen(app: express.Express): Promise<{ server: HttpServer; port: number }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, port: address.port };
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('gallery index proxies the configured upstream and serves the cached copy after', async (t) => {
  resetGalleryProxyCacheForTests();
  const payload = { schemaVersion: 1, wikis: [] };
  let upstreamHits = 0;
  const upstreamApp = express();
  upstreamApp.get('/gallery.json', (_req, res) => {
    upstreamHits += 1;
    res.json(payload);
  });
  const upstream = await listen(upstreamApp);
  const proxyApp = express();
  mount(proxyApp);
  const proxy = await listen(proxyApp);
  process.env.STASHBASE_GALLERY_INDEX_URL = `http://127.0.0.1:${upstream.port}/gallery.json`;
  t.after(async () => {
    delete process.env.STASHBASE_GALLERY_INDEX_URL;
    resetGalleryProxyCacheForTests();
    await close(proxy.server);
    await close(upstream.server);
  });

  const first = await fetch(`http://127.0.0.1:${proxy.port}/api/gallery/index`);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), payload);
  const second = await fetch(`http://127.0.0.1:${proxy.port}/api/gallery/index`);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), payload);
  assert.equal(upstreamHits, 1, 'second request must come from the proxy cache');
});

test('gallery index answers an unsupported-schema envelope when every upstream fails', async (t) => {
  resetGalleryProxyCacheForTests();
  // A just-closed listener: connection refused, no 6s timeout wait.
  const dead = await listen(express());
  await close(dead.server);
  const proxyApp = express();
  mount(proxyApp);
  const proxy = await listen(proxyApp);
  process.env.STASHBASE_GALLERY_INDEX_URL = `http://127.0.0.1:${dead.port}/gallery.json`;
  t.after(async () => {
    delete process.env.STASHBASE_GALLERY_INDEX_URL;
    resetGalleryProxyCacheForTests();
    await close(proxy.server);
  });

  // 200 on purpose: a non-OK response would stamp a console error into
  // every offline session; the schemaVersion 0 envelope is what tells the
  // renderer to fall back whole to its bundled snapshot.
  const response = await fetch(`http://127.0.0.1:${proxy.port}/api/gallery/index`);
  assert.equal(response.status, 200);
  const body = await response.json() as { schemaVersion: number; error: string };
  assert.equal(body.schemaVersion, 0);
  assert.ok(body.error.length > 0);
});

test('gallery image proxy refuses sources outside the gallery CDN prefixes', async (t) => {
  const proxyApp = express();
  mount(proxyApp);
  const proxy = await listen(proxyApp);
  t.after(async () => close(proxy.server));

  // The guard is what keeps this from becoming a general-purpose proxy:
  // wrong host, prefix-lookalike host, scheme smuggling, and a missing
  // src must all die at 400 without any upstream fetch.
  const refused = [
    'https://example.com/shot.png',
    'https://assets.stashbase.ai.evil.example/shot.png',
    'http://assets.stashbase.ai/shot.png',
    'file:///etc/passwd',
    '',
  ];
  for (const src of refused) {
    const response = await fetch(
      `http://127.0.0.1:${proxy.port}/api/gallery/image?src=${encodeURIComponent(src)}`,
    );
    assert.equal(response.status, 400, `src ${JSON.stringify(src)} must be refused`);
  }
});
