import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { mountInternalGrantsRoute } from './internal-grants.ts';
import { withWindowContext } from '../http.ts';

test('internal preview grants API lifecycle', async () => {
  const app = express();
  app.use(express.json());
  app.use(withWindowContext);

  const testToken = 'test-token-12345';
  mountInternalGrantsRoute(app, testToken);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const tempFile = path.resolve('/tmp/test-grant-spec.md');
  fs.writeFileSync(tempFile, '# Grant Content\nHello World', 'utf8');

  try {
    const grantId = 'test-grant-id';
    const windowId = 'win-test-456';

    const resFailToken = await fetch(`${baseUrl}/api/internal/grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grantId, windowId, filePath: tempFile }),
    });
    assert.equal(resFailToken.status, 403);

    const resReg = await fetch(`${baseUrl}/api/internal/grants`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-stashbase-shutdown-token': testToken,
      },
      body: JSON.stringify({ grantId, windowId, filePath: tempFile }),
    });
    assert.equal(resReg.status, 200);

    const resWrongWin = await fetch(`${baseUrl}/api/grant/${grantId}/text`, {
      headers: { 'x-stashbase-window-id': 'win-wrong' },
    });
    assert.equal(resWrongWin.status, 403);

    const resCorrectWin = await fetch(`${baseUrl}/api/grant/${grantId}/text`, {
      headers: { 'x-stashbase-window-id': windowId },
    });
    assert.equal(resCorrectWin.status, 200);
    const body = await resCorrectWin.json() as { content: string };
    assert.equal(body.content, '# Grant Content\nHello World');

    const resAssetWrong = await fetch(`${baseUrl}/asset-preview-grant/${grantId}`, {
      headers: { 'x-stashbase-window-id': 'win-wrong' },
    });
    assert.equal(resAssetWrong.status, 403);

    const resAssetCorrect = await fetch(`${baseUrl}/asset-preview-grant/${grantId}`, {
      headers: { 'x-stashbase-window-id': windowId },
    });
    assert.equal(resAssetCorrect.status, 200);
    const text = await resAssetCorrect.text();
    assert.equal(text, '# Grant Content\nHello World');

    // Test browser-style subresource loading via __window/ in URL path (no x-stashbase-window-id header)
    const resWindowPathWrong = await fetch(`${baseUrl}/asset-preview-grant/__window/win-wrong/${grantId}`);
    assert.equal(resWindowPathWrong.status, 403);

    const resWindowPathCorrect = await fetch(`${baseUrl}/asset-preview-grant/__window/${windowId}/${grantId}`);
    assert.equal(resWindowPathCorrect.status, 200);
    const textWindowPath = await resWindowPathCorrect.text();
    assert.equal(textWindowPath, '# Grant Content\nHello World');

    const resRevokeFail = await fetch(`${baseUrl}/api/internal/grants/${grantId}`, {
      method: 'DELETE',
    });
    assert.equal(resRevokeFail.status, 403);

    const resRevoke = await fetch(`${baseUrl}/api/internal/grants/${grantId}`, {
      method: 'DELETE',
      headers: { 'x-stashbase-shutdown-token': testToken },
    });
    assert.equal(resRevoke.status, 200);

    const resAfterRevoke = await fetch(`${baseUrl}/api/grant/${grantId}/text`, {
      headers: { 'x-stashbase-window-id': windowId },
    });
    assert.equal(resAfterRevoke.status, 404);

    // Non-existent path registration rejected with 400
    const resNonExistent = await fetch(`${baseUrl}/api/internal/grants`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-stashbase-shutdown-token': testToken,
      },
      body: JSON.stringify({ grantId: 'fake-id', windowId, filePath: '/tmp/does-not-exist-12345.md' }),
    });
    assert.equal(resNonExistent.status, 400);

    // Symlink repointing test: registering a valid file then replacing with a symlink to another destination
    const validTargetFile = path.resolve('/tmp/test-grant-valid-target.md');
    const secretFile = path.resolve('/tmp/test-grant-secret.md');
    const symlinkPath = path.resolve('/tmp/test-grant-symlink.md');

    fs.writeFileSync(validTargetFile, 'Valid Target Content', 'utf8');
    fs.writeFileSync(secretFile, 'Secret Unauthorized Content', 'utf8');
    fs.symlinkSync(validTargetFile, symlinkPath);

    try {
      const symGrantId = 'symlink-grant-id';
      // Register with canonical target
      const resSymReg = await fetch(`${baseUrl}/api/internal/grants`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-stashbase-shutdown-token': testToken,
        },
        body: JSON.stringify({ grantId: symGrantId, windowId, filePath: symlinkPath }),
      });
      assert.equal(resSymReg.status, 200);

      // Successfully read through canonical target
      const resSymRead = await fetch(`${baseUrl}/api/grant/${symGrantId}/text`, {
        headers: { 'x-stashbase-window-id': windowId },
      });
      assert.equal(resSymRead.status, 200);
      const symBody = await resSymRead.json() as { content: string };
      assert.equal(symBody.content, 'Valid Target Content');

      // Now repoint the target file to the secret file (or replace the registered canonical file with a symlink)
      fs.unlinkSync(validTargetFile);
      fs.symlinkSync(secretFile, validTargetFile);

      // Reading must now be rejected with 403 because realpath !== grant.filePath
      const resSymExploit = await fetch(`${baseUrl}/api/grant/${symGrantId}/text`, {
        headers: { 'x-stashbase-window-id': windowId },
      });
      assert.equal(resSymExploit.status, 403);

      const resAssetSymExploit = await fetch(`${baseUrl}/asset-preview-grant/__window/${windowId}/${symGrantId}`);
      assert.equal(resAssetSymExploit.status, 403);
    } finally {
      fs.rmSync(validTargetFile, { force: true });
      fs.rmSync(secretFile, { force: true });
      fs.rmSync(symlinkPath, { force: true });
    }
  } finally {
    fs.rmSync(tempFile, { force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
