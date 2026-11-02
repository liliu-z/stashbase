import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { oauthResultPage } from './oauth-result-page.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('source callbacks never launch the installed app or bare Electron', () => {
  const html = oauthResultPage({ title: 'Signed in', message: 'Ready', autoReturn: true });
  assert.doesNotMatch(html, /stashbase:\/\//);
  assert.doesNotMatch(html, /window\.location|window\.close/);
  assert.match(html, /Return to your running StashBase window/);
});

test('OAuth callback renders a safe centered card with delayed app return and fallback button', () => {
  const html = oauthResultPage({
    appReturnSupported: true,
    title: 'Signed in <now>',
    message: 'Ready & returning',
    autoReturn: true,
    returnStatusUrl: '/api/account/oauth/status?flow=safe-flow',
    returnIntentUrl: '/api/account/oauth/return-intent?flow=safe-flow',
  });

  assert.match(html, /class="shell"/);
  assert.match(html, /class="card" data-auto-return="true"/);
  assert.match(html, /href="stashbase:\/\/oauth-complete" hidden/);
  assert.match(html, /window\.location\.href = 'stashbase:\/\/oauth-complete'/);
  assert.match(html, /window\.close\(\)/);
  assert.match(html, /fetch\(returnStatusUrl/);
  assert.match(html, /fetch\(returnIntentUrl, \{ method: 'POST'/);
  assert.match(html, /result\.appReturned === true/);
  assert.doesNotMatch(html, /addEventListener\('blur'/);
  // A missed automatic return says so once and offers the button; only a
  // pressed button is told to try once more.
  assert.match(html, /StashBase didn’t open on its own\./);
  assert.match(html, /Still not open\. Try once more\./);
  assert.doesNotMatch(html, /Try the button again/);
  assert.match(html, /Signed in &lt;now&gt;/);
  assert.match(html, /Ready &amp; returning/);
  assert.doesNotMatch(html, /Signed in <now>/);
});

test('failed OAuth callback keeps the return button visible without automatic launch', () => {
  const html = oauthResultPage({
    appReturnSupported: true,
    title: 'Sign-in failed',
    message: 'Try again.',
    kind: 'error',
  });

  assert.match(html, /data-auto-return="false"/);
  assert.match(html, /href="stashbase:\/\/oauth-complete">/);
  assert.doesNotMatch(html, /href="stashbase:\/\/oauth-complete" hidden/);
});

test('a failed callback can receive app-return proof through an opaque local status ticket', () => {
  const result = runIsolated(`
    const account = await import('./server/hosted-account.ts');
    const flowId = account.createFailedHostedOAuthFlow('Missing sign-in flow.');
    const before = account.hostedOAuthStatus(flowId);
    account.noteHostedOAuthReturnIntent(flowId);
    const acknowledged = account.noteHostedOAuthAppReturn();
    const after = account.hostedOAuthStatus(flowId);
    process.stdout.write(JSON.stringify({ flowId, before, acknowledged, after }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.flowId, /^[A-Za-z0-9_-]+$/);
  assert.equal(output.before.state, 'error');
  assert.equal(output.before.appReturned, undefined);
  assert.deepEqual(output.acknowledged, { acknowledged: true });
  assert.equal(output.after.appReturned, true);
});

test('a data-free native return focuses the window attached to the browser return intent', () => {
  const result = runIsolated(`
    const account = await import('./server/hosted-account.ts');
    const first = account.beginHostedOAuth('google', 'http://127.0.0.1:8090', 'window-one');
    const second = account.beginHostedOAuth('google', 'http://127.0.0.1:8090', 'window-two');
    account.failHostedOAuth(first.flowId, 'first stopped');
    account.failHostedOAuth(second.flowId, 'second stopped');
    account.noteHostedOAuthReturnIntent(first.flowId);
    const acknowledged = account.noteHostedOAuthAppReturn();
    process.stdout.write(JSON.stringify({ acknowledged, first: account.hostedOAuthStatus(first.flowId), second: account.hostedOAuthStatus(second.flowId) }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.acknowledged, { acknowledged: true, windowId: 'window-one' });
  assert.equal(output.first.appReturned, true);
  assert.equal(output.second.appReturned, undefined);
});

function apiToken(label: string, userId = 'user-1') {
  return `fixture.${Buffer.from(JSON.stringify({ sub: userId, session_id: 'session-id', exp: 4102444800 })).toString('base64url')}.${label}`;
}
const authFixture = `
  const apiToken = ${apiToken.toString()};
  const authReply = (url, { accessToken = 'access-1', sessionToken = 'refresh-1', user = { id: 'user-1', email: 'person@example.com' } } = {}) => {
    if (String(url).endsWith('/electron/token')) return Response.json({ token: sessionToken });
    if (String(url).endsWith('/get-session')) return Response.json({ session: { id: 'session-id', expiresAt: '2100-01-01T00:00:00.000Z' }, user: { emailVerified: true, ...user } });
    if (String(url).endsWith('/token')) return Response.json({ token: apiToken(accessToken, user.id) });
    throw Error('Unexpected auth fixture operation: ' + url);
  };
`;

function runIsolated(source: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-hosted-account-test-'));
  try {
    return spawnSync(process.execPath, [
      '--no-warnings',
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      authFixture + source,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 15_000,
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('the sign-in banner: sign-in answers it, sign-out brings it back, Not now holds until the next sign-out', () => {
  const result = runIsolated(`
    globalThis.fetch = async (url) => {
      if (['/electron/token', '/get-session', '/token'].some(path => String(url).endsWith(path))) return authReply(url, {
        accessToken: 'access-1', sessionToken: 'refresh-1',
        user: { id: 'user-1', email: 'person@example.com' },
      });
      if (String(url).includes('/api/auth/sign-out')) return new Response(null, { status: 204 });
      throw new Error('unexpected URL ' + url);
    };
    const account = await import('./server/hosted-account.ts');
    const config = await import('./server/app-config.ts');
    const first = await account.hostedAccountState();
    const started = account.beginHostedOAuth('google', 'http://127.0.0.1:8090');
    await account.exchangeHostedOAuthCode(started.flowId, 'auth-code-1');
    const signedIn = await account.hostedAccountState();
    await account.signOutHostedAccount();
    const signedOut = await account.hostedAccountState();
    config.markAccountOfferSeen('sign-in');
    const declined = await account.hostedAccountState();
    // Not signed in, a sign-out call is not a sign-out: the Not now stands.
    await account.signOutHostedAccount();
    const stillDeclined = await account.hostedAccountState();
    config.resetAccountOffers();
    const reset = await account.hostedAccountState();
    process.stdout.write(JSON.stringify({ first, signedIn, signedOut, declined, stillDeclined, reset }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.first, { signedIn: false, offers: ['sign-in'] });
  assert.deepEqual(output.signedIn.offers, []);
  assert.deepEqual(output.signedOut, { signedIn: false, offers: ['sign-in'] });
  assert.deepEqual(output.declined.offers, []);
  assert.deepEqual(output.stillDeclined.offers, []);
  assert.deepEqual(output.reset.offers, ['sign-in']);
});

test('billing calls carry the desktop session, refresh once on 401, and open only Stripe pages', () => {
  const result = runIsolated(`
    const calls = [];
    let checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_1';
    let statusAttempts = 0;
    globalThis.fetch = async (url, init = {}) => {
      const target = String(url);
      calls.push({ url: target, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, authorization: new Headers(init.headers).get('authorization') });
      if (target.includes('/api/auth/')) return authReply(url, { accessToken: statusAttempts ? 'access-2' : 'access-1' });
      if (target.endsWith('/v1/billing/status')) {
        statusAttempts += 1;
        if (statusAttempts === 1) return Response.json({ code: 'unauthorized', message: 'Expired.' }, { status: 401 });
        return Response.json({ plan: null, status: 'free', paidThrough: null, periodEnd: null, cancelAtPeriodEnd: false, canManage: false });
      }
      if (target.endsWith('/v1/billing/checkout')) return Response.json({ url: checkoutUrl });
      if (target.endsWith('/v1/billing/change')) return Response.json({ changed: true });
      if (target.endsWith('/v1/billing/portal')) return Response.json({ url: 'https://evil.example/portal' });
      throw new Error('unexpected URL ' + url);
    };
    const account = await import('./server/hosted-account.ts');
    const started = account.beginHostedOAuth('google', 'http://127.0.0.1:8090');
    await account.exchangeHostedOAuthCode(started.flowId, 'auth-code-1');
    const status = await account.fetchHostedBillingStatus();
    const checkout = await account.createHostedCheckout('price_plus');
    const portal = await account.createHostedBillingPortal().then(() => 'opened', (error) => error.message);
    checkoutUrl = 'http://checkout.stripe.com/c/pay/cs_test_2';
    const insecure = await account.createHostedCheckout('price_plus').then(() => 'opened', (error) => error.message);
    await account.changeHostedBilling({ action: 'downgrade', priceId: 'price_plus' });
    process.stdout.write(JSON.stringify({ calls: calls.filter((call) => call.url.includes('/v1/billing/')), status, checkout, portal, insecure }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.calls.slice(0, 3).map((call: { authorization: string }) => call.authorization), [`Bearer ${apiToken('access-1')}`, `Bearer ${apiToken('access-2')}`, `Bearer ${apiToken('access-2')}`]);
  assert.equal(output.status.status, 'free');
  assert.deepEqual(output.calls[2].body, { priceId: 'price_plus' });
  assert.equal(output.checkout.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(output.portal, 'Billing returned an unexpected page.');
  assert.equal(output.insecure, 'Billing returned an unexpected page.');
  assert.deepEqual(output.calls.at(-1).body, { action: 'downgrade', priceId: 'price_plus' });
  assert.equal(output.calls.at(-1).authorization, `Bearer ${apiToken('access-2')}`);
});

test('a stalled billing response times out and a later attempt can recover', () => {
  const result = runIsolated(`
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = () => timeout(20);
    globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    const keepAlive = setInterval(() => {}, 1000);
    const account = await import('./server/hosted-account.ts');
    const error = await account.fetchHostedBillingPlans().then(() => null, error => error.name);
    globalThis.fetch = async () => Response.json({ plans: [] });
    const plans = await account.fetchHostedBillingPlans();
    clearInterval(keepAlive);
    process.stdout.write(JSON.stringify({ error, plans }));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { error: 'TimeoutError', plans: [] });
});

test('desktop credit refresh uses the same native transport as sign-in without a direct network fallback', () => {
  const result = runIsolated(`
    const { createAuthNetworkBridge } = await import('./electron/account/auth-network.ts');
    const calls = [];
    let creditReads = 0;
    const bridge = await createAuthNetworkBridge({ fetch: async (url, init) => {
      calls.push({ url: String(url), authorization: new Headers(init.headers).get('authorization'), version: new Headers(init.headers).get('x-stashbase-client-version') });
      if (String(url).endsWith('/v1/agent/usage?include=reservations')) {
        if (++creditReads === 1) return Response.json({ code: 'auth_required' }, { status: 401 });
        return Response.json({ remainingPercent: 75, reservedPercent: 10 });
      }
      return authReply(url);
    } });
    process.env.STASHBASE_AUTH_NETWORK_PORT = String(bridge.port);
    process.env.STASHBASE_AUTH_NETWORK_TOKEN = bridge.token;
    globalThis.fetch = async () => { throw new Error('Direct network access is unavailable; use the system proxy'); };
    try {
      const account = await import('./server/hosted-account.ts');
      const started = account.beginHostedOAuth('google', 'http://127.0.0.1:8090');
      await account.exchangeHostedOAuthCode(started.flowId, 'fixture-code');
      const allowance = await account.fetchHostedAgentAllowance();
      process.stdout.write(JSON.stringify({ allowance, calls }));
    } finally { bridge.close(); }
  `);
  assert.equal(result.status, 0, result.stderr);
  const { allowance, calls } = JSON.parse(result.stdout);
  assert.equal(allowance.remainingPercent, 75);
  assert.equal(allowance.reservedPercent, 10);
  const usage = calls.filter((call: { url: string }) => call.url.endsWith('/v1/agent/usage?include=reservations'));
  assert.equal(usage.length, 2, 'one native 401 refresh retries the credit read once');
  assert.ok(usage.every((call: { authorization: string; version: string }) => call.authorization === `Bearer ${apiToken('access-1')}` && call.version));
});

test('OAuth PKCE session persists locally and authenticates Agent allowance requests', () => {
  const result = runIsolated(`
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null, authorization: new Headers(init.headers).get('authorization') });
      if (['/electron/token', '/get-session', '/token'].some(path => String(url).endsWith(path))) return authReply(url, {
        accessToken: 'access-1', sessionToken: 'refresh-1',
        user: { id: 'user-1', email: 'person@example.com', name: 'Ada Lovelace', image: 'https://lh3.googleusercontent.com/a/profile-photo' },
      });
      if (String(url).endsWith('/v1/agent/usage?include=reservations')) return Response.json({
        profile: 'stashbase-agent-default', remainingPercent: 75, reservedPercent: 10,
        inputTokens: 100, outputTokens: 25, cacheReadTokens: 10,
        windowStartedAt: '2026-08-01T00:00:00.000Z', windowEndsAt: '2026-08-08T00:00:00.000Z',
      });
      throw new Error('unexpected URL ' + url);
    };
    const account = await import('./server/hosted-account.ts');
    const config = await import('./server/app-config.ts');
    const started = account.beginHostedOAuth('google', 'http://127.0.0.1:8090');
    await account.exchangeHostedOAuthCode(started.flowId, 'auth-code-1');
    account.finishHostedOAuth(started.flowId);
    account.noteHostedOAuthAppReturn();
    const agentAllowance = await account.fetchHostedAgentAllowance();
    const state = await account.hostedAccountState();
    process.stdout.write(JSON.stringify({ started, status: account.hostedOAuthStatus(started.flowId), calls, agentAllowance, state, session: config.getHostedAccountSession(), source: config.getEmbedderProvider() }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const authorize = new URL(output.started.url);
  assert.equal(authorize.pathname, '/api/auth/desktop/start');
  assert.match(output.started.flowId, /^[0-9a-f]{64}$/);
  const redirectTo = authorize.searchParams.get('callback');
  assert.ok(redirectTo);
  assert.equal(new URL(redirectTo).pathname, '/api/account/oauth/callback');
  assert.equal(new URL(redirectTo).search, '');
  assert.equal(authorize.searchParams.get('state'), output.started.flowId);
  assert.equal(output.calls[0].body.token, 'auth-code-1');
  const expectedChallenge = crypto.createHash('sha256').update(output.calls[0].body.code_verifier).digest('base64url');
  assert.equal(authorize.searchParams.get('challenge'), expectedChallenge);
  assert.equal(output.status.state, 'complete');
  assert.equal(output.status.appReturned, true);
  assert.equal(output.calls[1].authorization, 'Bearer refresh-1');
  assert.equal(output.calls[3].authorization, `Bearer ${apiToken('access-1')}`);
  assert.equal(output.agentAllowance.remainingPercent, 75);
  assert.equal(output.agentAllowance.reservedPercent, 10);
  assert.equal(output.session.sessionToken, 'refresh-1');
  assert.equal(output.source, 'openai');
  assert.equal(output.state.email, 'person@example.com');
  assert.equal(output.state.displayName, 'Ada Lovelace');
  assert.equal(output.state.avatarUrl, '/api/account/avatar');
  assert.equal('userId' in output.state, false);
  assert.equal('accessToken' in output.state, false);
  assert.equal('sessionToken' in output.state, false);
  assert.equal('user_metadata' in output.state, false);
});

test('OAuth callback explains transport failures without exposing login credentials', () => {
  const result = runIsolated(`
    const express = (await import('express')).default;
    const account = await import('./server/hosted-account.ts');
    const { mount } = await import('./server/routes/account.ts');
    const localFetch = globalThis.fetch;
    const app = express();
    mount(app, { appReturnToken: 'test' });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const replies = [];
    try {
      for (const code of ['ENOTFOUND', 'ECONNRESET', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_PROXY_CONNECTION_FAILED', 'ETIMEDOUT']) {
        const flow = account.beginHostedOAuth('google', 'http://127.0.0.1:8090');
        globalThis.fetch = async () => {
          throw new TypeError('fetch failed', { cause: Object.assign(new Error('private-auth-code private-verifier'), { code }) });
        };
        const response = await localFetch('http://127.0.0.1:' + server.address().port + '/api/account/oauth/callback?code=private-auth-code&state=' + flow.flowId);
        replies.push({ code, status: response.status, html: await response.text(), flow: account.hostedOAuthStatus(flow.flowId) });
      }
      process.stdout.write(JSON.stringify(replies));
    } finally { server.closeAllConnections(); server.close(); }
  `);
  assert.equal(result.status, 0, result.stderr);
  for (const reply of JSON.parse(result.stdout)) {
    assert.equal(reply.status, 400);
    assert.match(reply.html, /Sign-in failed/);
    assert.match(reply.html, /exchange/i);
    assert.ok(reply.html.includes(reply.code), reply.html);
    assert.ok(reply.flow.error.includes(reply.code));
    assert.doesNotMatch(reply.html, /private-auth-code|private-verifier|fetch failed/);
  }
});

test('allowance HTTP failures preserve upstream metadata and network causes only in diagnostics', () => {
  const result = runIsolated(`
    const express = (await import('express')).default;
    const { httpErrorReporting } = await import('./server/error-reporting.ts');
    const { errorDiagnostic } = await import('./server/error-diagnostics.ts');
    const { mount } = await import('./server/routes/account.ts');
    const config = await import('./server/app-config.ts');
    config.setHostedAccountSession({ userId: 'account-test', email: 'account@example.test', accessToken: 'private-access', sessionToken: 'private-refresh', expiresAt: 4102444800000 });
    const localFetch = globalThis.fetch;
    let networkFailure = false;
    globalThis.fetch = async () => {
      if (networkFailure) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed token=private-token'), { code: 'ECONNRESET' }) });
      return new Response('<html>private-response-body</html>', { status: 404, headers: { 'x-request-id': 'upstream-request-42', 'content-type': 'text/html' } });
    };
    const captured = [];
    const app = express();
    app.use(httpErrorReporting({ captureError: (error, context) => captured.push({ diagnostic: errorDiagnostic(error), ...context }) }));
    mount(app, { appReturnToken: 'test' });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const replies = [];
    try {
      for (const network of [false, true]) {
        networkFailure = network;
        const response = await localFetch('http://127.0.0.1:' + server.address().port + '/api/account/agent-usage');
        replies.push({ status: response.status, body: await response.json() });
      }
      process.stdout.write(JSON.stringify({ replies, captured }));
    } finally { server.closeAllConnections(); server.close(); }
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.replies, [
    { status: 502, body: { error: 'The agent credits service failed (HTTP 404).' } },
    { status: 502, body: { error: 'fetch failed' } },
  ]);
  assert.equal(output.captured.length, 2);
  const upstream = output.captured[0].diagnostic;
  assert.equal(upstream.http_status, 502);
  assert.equal(upstream.causes[0].http_status, 404);
  assert.equal(upstream.causes[0].request_id, 'upstream-request-42');
  assert.equal(upstream.causes[0].content_type, 'text/html');
  assert.ok(output.captured[1].diagnostic.causes.some((cause: { code?: string }) => cause.code === 'ECONNRESET'));
  assert.doesNotMatch(JSON.stringify(output), /private-access|private-refresh|private-token|private-response-body/);
});

test('credits and billing keep authentication loss distinct from service failure during a request', () => {
  const result = runIsolated(`
    const express = (await import('express')).default;
    const { mount } = await import('./server/routes/account.ts');
    const config = await import('./server/app-config.ts');
    const localFetch = globalThis.fetch;
    let scenario;
    globalThis.fetch = async (url) => {
      if (scenario === 'expired') return Response.json(null);
      if (scenario === 'signout-refresh' || scenario === 'signout-token') {
        if (scenario === 'signout-refresh' || String(url).endsWith('/token')) config.setHostedAccountSession(undefined);
        return authReply(url, { user: { id: 'fixture', email: 'fixture@example.test' } });
      }
      if (scenario === 'signout') {
        config.setHostedAccountSession(undefined);
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      throw new TypeError('fetch failed');
    };
    const app = express();
    mount(app, { appReturnToken: 'test' });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const replies = [];
    try {
      for (const route of ['agent-usage', 'billing/status']) {
        for (scenario of ['signed-out', 'expired', 'signout', 'signout-refresh', 'signout-token', 'network']) {
          config.setHostedAccountSession(scenario === 'signed-out' ? undefined : {
            userId: 'fixture', email: 'fixture@example.test', accessToken: 'fixture-access',
            sessionToken: 'fixture-refresh', expiresAt: ['expired', 'signout-refresh', 'signout-token'].includes(scenario) ? 0 : 4102444800,
          });
          const response = await localFetch('http://127.0.0.1:' + server.address().port + '/api/account/' + route);
          replies.push({ route, scenario, status: response.status, body: await response.json(), session: !!config.getHostedAccountSession() });
        }
      }
      process.stdout.write(JSON.stringify(replies));
    } finally { server.closeAllConnections(); server.close(); }
  `);
  assert.equal(result.status, 0, result.stderr);
  for (const reply of JSON.parse(result.stdout)) {
    assert.equal(reply.status, reply.scenario === 'network' ? 502 : 401, JSON.stringify(reply));
    assert.equal(reply.session, reply.scenario === 'network');
  }
});

test('malformed authentication responses retain native HTTP evidence without body excerpts or revocation', () => {
  const result = runIsolated(`
    const { createAuthNetworkBridge } = await import('./electron/account/auth-network.ts');
    const bridge = await createAuthNetworkBridge({ fetch: async () => new Response('private-response-secret', {
      status: 503, headers: { 'content-type': 'text/plain', 'x-request-id': 'auth-fixture-request' },
    }) });
    process.env.STASHBASE_AUTH_NETWORK_PORT = String(bridge.port);
    process.env.STASHBASE_AUTH_NETWORK_TOKEN = bridge.token;
    const account = await import('./server/hosted-account.ts');
    const config = await import('./server/app-config.ts');
    const { errorDiagnostic } = await import('./server/error-diagnostics.ts');
    config.setHostedAccountSession({ userId: 'fixture', email: 'fixture@example.test', accessToken: 'fixture-access', sessionToken: 'fixture-refresh', expiresAt: 0 });
    try { await account.hostedAccessToken(); throw new Error('Expected rejection'); }
    catch (error) { process.stdout.write(JSON.stringify({ diagnostic: errorDiagnostic(error), session: !!config.getHostedAccountSession(), authRequired: account.isHostedSignInRequired(error) })); }
    finally { bridge.close(); }
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.diagnostic.http_status, 503);
  assert.equal(output.diagnostic.content_type, 'text/plain');
  assert.equal(output.diagnostic.request_id, 'auth-fixture-request');
  assert.equal(output.diagnostic.causes[0].name, 'SyntaxError');
  assert.equal(output.session, true);
  assert.equal(output.authRequired, false);
  assert.doesNotMatch(result.stdout, /private-response-secret|fixture-access|fixture-refresh/);
});

test('Google profile normalization accepts safe fields and rejects unsafe avatars', () => {
  const result = runIsolated(`
    const account = await import('./server/hosted-account.ts');
    process.stdout.write(JSON.stringify({
      safe: account.normalizedGoogleProfile({ name: '  Grace   Hopper  ', image: 'https://lh3.googleusercontent.com/a/photo' }),
      unsafe: account.normalizedGoogleProfile({ name: 'Person', image: 'http://lh3.googleusercontent.com/a/photo', raw_provider_token: 'secret' }),
    }));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    safe: { displayName: 'Grace Hopper', avatarUrl: 'https://lh3.googleusercontent.com/a/photo' },
    unsafe: { displayName: 'Person' },
  });
});

test('persisted account sessions normalize and allowlist optional profile fields', () => {
  const result = runIsolated(`
    const config = await import('./server/app-config.ts');
    config.setHostedAccountSession({
      accessToken: 'access', sessionToken: 'refresh', expiresAt: 4102444800,
      userId: 'user', email: 'person@example.com', displayName: '  Ada  \\u0000 Lovelace  ',
      avatarUrl: 'http://lh3.googleusercontent.com/a/unsafe', rawProviderToken: 'secret',
    });
    process.stdout.write(JSON.stringify(config.getHostedAccountSession()));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    accessToken: 'access',
    sessionToken: 'refresh',
    expiresAt: 4_102_444_800,
    userId: 'user',
    email: 'person@example.com',
    displayName: 'Ada Lovelace',
  });
});

test('a session without cached profile stays signed in when optional profile hydration fails', () => {
  const result = runIsolated(`
    globalThis.fetch = async () => { throw new Error('profile offline'); };
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({ accessToken: 'access', sessionToken: 'refresh', expiresAt: 4102444800, userId: 'user', email: 'legacy@example.com' });
    const state = await account.hostedAccountState(false);
    process.stdout.write(JSON.stringify({ state, session: config.getHostedAccountSession() }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.state.signedIn, true);
  assert.equal(output.state.email, 'legacy@example.com');
  assert.equal(output.session.displayName, undefined);
});

test('a hanging optional profile lookup does not delay usable account state', () => {
  const result = runIsolated(`
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/api/auth/get-session')) return new Promise(() => {});
      throw new Error('unexpected URL ' + url);
    };
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({ accessToken: 'access', sessionToken: 'refresh', expiresAt: 4102444800, userId: 'user', email: 'legacy@example.com' });
    const outcome = await Promise.race([
      account.hostedAccountState(false).then((state) => ({ kind: 'state', state })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 100)),
    ]);
    process.stdout.write(JSON.stringify(outcome));
    process.exit(0);
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.kind, 'state');
  assert.equal(output.state.signedIn, true);
  assert.equal(output.state.email, 'legacy@example.com');
});

test('a session without cached profile hydrates optional profile data without signing in again', () => {
  const result = runIsolated(`
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/api/auth/get-session')) return authReply(url, { user: { id: 'user', email: 'legacy@example.com', name: 'Legacy Person', image: 'https://lh3.googleusercontent.com/a/legacy' } });
      return Response.json({ error: 'quota offline' }, { status: 503 });
    };
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({ accessToken: 'access', sessionToken: 'refresh', expiresAt: 4102444800, userId: 'user', email: 'legacy@example.com' });
    await account.hostedAccountState(false);
    await new Promise((resolve) => setImmediate(resolve));
    const state = await account.hostedAccountState(false);
    process.stdout.write(JSON.stringify({ state, session: config.getHostedAccountSession() }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.state.displayName, 'Legacy Person');
  assert.equal(output.state.avatarUrl, '/api/account/avatar');
  assert.equal(output.session.avatarUrl, 'https://lh3.googleusercontent.com/a/legacy');
});

test('avatar fetch is same-host, typed, bounded, and cached', () => {
  const result = runIsolated(`
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      if (!String(url).startsWith('https://lh3.googleusercontent.com/')) throw new Error('unexpected host');
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png', 'content-length': '3' } });
    };
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({
      accessToken: 'access', sessionToken: 'refresh', expiresAt: 4102444800,
      userId: 'user', email: 'person@example.com', avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
    });
    const first = await account.hostedAccountAvatar();
    const second = await account.hostedAccountAvatar();
    process.stdout.write(JSON.stringify({ calls, contentType: first.contentType, bytes: [...first.bytes], same: first.bytes === second.bytes }));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { calls: 1, contentType: 'image/png', bytes: [1, 2, 3], same: true });
});

test('avatar fetch rejects oversized or incorrectly typed provider responses', () => {
  const result = runIsolated(`
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({
      accessToken: 'access', sessionToken: 'refresh', expiresAt: 4102444800,
      userId: 'user', email: 'person@example.com', avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
    });
    globalThis.fetch = async () => new Response('not an image', { headers: { 'content-type': 'text/html' } });
    const wrongType = await account.hostedAccountAvatar().then(() => null, (error) => error.message);
    globalThis.fetch = async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png', 'content-length': String(2 * 1024 * 1024 + 1) } });
    const oversized = await account.hostedAccountAvatar().then(() => null, (error) => error.message);
    process.stdout.write(JSON.stringify({ wrongType, oversized }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.wrongType, /unsupported content type/u);
  assert.match(output.oversized, /too large/u);
});

test('sign out clears display profile data with the local session', () => {
  const result = runIsolated(`
    globalThis.fetch = async () => Response.json({});
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({
      accessToken: 'access', sessionToken: 'refresh', expiresAt: 4102444800,
      userId: 'user', email: 'person@example.com', displayName: 'Person',
      avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
    });
    await account.signOutHostedAccount();
    process.stdout.write(JSON.stringify({ session: config.getHostedAccountSession() ?? null, state: await account.hostedAccountState() }));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { session: null, state: { signedIn: false, offers: ['sign-in'] } });
});

test('concurrent hosted token refreshes share one request', () => {
  const result = runIsolated(`
    let refreshCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/api/auth/token')) refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return authReply(url, { accessToken: 'access-new', user: { id: 'user', email: 'person@example.com', name: 'Existing Person', image: 'https://lh3.googleusercontent.com/a/existing' } });
    };
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({
      accessToken: 'access-old', sessionToken: 'refresh-old', expiresAt: 1,
      userId: 'user', email: 'person@example.com', displayName: 'Existing Person',
      avatarUrl: 'https://lh3.googleusercontent.com/a/existing',
    });
    const tokens = await Promise.all([account.hostedAccessToken(), account.hostedAccessToken(), account.hostedAccessToken({ forceRefresh: true })]);
    process.stdout.write(JSON.stringify({ refreshCalls, tokens, session: config.getHostedAccountSession() }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.refreshCalls, 1);
  assert.deepEqual(output.tokens, Array(3).fill(apiToken('access-new', 'user')));
  assert.equal(output.session.sessionToken, 'refresh-old');
  assert.equal(output.session.displayName, 'Existing Person');
  assert.equal(output.session.avatarUrl, 'https://lh3.googleusercontent.com/a/existing');
});

test('a stale failed refresh cannot clear a newer hosted session', () => {
  const result = runIsolated(`
    let finishRefresh;
    globalThis.fetch = async () => new Promise((resolve) => { finishRefresh = resolve; });
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({ accessToken: 'access-old', sessionToken: 'refresh-old', expiresAt: 1, userId: 'user-old', email: 'old@example.com' });
    const pending = account.hostedAccessToken().catch((error) => error.message);
    await new Promise((resolve) => setImmediate(resolve));
    config.setHostedAccountSession({ accessToken: 'access-new', sessionToken: 'refresh-new', expiresAt: 4102444800, userId: 'user-new', email: 'new@example.com' });
    finishRefresh(Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }));
    await pending;
    process.stdout.write(JSON.stringify(config.getHostedAccountSession()));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sessionToken, 'refresh-new');
});

test('transient refresh failures preserve credentials, while a revoked session clears them', () => {
  const result = runIsolated(`
    const assert = (await import('node:assert/strict')).default;
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    const session = { accessToken: 'access', sessionToken: 'refresh', expiresAt: 1, userId: 'user', email: 'person@example.com' };
    for (const failure of [
      async () => { throw new Error('Network unavailable'); },
      async () => Response.json({ error_code: 'unexpected_failure' }, { status: 503 }),
      async () => Response.json({ error_code: 'over_request_rate_limit' }, { status: 429 }),
      async () => Response.json({ error_code: 'validation_failed' }, { status: 400 }),
      async () => Response.json({}),
    ]) {
      config.setHostedAccountSession(session);
      globalThis.fetch = failure;
      await assert.rejects(account.hostedAccessToken());
      assert.deepEqual(config.getHostedAccountSession(), session);
    }
    globalThis.fetch = async () => Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    await assert.rejects(account.hostedAccessToken());
    assert.equal(config.getHostedAccountSession(), undefined);
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('sign-out invalidates both delayed and not-yet-exchanged OAuth callbacks', () => {
  const result = runIsolated(`
    const assert = (await import('node:assert/strict')).default;
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    const flow = account.beginHostedOAuth('google', 'http://127.0.0.1:8090', 'window');
    let finish;
    globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
    const pending = account.exchangeHostedOAuthCode(flow.flowId, 'code');
    await account.signOutHostedAccount();
    finish(Response.json({ token: 'late-session' }));
    await assert.rejects(pending);
    assert.equal(config.getHostedAccountSession(), undefined);
    const unopened = account.beginHostedOAuth('google', 'http://127.0.0.1:8090', 'window');
    await account.signOutHostedAccount();
    globalThis.fetch = async () => { throw new Error('must not exchange'); };
    await assert.rejects(account.exchangeHostedOAuthCode(unopened.flowId, 'code'));
    assert.equal(config.getHostedAccountSession(), undefined);
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('a newer OAuth attempt wins over an older exchange that is already in flight', () => {
  const result = runIsolated(`
    const assert = (await import('node:assert/strict')).default;
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    const payload = (url, name) => authReply(url, { sessionToken: name, user: { id: name, email: name+'@example.com' } });
    let finish;
    globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
    const older = account.beginHostedOAuth('google', 'http://127.0.0.1:8090', 'first');
    const pending = account.exchangeHostedOAuthCode(older.flowId, 'old-code');
    const newer = account.beginHostedOAuth('google', 'http://127.0.0.1:8090', 'second');
    finish(payload('/electron/token', 'old'));
    await assert.rejects(pending);
    globalThis.fetch = async (url) => payload(url, 'new');
    await account.exchangeHostedOAuthCode(newer.flowId, 'new-code');
    assert.equal(config.getHostedAccountSession().userId, 'new');
  `);
  assert.equal(result.status, 0, result.stderr);
});


test('a stale successful refresh neither overwrites nor returns a newer account token', () => {
  const result = runIsolated(`
    const assert = (await import('node:assert/strict')).default;
    let finish;
    globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({accessToken:'old',sessionToken:'old',expiresAt:1,userId:'old',email:'old@example.com'});
    const pending = account.hostedAccessToken();
    const next = {accessToken:'new',sessionToken:'new',expiresAt:4102444800,userId:'new',email:'new@example.com'};
    config.setHostedAccountSession(next);
    finish(authReply('/get-session', { user: { id: 'old', email: 'old@example.com' } }));
    await assert.rejects(pending, /changed while.*refreshing/);
    assert.deepEqual(config.getHostedAccountSession(), next);
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('Supabase credentials require a fresh sign-in and are never sent to Better Auth', () => {
  const result = runIsolated(`
    const assert = (await import('node:assert/strict')).default;
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    let sent = 0;
    globalThis.fetch = async () => { sent++; throw Error('must not send old credentials'); };
    config.setHostedAccountSession({accessToken:'legacy-access',refreshToken:'legacy-refresh',expiresAt:4102444800,userId:'old',email:'old@example.test'});
    assert.equal(config.getHostedAccountSession(), undefined);
    await assert.rejects(account.hostedAccessToken(), /Sign in/);
    assert.equal(sent, 0);
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('sign-out during the post-exchange session read cannot restore the account', () => {
  const result = runIsolated(`
    const assert = (await import('node:assert/strict')).default;
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    let finish;
    globalThis.fetch = async url => String(url).endsWith('/get-session')
      ? new Promise(resolve => { finish = resolve; }) : authReply(url);
    const flow = account.beginHostedOAuth('google', 'http://127.0.0.1:8090');
    const pending = account.exchangeHostedOAuthCode(flow.flowId, 'code');
    await new Promise(resolve => setImmediate(resolve));
    await account.signOutHostedAccount();
    finish(authReply('/get-session'));
    await assert.rejects(pending, /signed out/);
    assert.equal(config.getHostedAccountSession(), undefined);
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('email login keeps credentials in the host and a cancelled verification cannot restore a session', () => {
  const result = runIsolated(`
    const assert = (await import('node:assert/strict')).default;
    const account = await import('./server/hosted-account.ts');
    const config = await import('./server/app-config.ts');
    let release, defer = false;
    const revoked = [];
    globalThis.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/email/send')) return Response.json({success:true});
      if (path.endsWith('/desktop/email/verify')) {
        if (defer) await new Promise(resolve => { release = resolve; });
        return Response.json({token:'email-session'});
      }
      if (path.endsWith('/sign-out')) { revoked.push(init.headers.Authorization ?? init.headers.authorization); return Response.json({success:true}); }
      return authReply(url,{sessionToken:'email-session'});
    };
    const first = await account.sendHostedEmail('person@example.com');
    const signedIn = await account.verifyHostedEmail(first.flowId,'123456');
    assert.equal(signedIn.signedIn,true);
    assert.equal(config.getHostedAccountSession().sessionToken,'email-session');
    assert.equal(JSON.stringify(signedIn).includes('email-session'),false);
    await account.signOutHostedAccount();
    const second = await account.sendHostedEmail('person@example.com');
    defer = true;
    const pending = account.verifyHostedEmail(second.flowId,'123456');
    await new Promise(resolve => setTimeout(resolve,10));
    account.cancelHostedEmail(second.flowId);
    release();
    await assert.rejects(pending,/cancelled/);
    assert.equal(config.getHostedAccountSession(),undefined);
    assert.equal(revoked.length,2);
    process.stdout.write('verified');
  `);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,'verified');
});

test('allowance body stalls end at the owned deadline and preserve the signed-in session', () => {
  const result = runIsolated(`
    const http = await import('node:http');
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    const session = { userId: 'account-test', email: 'account@example.test', accessToken: 'private-access', sessionToken: 'private-refresh', expiresAt: 4102444800000 };
    config.setHostedAccountSession(session);
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) => nativeFetch('http://127.0.0.1:' + upstream.address().port, init);
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ms => timeout(Math.min(ms, 100));
    let watchdog;
    try {
      const outcome = await Promise.race([
        account.fetchHostedAgentAllowance().then(value => ({ kind: 'success', value }), error => ({ kind: 'error', name: error.name })),
        new Promise(resolve => { watchdog = setTimeout(() => resolve({ kind: 'still_pending' }), 700); }),
      ]);
      assert.equal(outcome.kind, 'error', 'the credits request must not remain pending or return a successful null body');
      assert.match(outcome.name, /TimeoutError|AbortError/);
      assert.deepEqual(config.getHostedAccountSession(), session);
    } finally { clearTimeout(watchdog); upstream.closeAllConnections(); upstream.close(); }
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('allowance auth refresh cannot restart the request deadline or send after it expires', () => {
  const result = runIsolated(`
    const http = await import('node:http');
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({ userId: 'user-1', email: 'person@example.com', accessToken: apiToken('old'), sessionToken: 'refresh', expiresAt: 4102444800 });
    let usageCalls = 0;
    let profileFinished = false;
    const upstream = http.createServer((_request, response) => {
      usageCalls++;
      if (usageCalls === 1) setTimeout(() => { response.writeHead(401); response.end('{}'); }, 70);
      else response.end('{}');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/get-session')) { await new Promise(resolve => setTimeout(resolve, 200)); profileFinished = true; }
      if (String(url).includes('/api/auth/')) return authReply(url);
      return nativeFetch('http://127.0.0.1:' + upstream.address().port, init);
    };
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ms => timeout(ms === 20000 ? 120 : ms);
    try {
      await assert.rejects(account.fetchHostedAgentAllowance(), error => /TimeoutError|AbortError/.test(error.name));
      assert.equal(profileFinished, false, 'this reader must stop without awaiting the shared refresh');
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(usageCalls, 1, 'expired requests must not dispatch another allowance read');
      assert.equal(config.getHostedAccountSession().userId, 'user-1');
    } finally { upstream.closeAllConnections(); upstream.close(); }
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('signed-in mailbox proof retains the session and the signed-out login guard', () => {
  const result = runIsolated(`
    const assert = (await import('node:assert/strict')).default;
    const account = await import('./server/hosted-account.ts');
    const config = await import('./server/app-config.ts');
    const session = {accessToken:'access',sessionToken:'current',expiresAt:4102444800,userId:'owner',email:'owner@example.test'};
    config.setHostedAccountSession(session);
    const paths = [];
    globalThis.fetch = async (url, init) => {
      paths.push(new URL(url).pathname);
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer current');
      return Response.json({ success: true });
    };
    await assert.rejects(account.sendHostedEmail('other@example.test'), /Sign out before/);
    await account.accountOperation('/account/email/send', { action: 'send' });
    await account.accountOperation('/account/email/verify', { action: 'verify', otp: '123456' });
    assert.deepEqual(paths, ['/api/auth/account/email/send', '/api/auth/account/email/verify']);
    assert.deepEqual(config.getHostedAccountSession(), session);
  `);
  assert.equal(result.status, 0, result.stderr);
});
