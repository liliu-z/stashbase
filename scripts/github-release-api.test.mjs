import assert from 'node:assert/strict';
import test from 'node:test';
import { findDraftReleaseByTag, uploadReleaseAssets } from './github-release-api.mjs';

test('draft release lookup resolves the GraphQL tag result through the REST release id', async () => {
  const release = {
    id: 371_783_118,
    tag_name: 'v2.0.6',
    draft: true,
    assets: [],
  };
  const calls = [];
  const request = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (pathname === '/graphql') {
      return {
        data: {
          repository: {
            release: { databaseId: release.id, isDraft: true },
          },
        },
      };
    }
    if (pathname === `/repos/liliu-z/stashbase/releases/${release.id}`) return release;
    if (pathname.includes('/releases/tags/')) return null;
    assert.fail(`Unexpected GitHub request: ${pathname}`);
  };

  const found = await findDraftReleaseByTag({
    request,
    repo: 'liliu-z/stashbase',
    tag: 'v2.0.6',
  });

  assert.equal(found, release);
  assert.equal(calls[0]?.pathname, '/graphql');
  assert.equal(calls[0]?.options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0]?.options.body), {
    query: 'query RepositoryReleaseByTag($owner:String!,$name:String!,$tagName:String!){repository(owner:$owner,name:$name){release(tagName:$tagName){databaseId,isDraft}}}',
    variables: { owner: 'liliu-z', name: 'stashbase', tagName: 'v2.0.6' },
  });
});

function fakeAssetApi({ responses, stored = [] }) {
  let assets = [...stored];
  const calls = [];
  let nextId = 900;

  return {
    calls,
    listAssets: async () => {
      calls.push('list');
      return assets.map((asset) => ({ ...asset }));
    },
    deleteAsset: async (id) => {
      calls.push(`delete:${id}`);
      assets = assets.filter((asset) => asset.id !== id);
    },
    putAsset: async (asset) => {
      calls.push(`put:${asset.name}`);
      const reply = responses.shift();
      if (!reply) assert.fail(`Unexpected upload of ${asset.name}`);
      if (reply.transport) throw new Error(reply.transport);
      if (!reply.ok) {
        // A save that fails this way can leave a placeholder record behind.
        if (reply.leavesPlaceholder) {
          assets.push({ id: (nextId += 1), name: asset.name, size: 0, state: 'new' });
        }
        return { ok: false, status: reply.status, statusText: 'Internal Server Error', body: reply.body ?? '' };
      }
      assets.push({ id: (nextId += 1), name: asset.name, size: asset.size, state: 'uploaded' });
      return { ok: true, status: 201, statusText: 'Created', body: '' };
    },
  };
}

const asset = { path: '/tmp/StashBase.AppImage', name: 'StashBase.AppImage', size: 333_228_446 };
const instantDelay = async () => {};

test('a retryable asset-save failure is retried after its placeholder record is discarded', async () => {
  const api = fakeAssetApi({
    responses: [
      { ok: false, status: 500, body: 'Error saving asset', leavesPlaceholder: true },
      { ok: true },
    ],
  });

  await uploadReleaseAssets({ api, tag: 'v2.9.4', assets: [asset], delay: instantDelay });

  assert.deepEqual(api.calls, [
    'list',
    'put:StashBase.AppImage',
    'list',
    'delete:901',
    'put:StashBase.AppImage',
  ]);
});

test('a transport failure mid-upload is retried', async () => {
  const api = fakeAssetApi({
    responses: [{ transport: 'aborted' }, { ok: true }],
  });

  await uploadReleaseAssets({ api, tag: 'v2.9.4', assets: [asset], delay: instantDelay });

  assert.deepEqual(api.calls.filter((call) => call.startsWith('put')).length, 2);
});

test('only an asset with the same size and SHA-256 is kept without re-uploading', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const api = fakeAssetApi({
    responses: [],
    stored: [{ id: 5, name: asset.name, size: asset.size, digest, state: 'uploaded' }],
  });

  await uploadReleaseAssets({ api, tag: 'v2.9.4', assets: [{ ...asset, digest }], delay: instantDelay });

  assert.deepEqual(api.calls, ['list']);
  for (const localDigest of [`sha256:${'b'.repeat(64)}`, undefined]) {
    await assert.rejects(uploadReleaseAssets({ api, tag: 'v2.9.4',
      assets: [{ ...asset, digest: localDigest }], delay: instantDelay }), /immutable/);
  }
  const unverified = fakeAssetApi({ responses: [],
    stored: [{ id: 5, name: asset.name, size: asset.size, state: 'uploaded' }] });
  await assert.rejects(uploadReleaseAssets({ api: unverified, tag: 'v2.9.4',
    assets: [{ ...asset, digest }], delay: instantDelay }), /immutable/);
});

test('an asset stored at a different size stops the release instead of being replaced', async () => {
  const api = fakeAssetApi({
    responses: [],
    stored: [{ id: 5, name: asset.name, size: 17, state: 'uploaded' }],
  });

  await assert.rejects(
    uploadReleaseAssets({ api, tag: 'v2.9.4', assets: [asset], delay: instantDelay }),
    /already contains StashBase\.AppImage at 17 bytes but this build produced 333228446 bytes/,
  );
  assert.deepEqual(api.calls, ['list']);
});

test('a rejection GitHub will not reconsider is not retried', async () => {
  const api = fakeAssetApi({ responses: [{ ok: false, status: 422, body: 'Validation Failed' }] });

  await assert.rejects(
    uploadReleaseAssets({ api, tag: 'v2.9.4', assets: [asset], delay: instantDelay }),
    /after 1 attempt\(s\).*HTTP 422/s,
  );
  assert.equal(api.calls.filter((call) => call.startsWith('put')).length, 1);
});

test('repeated asset-save failures fail the release after the attempt budget', async () => {
  const api = fakeAssetApi({
    responses: Array.from({ length: 3 }, () => ({ ok: false, status: 500, body: 'Error saving asset' })),
  });

  await assert.rejects(
    uploadReleaseAssets({ api, tag: 'v2.9.4', assets: [asset], attempts: 3, delay: instantDelay }),
    /after 3 attempt\(s\).*Error saving asset/s,
  );
  assert.equal(api.calls.filter((call) => call.startsWith('put')).length, 3);
});

test('every asset is uploaded in turn rather than concurrently', async () => {
  const many = [
    { path: '/tmp/a.deb', name: 'a.deb', size: 10 },
    { path: '/tmp/b.AppImage', name: 'b.AppImage', size: 20 },
    { path: '/tmp/latest-linux.yml', name: 'latest-linux.yml', size: 30 },
  ];
  const api = fakeAssetApi({ responses: many.map(() => ({ ok: true })) });

  await uploadReleaseAssets({ api, tag: 'v2.9.4', assets: many, delay: instantDelay });

  assert.deepEqual(api.calls, [
    'list',
    'put:a.deb',
    'list',
    'put:b.AppImage',
    'list',
    'put:latest-linux.yml',
  ]);
});
