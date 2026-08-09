import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithWindowId } from './folder.ts';
import { requireFolder, validateEmbedderKey } from './http.ts';
import {
  createAppearancePreferencesStore,
  createOnboardingPreferencesStore,
  normalizeAppearancePreferences,
  type AppConfigFile,
} from './app-config.ts';

test('appearance preferences default safely and persist bounded presets', () => {
  let config: AppConfigFile = { appearance: { uiScale: 'large' } };
  const store = createAppearancePreferencesStore({
    read: () => structuredClone(config),
    write: (next) => { config = structuredClone(next); },
  });

  assert.deepEqual(store.get(), {
    theme: 'system',
    uiScale: 'large',
    readingTextSize: 'default',
  });
  assert.deepEqual(store.set({ theme: 'dark', readingTextSize: 'small' }), {
    theme: 'dark',
    uiScale: 'large',
    readingTextSize: 'small',
  });
  assert.deepEqual(store.get(), {
    theme: 'dark',
    uiScale: 'large',
    readingTextSize: 'small',
  });
  assert.deepEqual(normalizeAppearancePreferences({ theme: 'neon', uiScale: 'oversized' }), {
    theme: 'system',
    uiScale: 'default',
    readingTextSize: 'default',
  });
});

test('onboarding acknowledgement preserves unrelated config and normalizes persisted versions', () => {
  let config: AppConfigFile = {
    recentFolders: [{ path: '/notes', openedAt: '2026-08-09T00:00:00.000Z' }],
    apiKey: 'secret',
    onboarding: {
      sourceCodeNoticeVersion: 1,
      unsupportedFormatsNoticeVersion: Number.NaN,
    },
  };
  const store = createOnboardingPreferencesStore({
    read: () => structuredClone(config),
    readStrict: () => structuredClone(config),
    write: (next) => { config = structuredClone(next); },
  });

  assert.deepEqual(store.get(), { sourceCodeNoticeVersion: 1 });
  assert.deepEqual(store.set({ unsupportedFormatsNoticeVersion: 1 }), {
    sourceCodeNoticeVersion: 1,
    unsupportedFormatsNoticeVersion: 1,
  });
  assert.deepEqual(config.recentFolders, [{ path: '/notes', openedAt: '2026-08-09T00:00:00.000Z' }]);
  assert.equal(config.apiKey, 'secret');
});

test('onboarding acknowledgement fails closed when strict config read fails', () => {
  let writes = 0;
  const store = createOnboardingPreferencesStore({
    read: () => ({}),
    readStrict: () => { throw new Error('malformed config'); },
    write: () => { writes += 1; },
  });

  assert.throws(
    () => store.set({ sourceCodeNoticeVersion: 1 }),
    /malformed config/,
  );
  assert.equal(writes, 0);
});

test('onboarding acknowledgement rejects unknown or invalid preference values', () => {
  let strictReads = 0;
  const store = createOnboardingPreferencesStore({
    read: () => ({}),
    readStrict: () => { strictReads += 1; return {}; },
    write: () => {},
  });

  assert.throws(
    () => store.set({ sourceCodeNoticeVersion: '1' }),
    /sourceCodeNoticeVersion must be a non-negative integer/,
  );
  assert.throws(
    () => store.set({ futureNotice: 1 }),
    /unsupported onboarding preference: futureNotice/,
  );
  assert.equal(strictReads, 0);
});

test('folder-explicit preparation routes work without an open window folder', async () => {
  for (const path of ['/prepare', '/reprocess', '/cancel-preparation']) {
    let nextCalled = false;
    let responseStatus = 0;
    await runWithWindowId(`folder-explicit-gate-${path}`, () => {
      requireFolder({
        method: 'POST',
        baseUrl: '/api/files',
        path,
        body: { folder: '/tmp/member-folder' },
      } as any, {
        status(code: number) {
          responseStatus = code;
          return this;
        },
        json() { return this; },
      } as any, () => { nextCalled = true; });
    });
    assert.equal(responseStatus, 0, path);
    assert.equal(nextCalled, true, path);
  }
});

test('embedder key validation uses the provider models endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization') });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await validateEmbedderKey('openrouter', 'sk-or-v1-test', { timeoutMs: 1000 }), { ok: true });
    assert.deepEqual(calls, [{
      url: 'https://openrouter.ai/api/v1/models',
      authorization: 'Bearer sk-or-v1-test',
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('embedder key validation accepts an OpenAI key restricted to embeddings', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; authorization: string | null; body: string | null }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        error: {
          message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.',
        },
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ data: [{ embedding: [0] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    assert.deepEqual(
      await validateEmbedderKey('openai', 'sk-restricted', { timeoutMs: 1000 }),
      { ok: true },
    );
    assert.deepEqual(calls, [
      {
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
        authorization: 'Bearer sk-restricted',
        body: null,
      },
      {
        url: 'https://api.openai.com/v1/embeddings',
        method: 'POST',
        authorization: 'Bearer sk-restricted',
        body: JSON.stringify({ model: 'text-embedding-3-small', input: 'StashBase' }),
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('embedder key validation rejects a models-restricted OpenAI key without embedding access', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response('Missing scopes: api.model.read.', { status: 403 });
    }
    return new Response('Missing scopes: api.embeddings.write.', { status: 403 });
  }) as typeof fetch;
  try {
    assert.deepEqual(
      await validateEmbedderKey('openai', 'sk-too-restricted', { timeoutMs: 1000 }),
      {
        ok: false,
        status: 400,
        error: 'OpenAI rejected the key (HTTP 403): Missing scopes: api.embeddings.write.',
      },
    );
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('embedder key validation rejects definite provider auth failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('bad key', { status: 401 })) as typeof fetch;
  try {
    assert.deepEqual(
      await validateEmbedderKey('openrouter', 'bad', { timeoutMs: 1000 }),
      { ok: false, status: 400, error: 'OpenRouter rejected the key (HTTP 401): bad key' },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
