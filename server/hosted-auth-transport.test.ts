import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthNetworkBridge } from '../electron/account/auth-network.ts';
import { createHostedAuthRequest, createHostedUsageFetch, createHostedAllowanceRequest } from './hosted-auth-transport.ts';
import { AUTH_REQUEST_LIMIT, AUTH_RESPONSE_LIMIT, AUTH_BASE_URL, USAGE_RELAY_PATH, USAGE_REQUEST_LIMIT, ALLOWANCE_API_URL, ALLOWANCE_RELAY_PATH } from '../shared/hosted-auth-network.ts';

test('credit relay admits only the fixed authenticated read and preserves HTTP failures and cancellation', async t => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let entered!: () => void;
  let aborted!: () => void;
  let stall = false;
  const bridge = await createAuthNetworkBridge({ fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    if (stall) {
      entered();
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        aborted(); reject(init.signal?.reason);
      }, { once: true }));
    }
    return Response.json({ code: 'auth_required' }, { status: 401, headers: { 'x-request-id': 'credits-request', 'set-cookie': 'private-cookie' } });
  } });
  t.after(() => bridge.close());
  const request = createHostedAllowanceRequest({ port: String(bridge.port), token: bridge.token, required: true });
  const response = await request({ accessToken: 'fixture-api-token', clientVersion: '2.18.4', signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { code: 'auth_required' });
  assert.equal(response.headers.get('x-request-id'), 'credits-request');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(calls[0].url, ALLOWANCE_API_URL);
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer fixture-api-token');
  assert.equal(new Headers(calls[0].init?.headers).get('x-stashbase-client-version'), '2.18.4');
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(calls[0].init?.credentials, 'omit');
  const url = `http://127.0.0.1:${bridge.port}${ALLOWANCE_RELAY_PATH}`;
  const headers = { 'x-stashbase-auth-network-token': bridge.token };
  const valid = { accessToken: 'fixture-api-token', clientVersion: '2.18.4' };
  for (const body of [{ ...valid, url: 'https://attacker.example' }, { ...valid, path: '/v1/billing/checkout' }, { ...valid, clientVersion: 'bad\r\nheader' }, { ...valid, accessToken: '' }]) {
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(valid) })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' }, body: JSON.stringify(valid) })).status, 403);
  await assert.rejects(createHostedAllowanceRequest({ required: true })({ ...valid, signal: AbortSignal.timeout(1000) }), /AUTH_BRIDGE_UNAVAILABLE/);
  assert.equal(calls.length, 1);
  stall = true;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stopped = new Promise<void>(resolve => { aborted = resolve; });
  const controller = new AbortController();
  const result = request({ ...valid, signal: controller.signal });
  const rejection = assert.rejects(result, { name: 'AbortError' });
  await started;
  controller.abort();
  await Promise.all([stopped, rejection]);
  assert.equal(calls.length, 2, 'cancelled credit reads are not retried');
});

test('desktop auth uses only the native transport for exchange, refresh, profile and logout', async t => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const bridge = await createAuthNetworkBridge({ fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    return String(url).includes('sign-out') ? new Response(null, { status: 204 })
      : Response.json({ access_token: 'fixture-access' });
  } });
  t.after(() => bridge.close());
  const request = createHostedAuthRequest({ port: String(bridge.port), token: bridge.token, required: true });
  for (const path of ['/electron/token', '/token', '/get-session', '/sign-out']) {
    const response = await request(path, { body: { auth_code: 'fixture-code' }, accessToken: 'fixture-access', signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, path.includes('sign-out') ? 204 : 200);
    if (response.status === 200) assert.deepEqual(await response.json(), { access_token: 'fixture-access' });
  }
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, `${AUTH_BASE_URL}/electron/token`);
  assert.equal(calls[0].init?.body, JSON.stringify({ auth_code: 'fixture-code' }));
  for (const call of calls) {
    assert.equal(call.init?.redirect, 'error');
    assert.equal(call.init?.credentials, 'omit');
    assert.equal(new Headers(call.init?.headers).get('authorization'), 'Bearer fixture-access');
  }
  assert.equal(calls[2].init?.method, 'GET');
  assert.equal(calls[2].init?.body, undefined);
});

test('private native relay rejects browser callers, invalid capabilities and destinations before sending', async t => {
  let calls = 0;
  const bridge = await createAuthNetworkBridge({ fetch: async () => { calls++; return Response.json({}); } });
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.port}/`;
  const headers = { 'x-stashbase-auth-network-token': bridge.token };
  for (const supplied of [undefined, 'wrong', 'a'.repeat(64), 'é'.repeat(64)]) {
    const response = await fetch(url, { method: 'POST', headers: supplied ? { 'x-stashbase-auth-network-token': supplied } : {}, body: '{}' });
    assert.equal(response.status, 403);
    await response.body?.cancel();
  }
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' }, body: '{}' })).status, 403);
  for (const path of ['https://attacker.example', '//attacker.example', '/user/../../admin/users', '/user?redirect=https://attacker.example']) {
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ path }) })).status, 400);
  }
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(AUTH_REQUEST_LIMIT + 1) })).status, 413);
  assert.equal(calls, 0);
});

test('native transport retains provider rejection but sends only safe network error codes', async t => {
  let mode = 'http';
  const bridge = await createAuthNetworkBridge({ fetch: async () => {
    if (mode === 'http') return Response.json({ error_code: 'flow_state_expired', msg: 'Expired authorization' }, { status: 400 });
    if (mode === 'large') return new Response('x'.repeat(AUTH_RESPONSE_LIMIT + 1));
    if (mode === 'unreadable') return new Response('upstream unavailable', { status: 503, headers: {
      'content-type': 'text/plain', 'x-request-id': 'fixture-request', 'set-cookie': 'private-cookie',
    } });
    throw new Error('net::ERR_PROXY_CONNECTION_FAILED https://user:private-password@proxy.test/?code=private-code');
  } });
  t.after(() => bridge.close());
  const request = createHostedAuthRequest({ port: String(bridge.port), token: bridge.token, required: true });
  const invoke = () => request('/electron/token', { body: {}, signal: AbortSignal.timeout(2000) });
  const rejected = await invoke();
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error_code: 'flow_state_expired', msg: 'Expired authorization' });
  mode = 'unreadable';
  const unreadable = await invoke();
  assert.equal(unreadable.status, 503);
  assert.equal(unreadable.headers.get('content-type'), 'text/plain');
  assert.equal(unreadable.headers.get('x-request-id'), 'fixture-request');
  assert.equal(unreadable.headers.get('set-cookie'), null);
  assert.equal(await unreadable.text(), 'upstream unavailable');
  mode = 'network';
  await assert.rejects(invoke, error => {
    assert.match(String(error), /exchange.*system proxy.*ERR_PROXY_CONNECTION_FAILED/);
    assert.doesNotMatch(JSON.stringify(error), /private-password|private-code/);
    return true;
  });
  mode = 'large';
  await assert.rejects(invoke, /AUTH_RESPONSE_TOO_LARGE/);
});

test('usage batches follow the proxy-aware relay only to the fixed ingestion destination', async t => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const bridge = await createAuthNetworkBridge({ usageUrl: 'https://ingest.test/batch/', fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ status: 'Ok' });
  } });
  t.after(() => bridge.close());
  const usage = createHostedUsageFetch({ port: String(bridge.port), token: bridge.token, required: true });
  const body = JSON.stringify({ api_key: 'phc_test', batch: [{ event: 'app_opened' }] });
  const response = await usage('https://attacker.example/collect', { method: 'POST', body, signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ingest.test/batch/');
  assert.equal(calls[0].init?.body, body);
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(calls[0].init?.credentials, 'omit');
  const url = `http://127.0.0.1:${bridge.port}${USAGE_RELAY_PATH}`;
  const headers = { 'x-stashbase-auth-network-token': bridge.token };
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{"path":"/token"}' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(USAGE_REQUEST_LIMIT + 1) })).status, 413);
  assert.equal((await fetch(url, { method: 'POST', body })).status, 403);
  assert.equal(calls.length, 1);

  const unconfigured = await createAuthNetworkBridge({ usageUrl: undefined, fetch: async () => { calls.push({ url: 'unexpected' }); return Response.json({}); } });
  t.after(() => unconfigured.close());
  const refused = await fetch(`http://127.0.0.1:${unconfigured.port}${USAGE_RELAY_PATH}`, {
    method: 'POST', headers: { 'x-stashbase-auth-network-token': unconfigured.token }, body });
  assert.equal(refused.status, 404);
  await assert.rejects(createHostedUsageFetch({ required: true })('https://ingest.test/batch/', { method: 'POST', body }), (error: { code?: string }) => error.code === 'AUTH_BRIDGE_UNAVAILABLE');
  assert.equal(calls.length, 1);
});

test('caller cancellation and desktop shutdown abort upstream requests without retry', async t => {
  let calls = 0;
  let entered!: () => void;
  let aborted!: () => void;
  const bridge = await createAuthNetworkBridge({ fetch: async (_url, init) => {
    calls++;
    entered();
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
      aborted(); reject(init.signal?.reason);
    }, { once: true }));
  } });
  t.after(() => bridge.close());
  const request = createHostedAuthRequest({ port: String(bridge.port), token: bridge.token, required: true });
  for (const closing of [false, true]) {
    const started = new Promise<void>(resolve => { entered = resolve; });
    const stopped = new Promise<void>(resolve => { aborted = resolve; });
    const controller = new AbortController();
    const result = request('/electron/token', { body: {}, signal: controller.signal });
    const rejection = assert.rejects(result, /cancelled|interrupted|ECONNRESET/);
    await started;
    if (closing) bridge.close(); else controller.abort();
    await Promise.all([stopped, rejection]);
  }
  assert.equal(calls, 2);
});

test('desktop missing or failed relay never silently falls back to direct fetch', async () => {
  const oldFetch = globalThis.fetch;
  let direct = 0;
  globalThis.fetch = async () => { direct++; return Response.json({}); };
  try {
    await assert.rejects(createHostedAuthRequest({ required: true })('/get-session', { signal: AbortSignal.timeout(1000) }), /AUTH_BRIDGE_UNAVAILABLE/);
    const bridge = await createAuthNetworkBridge({ fetch: globalThis.fetch });
    bridge.close();
    await assert.rejects(createHostedAuthRequest({ required: true, port: String(bridge.port), token: bridge.token })('/get-session', { signal: AbortSignal.timeout(1000) }));
    assert.equal(direct, 0);
    await createHostedAuthRequest({ required: false })('/get-session', { signal: AbortSignal.timeout(1000) });
    assert.equal(direct, 1);
  } finally { globalThis.fetch = oldFetch; }
});

test('Gallery reports use a fixed anonymous native destination and cannot carry account or file data', async t => {
  const { GALLERY_DOWNLOAD_API_URL, GALLERY_DOWNLOAD_RELAY_PATH } = await import('../shared/hosted-auth-network.ts');
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const bridge = await createAuthNetworkBridge({ fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ ok: true });
  } });
  t.after(() => bridge.close());
  const send = createHostedUsageFetch({ port: String(bridge.port), token: bridge.token, required: true });
  const body = { templateId: 'resume-builder', operationId: '11111111-1111-4111-8111-111111111111' };
  const response = await send(GALLERY_DOWNLOAD_API_URL, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, GALLERY_DOWNLOAD_API_URL);
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), null);
  assert.equal(calls[0].init?.credentials, 'omit');
  for (const extra of [{ path: '/private/project' }, { accessToken: 'secret' }, { url: 'https://other.test' }]) {
    const result = await fetch(`http://127.0.0.1:${bridge.port}${GALLERY_DOWNLOAD_RELAY_PATH}`, {
      method: 'POST', headers: { 'x-stashbase-auth-network-token': bridge.token }, body: JSON.stringify({ ...body, ...extra }),
    });
    assert.equal(result.status, 400);
  }
  assert.equal(calls.length, 1);
});
