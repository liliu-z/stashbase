import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithWindowId } from './folder.ts';
import { requireFolder } from './http.ts';

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
