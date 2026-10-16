'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  APP_ORIGIN,
  assetPathFromRequest,
  installAppProtocol,
  productionContentSecurityPolicy,
  registerAppScheme,
} = require('./app-protocol.cjs');

test('app scheme is registered as a standard secure fetch-capable origin', () => {
  let registrations;
  registerAppScheme({ registerSchemesAsPrivileged(value) { registrations = value; } });
  assert.deepEqual(registrations, [
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
  assert.equal(APP_ORIGIN, 'app://renderer');
});

test('app protocol resolves only renderer-host assets beneath its build root', () => {
  // Absolute on every host: on Windows a bare `\repo` would gain a drive.
  const root = path.resolve(path.sep, 'repo', 'dist', 'renderer');
  assert.equal(assetPathFromRequest('app://renderer/', root), path.join(root, 'index.html'));
  assert.equal(
    assetPathFromRequest('app://renderer/assets/app.js?cache=1', root),
    path.join(root, 'assets', 'app.js'),
  );
  assert.equal(
    assetPathFromRequest('app://renderer/bug-report.html', root),
    path.join(root, 'bug-report.html'),
  );
  assert.equal(assetPathFromRequest('app://other/index.html', root), null);
  assert.equal(assetPathFromRequest('app://renderer/%2e%2e/secret', root), null);
  assert.equal(assetPathFromRequest('app://renderer/assets%2fsecret', root), null);
});

test('app protocol attaches restrictive CSP to packaged asset responses', async () => {
  let handler;
  let fetched;
  installAppProtocol({
    protocol: { handle(scheme, nextHandler) { assert.equal(scheme, 'app'); handler = nextHandler; } },
    net: {
      async fetch(url) {
        fetched = url;
        return new Response('renderer', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'content-security-policy': "default-src * 'unsafe-inline'",
          },
        });
      },
    },
    rendererRoot: '/repo/dist/renderer',
    serverOrigin: 'http://127.0.0.1:8090',
  });

  const result = await handler({ method: 'GET', url: 'app://renderer/' });
  assert.equal(
    fetched,
    pathToFileURL(path.resolve('/repo/dist/renderer/index.html')).toString(),
  );
  assert.equal(await result.text(), 'renderer');
  assert.equal(result.headers.get('content-type'), 'text/html');
  const csp = result.headers.get('content-security-policy');
  assert.equal(csp, productionContentSecurityPolicy('http://127.0.0.1:8090'));
  assert.match(csp, /^default-src 'none'/u);
  assert.match(csp, /script-src 'self'(?:;|$)/u);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-(?:inline|eval)/u);
  assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:8090 ws:\/\/127\.0\.0\.1:8090/u);
  assert.equal(
    csp.split('; ').find((directive) => directive.startsWith('frame-src ')),
    'frame-src http://127.0.0.1:8090/asset/ http://127.0.0.1:8090/asset-derived/',
  );
  assert.equal(
    csp.split('; ').find((directive) => directive.startsWith('img-src ')),
    "img-src 'self' data: blob: http://127.0.0.1:8090/asset/ http://127.0.0.1:8090/api/gallery/image http://127.0.0.1:8090/api/agent/attachment-preview",
  );
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');

  // The bug-report review page is a second document on the same origin, so it
  // inherits the shell's policy rather than carrying one of its own.
  const reviewPage = await handler({ method: 'GET', url: 'app://renderer/bug-report.html' });
  assert.equal(
    fetched,
    pathToFileURL(path.resolve('/repo/dist/renderer/bug-report.html')).toString(),
  );
  assert.equal(
    reviewPage.headers.get('content-security-policy'),
    productionContentSecurityPolicy('http://127.0.0.1:8090'),
  );

  const denied = await handler({ method: 'POST', url: 'app://renderer/' });
  assert.equal(denied.status, 405);
});
