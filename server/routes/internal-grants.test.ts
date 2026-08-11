import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { mountInternalGrantsRoute } from './internal-grants.ts';
import { runWithWindowId } from '../folder.ts';

test('internal preview grants API lifecycle', async () => {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const winId = req.header('x-stashbase-window-id') || 'default';
    runWithWindowId(winId, next);
  });

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

  } finally {
    fs.rmSync(tempFile, { force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
