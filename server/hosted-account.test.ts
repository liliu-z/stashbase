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

test('OAuth callback renders a safe centered card with delayed app return and fallback button', () => {
  const html = oauthResultPage({
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
  assert.match(html, /Didn’t return automatically\?/);
  assert.match(html, /Signed in &lt;now&gt;/);
  assert.match(html, /Ready &amp; returning/);
  assert.doesNotMatch(html, /Signed in <now>/);
});

test('failed OAuth callback keeps the return button visible without automatic launch', () => {
  const html = oauthResultPage({
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

test('OAuth flows retain their account purpose', () => {
  const result = runIsolated(`
    const account = await import('./server/hosted-account.ts');
    const identity = account.beginHostedOAuth('google', 'http://127.0.0.1:8090');
    process.stdout.write(JSON.stringify({
      identity: { start: identity, purpose: account.hostedOAuthPurpose(identity.flowId) },
    }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.identity.start.purpose, 'account');
  assert.equal(output.identity.purpose, 'account');
});

function runIsolated(source: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-hosted-account-test-'));
  try {
    return spawnSync(process.execPath, [
      '--no-warnings',
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      source,
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

test('the sign-in banner persists per installation: sign-in answers it, sign-out keeps it answered, reset restores it', () => {
  const result = runIsolated(`
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/auth/v1/token?grant_type=pkce')) return Response.json({
        access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 4102444800,
        user: { id: 'user-1', email: 'person@example.com' },
      });
      if (String(url).includes('/auth/v1/logout')) return new Response(null, { status: 204 });
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
    config.resetAccountOffers();
    const reset = await account.hostedAccountState();
    process.stdout.write(JSON.stringify({ first, signedIn, signedOut, reset }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.first, { signedIn: false, offers: ['sign-in'] });
  assert.deepEqual(output.signedIn.offers, []);
  assert.deepEqual(output.signedOut, { signedIn: false, offers: [] });
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
      if (target.endsWith('/auth/v1/token?grant_type=pkce')) return Response.json({
        access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 4102444800,
        user: { id: 'user-1', email: 'person@example.com' },
      });
      if (target.endsWith('/auth/v1/token?grant_type=refresh_token')) return Response.json({
        access_token: 'access-2', refresh_token: 'refresh-2', expires_at: 4102444800,
        user: { id: 'user-1', email: 'person@example.com' },
      });
      if (target.endsWith('/v1/billing/status')) {
        statusAttempts += 1;
        if (statusAttempts === 1) return Response.json({ code: 'unauthorized', message: 'Expired.' }, { status: 401 });
        return Response.json({ plan: null, status: 'free', paidThrough: null, periodEnd: null, cancelAtPeriodEnd: false, canManage: false });
      }
      if (target.endsWith('/v1/billing/checkout')) return Response.json({ url: checkoutUrl });
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
    process.stdout.write(JSON.stringify({ calls: calls.filter((call) => call.url.includes('/v1/billing/')), status, checkout, portal, insecure }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.calls.slice(0, 3).map((call: { authorization: string }) => call.authorization), ['Bearer access-1', 'Bearer access-2', 'Bearer access-2']);
  assert.equal(output.status.status, 'free');
  assert.deepEqual(output.calls[2].body, { priceId: 'price_plus' });
  assert.equal(output.checkout.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(output.portal, 'Billing returned an unexpected page.');
  assert.equal(output.insecure, 'Billing returned an unexpected page.');
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

test('OAuth PKCE session persists locally and authenticates Agent allowance requests', () => {
  const result = runIsolated(`
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null, authorization: new Headers(init.headers).get('authorization') });
      if (String(url).endsWith('/auth/v1/token?grant_type=pkce')) return Response.json({
        access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 4102444800,
        user: { id: 'user-1', email: 'person@example.com', user_metadata: {
          full_name: 'Ada Lovelace', avatar_url: 'https://lh3.googleusercontent.com/a/profile-photo',
        } },
      });
      if (String(url).endsWith('/v1/agent/usage')) return Response.json({
        profile: 'stashbase-agent-default', remainingPercent: 75,
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
  assert.equal(authorize.pathname, '/auth/v1/authorize');
  assert.equal(authorize.searchParams.get('provider'), 'google');
  const redirectTo = authorize.searchParams.get('redirect_to');
  assert.ok(redirectTo);
  assert.equal(new URL(redirectTo).searchParams.get('flow'), output.started.flowId);
  assert.equal(output.calls[0].body.auth_code, 'auth-code-1');
  const expectedChallenge = crypto.createHash('sha256').update(output.calls[0].body.code_verifier).digest('base64url');
  assert.equal(authorize.searchParams.get('code_challenge'), expectedChallenge);
  assert.equal(output.status.state, 'complete');
  assert.equal(output.status.appReturned, true);
  assert.equal(output.calls[1].authorization, 'Bearer access-1');
  assert.equal(output.calls[1].authorization, 'Bearer access-1');
  assert.equal(output.agentAllowance.remainingPercent, 75);
  assert.equal(output.session.refreshToken, 'refresh-1');
  assert.equal(output.source, 'openai');
  assert.equal(output.state.email, 'person@example.com');
  assert.equal(output.state.displayName, 'Ada Lovelace');
  assert.equal(output.state.avatarUrl, '/api/account/avatar');
  assert.equal('userId' in output.state, false);
  assert.equal('accessToken' in output.state, false);
  assert.equal('refreshToken' in output.state, false);
  assert.equal('user_metadata' in output.state, false);
});

test('Google profile normalization accepts display-safe metadata and rejects unsafe avatars', () => {
  const result = runIsolated(`
    const account = await import('./server/hosted-account.ts');
    process.stdout.write(JSON.stringify({
      safe: account.normalizedGoogleProfile({ user_metadata: {
        name: '  Grace   Hopper  ', picture: 'https://lh3.googleusercontent.com/a/photo',
      } }),
      identity: account.normalizedGoogleProfile({ identities: [{ provider: 'google', identity_data: {
        full_name: 'Katherine Johnson', avatar_url: 'https://lh3.googleusercontent.com/a/identity-photo',
      } }] }),
      invalidPrimary: account.normalizedGoogleProfile({
        user_metadata: { full_name: ' \\u0000 ', avatar_url: 'http://not-allowed.example/avatar' },
        identities: [{ provider: 'google', identity_data: {
          full_name: 'Dorothy Vaughan', picture: 'https://lh3.googleusercontent.com/a/valid-fallback',
        } }],
      }),
      unsafe: account.normalizedGoogleProfile({ user_metadata: {
        full_name: 'Person', avatar_url: 'http://lh3.googleusercontent.com/a/photo', raw_provider_token: 'secret',
      } }),
    }));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    safe: { displayName: 'Grace Hopper', avatarUrl: 'https://lh3.googleusercontent.com/a/photo' },
    identity: { displayName: 'Katherine Johnson', avatarUrl: 'https://lh3.googleusercontent.com/a/identity-photo' },
    invalidPrimary: { displayName: 'Dorothy Vaughan', avatarUrl: 'https://lh3.googleusercontent.com/a/valid-fallback' },
    unsafe: { displayName: 'Person' },
  });
});

test('persisted account sessions normalize and allowlist optional profile fields', () => {
  const result = runIsolated(`
    const config = await import('./server/app-config.ts');
    config.setHostedAccountSession({
      accessToken: 'access', refreshToken: 'refresh', expiresAt: 4102444800,
      userId: 'user', email: 'person@example.com', displayName: '  Ada  \\u0000 Lovelace  ',
      avatarUrl: 'http://lh3.googleusercontent.com/a/unsafe', rawProviderToken: 'secret',
    });
    process.stdout.write(JSON.stringify(config.getHostedAccountSession()));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 4_102_444_800,
    userId: 'user',
    email: 'person@example.com',
    displayName: 'Ada Lovelace',
  });
});

test('a legacy session stays signed in when optional profile hydration fails', () => {
  const result = runIsolated(`
    globalThis.fetch = async () => { throw new Error('profile offline'); };
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({ accessToken: 'access', refreshToken: 'refresh', expiresAt: 4102444800, userId: 'user', email: 'legacy@example.com' });
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
      if (String(url).endsWith('/auth/v1/user')) return new Promise(() => {});
      throw new Error('unexpected URL ' + url);
    };
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({ accessToken: 'access', refreshToken: 'refresh', expiresAt: 4102444800, userId: 'user', email: 'legacy@example.com' });
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

test('a legacy session hydrates optional profile data without signing in again', () => {
  const result = runIsolated(`
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/auth/v1/user')) return Response.json({
        id: 'user', email: 'legacy@example.com',
        user_metadata: { full_name: 'Legacy Person', picture: 'https://lh3.googleusercontent.com/a/legacy' },
      });
      return Response.json({ error: 'quota offline' }, { status: 503 });
    };
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({ accessToken: 'access', refreshToken: 'refresh', expiresAt: 4102444800, userId: 'user', email: 'legacy@example.com' });
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
      accessToken: 'access', refreshToken: 'refresh', expiresAt: 4102444800,
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
      accessToken: 'access', refreshToken: 'refresh', expiresAt: 4102444800,
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
      accessToken: 'access', refreshToken: 'refresh', expiresAt: 4102444800,
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
      if (!String(url).endsWith('/auth/v1/token?grant_type=refresh_token')) throw new Error('unexpected URL ' + url);
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({
        access_token: 'access-new', refresh_token: 'refresh-new', expires_at: 4102444800,
        user: { id: 'user', email: 'person@example.com' },
      });
    };
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({
      accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: 1,
      userId: 'user', email: 'person@example.com', displayName: 'Existing Person',
      avatarUrl: 'https://lh3.googleusercontent.com/a/existing',
    });
    const tokens = await Promise.all([account.hostedAccessToken(), account.hostedAccessToken(), account.hostedAccessToken({ forceRefresh: true })]);
    process.stdout.write(JSON.stringify({ refreshCalls, tokens, session: config.getHostedAccountSession() }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.refreshCalls, 1);
  assert.deepEqual(output.tokens, ['access-new', 'access-new', 'access-new']);
  assert.equal(output.session.refreshToken, 'refresh-new');
  assert.equal(output.session.displayName, 'Existing Person');
  assert.equal(output.session.avatarUrl, 'https://lh3.googleusercontent.com/a/existing');
});

test('a stale failed refresh cannot clear a newer hosted session', () => {
  const result = runIsolated(`
    let finishRefresh;
    globalThis.fetch = async () => new Promise((resolve) => { finishRefresh = resolve; });
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    config.setHostedAccountSession({ accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: 1, userId: 'user-old', email: 'old@example.com' });
    const pending = account.hostedAccessToken().catch((error) => error.message);
    await new Promise((resolve) => setImmediate(resolve));
    config.setHostedAccountSession({ accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: 4102444800, userId: 'user-new', email: 'new@example.com' });
    finishRefresh(Response.json({ error_code: 'refresh_token_not_found' }, { status: 400 }));
    await pending;
    process.stdout.write(JSON.stringify(config.getHostedAccountSession()));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).refreshToken, 'refresh-new');
});

test('transient refresh failures preserve credentials, while a revoked refresh token clears them', () => {
  const result = runIsolated(`
    const assert = (await import('node:assert/strict')).default;
    const config = await import('./server/app-config.ts');
    const account = await import('./server/hosted-account.ts');
    const session = { accessToken: 'access', refreshToken: 'refresh', expiresAt: 1, userId: 'user', email: 'person@example.com' };
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
    globalThis.fetch = async () => Response.json({ error_code: 'refresh_token_not_found' }, { status: 400 });
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
    finish(Response.json({access_token:'late',refresh_token:'late',expires_at:4102444800,user:{id:'late',email:'late@example.com'}}));
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
    const payload = (name) => Response.json({access_token:name,refresh_token:name,expires_at:4102444800,user:{id:name,email:name+'@example.com'}});
    let finish;
    globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
    const older = account.beginHostedOAuth('google', 'http://127.0.0.1:8090', 'first');
    const pending = account.exchangeHostedOAuthCode(older.flowId, 'old-code');
    const newer = account.beginHostedOAuth('google', 'http://127.0.0.1:8090', 'second');
    finish(payload('old'));
    await assert.rejects(pending);
    globalThis.fetch = async () => payload('new');
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
    config.setHostedAccountSession({accessToken:'old',refreshToken:'old',expiresAt:1,userId:'old',email:'old@example.com'});
    const pending = account.hostedAccessToken();
    const next = {accessToken:'new',refreshToken:'new',expiresAt:4102444800,userId:'new',email:'new@example.com'};
    config.setHostedAccountSession(next);
    finish(Response.json({access_token:'refreshed-old',refresh_token:'refreshed-old',expires_at:4102444800,user:{id:'old',email:'old@example.com'}}));
    await assert.rejects(pending, /changed while.*refreshing/);
    assert.deepEqual(config.getHostedAccountSession(), next);
  `);
  assert.equal(result.status, 0, result.stderr);
});
