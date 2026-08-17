import assert from 'node:assert/strict';
import test from 'node:test';
import { findDraftReleaseByTag } from './github-release-api.mjs';

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
