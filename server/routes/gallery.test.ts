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
  const payload = { wikis: [] };
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

test('gallery index answers an error envelope when every upstream fails', async (t) => {
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
  // every offline session; the error envelope is what tells the
  // renderer to fall back whole to its bundled snapshot.
  const response = await fetch(`http://127.0.0.1:${proxy.port}/api/gallery/index`);
  assert.equal(response.status, 200);
  const body = await response.json() as { error: string };
  assert.ok(body.error.length > 0);
});

test('gallery image proxy refuses sources outside the gallery CDN prefixes', async (t) => {
  const proxyApp = express();
  mount(proxyApp);
  const proxy = await listen(proxyApp);
  t.after(async () => close(proxy.server));
  const realFetch = globalThis.fetch;
  const outbound = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });

  // The guard is what keeps this from becoming a general-purpose proxy:
  // wrong host, prefix-lookalike host, scheme smuggling, and a missing
  // src must all die at 400 without any upstream fetch.
  const refused = [
    'https://example.com/shot.png',
    'https://assets.stashbase.ai.evil.example/shot.png',
    'http://assets.stashbase.ai/shot.png',
    'file:///etc/passwd',
    'https://assets.stashbase.ai:8443/shot.png',
    'https://user:password@assets.stashbase.ai/shot.png',
    'https://cdn.jsdelivr.net/gh/0-bingwu-0/stashbase-gallery@main/../../attacker/repo@main/x.png',
    'https://cdn.jsdelivr.net/gh/0-bingwu-0/stashbase-gallery@main/%2e%2e%2f%2e%2e%2fattacker/repo/x.png',
    'https://cdn.jsdelivr.net/gh/0-bingwu-0/stashbase-gallery@main/%252e%252e%252fother/x.png',
    'https://cdn.jsdelivr.net/gh/other/repository@main/x.png',
    '',
  ];
  for (const src of refused) {
    const response = await realFetch(
      `http://127.0.0.1:${proxy.port}/api/gallery/image?src=${encodeURIComponent(src)}`,
    );
    assert.equal(response.status, 400, `src ${JSON.stringify(src)} must be refused`);
  }
  assert.equal(outbound.mock.callCount(), 0);
});

test('gallery image proxy serves allowed assets but refuses upstream redirects', async (t) => {
  const upstreamApp = express();
  let privateHits = 0;
  upstreamApp.get('/image', (_req, res) => { res.type('png').send(Buffer.from([1, 2, 3])); });
  upstreamApp.get('/redirect', (_req, res) => res.redirect('/private'));
  upstreamApp.get('/private', (_req, res) => { privateHits++; res.send('must not be read'); });
  const upstream = await listen(upstreamApp);
  const app = express();
  mount(app);
  const proxy = await listen(app);
  t.after(async () => { await close(proxy.server); await close(upstream.server); });
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, options?: RequestInit) => {
    const pathname = new URL(String(input)).pathname.endsWith('/redirect') ? '/redirect' : '/image';
    return realFetch(`http://127.0.0.1:${upstream.port}${pathname}`, options);
  });
  for (const source of ['https://assets.stashbase.ai/screenshots/a.png',
    'https://cdn.jsdelivr.net/gh/0-bingwu-0/stashbase-gallery@main/screenshots/a.png']) {
    const response = await realFetch(`http://127.0.0.1:${proxy.port}/api/gallery/image?src=${encodeURIComponent(source)}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^image\/png/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([1, 2, 3]));
  }
  const response = await realFetch(`http://127.0.0.1:${proxy.port}/api/gallery/image?src=${encodeURIComponent('https://assets.stashbase.ai/redirect')}`);
  assert.equal(response.status, 502);
  await response.json();
  assert.equal(privateHits, 0);
});

test('invalid gallery publications are not cached and recover on the next request', async (t) => {
  resetGalleryProxyCacheForTests();
  const upstreamApp = express();
  let body: unknown;
  let hits = 0;
  upstreamApp.get('/gallery.json', (_req, res) => { hits++; res.json(body); });
  const upstream = await listen(upstreamApp);
  const app = express();
  mount(app);
  const proxy = await listen(app);
  process.env.STASHBASE_GALLERY_INDEX_URL = `http://127.0.0.1:${upstream.port}/gallery.json`;
  t.after(async () => {
    delete process.env.STASHBASE_GALLERY_INDEX_URL;
    resetGalleryProxyCacheForTests();
    await close(proxy.server); await close(upstream.server);
  });
  for (const invalid of [{ wikis: null }, { wikis: [{}] }]) {
    resetGalleryProxyCacheForTests();
    hits = 0;
    body = invalid;
    const url = `http://127.0.0.1:${proxy.port}/api/gallery/index`;
    const failed = await fetch(url);
    assert.equal(failed.status, 200);
    assert.match((await failed.json() as { error: string }).error, /invalid/);
    body = { wikis: [], futureField: 'strip me' };
    assert.deepEqual(await fetch(url).then((res) => res.json()), { wikis: [] });
    assert.deepEqual(await fetch(url).then((res) => res.json()), { wikis: [] });
    assert.equal(hits, 2);
  }
});

test('invalid primary index falls through to the published secondary mirror', async (t) => {
  resetGalleryProxyCacheForTests();
  const app = express(); mount(app);
  const proxy = await listen(app);
  t.after(async () => { resetGalleryProxyCacheForTests(); await close(proxy.server); });
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json({ wikis: calls.length === 1 ? null : [] });
  });
  const response = await realFetch(`http://127.0.0.1:${proxy.port}/api/gallery/index`);
  assert.deepEqual(await response.json(), { wikis: [] });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].startsWith('https://assets.stashbase.ai/'));
  assert.ok(calls[1].startsWith('https://cdn.jsdelivr.net/gh/0-bingwu-0/stashbase-gallery@'));
});
