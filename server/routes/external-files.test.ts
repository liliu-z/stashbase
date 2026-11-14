import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { spreadsheetFixture } from '../__tests__/spreadsheet-fixtures.ts';

import {
  EXTERNAL_FILE_REGISTRATION_TOKEN_HEADER,
  externalFileOpenResultSchema,
  type ExternalFileOpenResult,
} from '../../shared/protocols/http/external-files.ts';
import {
  clearExternalFileGrants,
  DEVELOPMENT_REGISTRATION_TOKEN_FILE,
  externalFileRegistrationToken,
} from '../external-files.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { appDataRoot } from '../local-data.ts';
import {
  clearCurrentFolder,
  openProjectFolder,
  registerProjectFolderAsync,
  removeRecentAsync,
  runWithWindowId,
  WINDOW_ID_HEADER,
} from '../folder.ts';
import { withWindowContext } from '../http.ts';
import { mount } from './external-files.ts';
import { DIRECTORY_LINK } from '../__tests__/filesystem-links.ts';

const REGISTRATION_TOKEN = 'main-process-only';

async function withServer(
  run: (fixture: {
    base: string;
    outside: string;
    project: string;
    register(windowId: string, file: string, token?: string): Promise<Response>;
    revealed: string[];
  }) => Promise<void>,
): Promise<void> {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-external-')));
  const project = path.join(scratch, 'project');
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  await runWithWindowId('window-a', () => openProjectFolder(project));
  await runWithWindowId('window-b', () => openProjectFolder(project));
  const revealed: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(withWindowContext);
  mount(app, { registrationToken: REGISTRATION_TOKEN, revealInFileManager: (target) => revealed.push(target) });
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const register = (windowId: string, file: string, token = REGISTRATION_TOKEN) =>
    fetch(`${base}/api/internal/external-files`, {
      body: JSON.stringify({ path: file }),
      headers: {
        'content-type': 'application/json',
        [EXTERNAL_FILE_REGISTRATION_TOKEN_HEADER]: token,
        [WINDOW_ID_HEADER]: windowId,
      },
      method: 'POST',
    });
  try {
    await run({ base, outside, project, register, revealed });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearExternalFileGrants();
    clearCurrentFolder('window-a');
    clearCurrentFolder('window-b');
    await removeRecentAsync(project);
    fs.rmSync(scratch, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
  }
}

async function opened(response: Response): Promise<ExternalFileOpenResult> {
  assert.equal(response.status, 200);
  return externalFileOpenResultSchema.parse(await response.json());
}

function inWindow(windowId: string): RequestInit {
  return { headers: { [WINDOW_ID_HEADER]: windowId } };
}

test('only the registration token can grant a dropped file', async () => {
  await withServer(async ({ outside, register }) => {
    const file = path.join(outside, 'notes.md');
    fs.writeFileSync(file, '# Outside');
    assert.equal((await register('window-a', file, 'renderer-guess')).status, 403);
    assert.equal((await register('window-a', file, '')).status, 403);
  });
});

test('a granted text file reads by token only in the window that dropped it', async () => {
  await withServer(async ({ base, outside, project, register }) => {
    const file = path.join(outside, 'notes.md');
    fs.writeFileSync(file, '# Outside notes');
    fs.writeFileSync(path.join(outside, 'secret.md'), '# Sibling');
    const result = await opened(await register('window-a', file));
    assert.equal(result.kind, 'external');
    if (result.kind !== 'external') return;
    assert.equal(result.path, filesystemPath.absolute(file));
    assert.equal(result.format, 'md');

    const text = await fetch(`${base}/api/external-files/${result.token}/text`, inWindow('window-a'));
    assert.equal(text.status, 200);
    assert.equal(((await text.json()) as { content: string }).content, '# Outside notes');
    const version = await fetch(`${base}/api/external-files/${result.token}`, { ...inWindow('window-a'), method: 'HEAD' });
    assert.equal(version.status, 204);
    assert.match(version.headers.get('x-stashbase-file-version') ?? '', /^stat:/u);

    const elsewhere = await fetch(`${base}/api/external-files/${result.token}/text`, inWindow('window-b'));
    assert.equal(elsewhere.status, 404, 'another window cannot use the grant');
    await fetch(`${base}/api/external-files/${result.token}`, { ...inWindow('window-b'), method: 'DELETE' });
    assert.equal(
      (await fetch(`${base}/api/external-files/${result.token}/text`, inWindow('window-a'))).status,
      200,
      'another window cannot revoke the grant',
    );

    assert.deepEqual(fs.readdirSync(project), [], 'opening does not copy into the project');
    assert.deepEqual(fs.readdirSync(outside).sort(), ['notes.md', 'secret.md'], 'nothing is written beside the file');

    const again = await opened(await register('window-a', file));
    assert.equal(again.kind === 'external' && again.token, result.token, 'the same file reuses its grant');

    await fetch(`${base}/api/external-files/${result.token}`, { ...inWindow('window-a'), method: 'DELETE' });
    assert.equal((await fetch(`${base}/api/external-files/${result.token}/text`, inWindow('window-a'))).status, 404);
  });
});

test('a binary grant serves only its own bytes, whatever the URL names', async () => {
  await withServer(async ({ base, outside, register }) => {
    const pdf = path.join(outside, 'paper.pdf');
    fs.writeFileSync(pdf, '%PDF-1.7\nexternal fixture\n');
    fs.writeFileSync(path.join(outside, 'other.pdf'), '%PDF-1.7\nsibling\n');
    const result = await opened(await register('window-a', pdf));
    assert.equal(result.kind, 'external');
    if (result.kind !== 'external') return;
    for (const name of ['paper.pdf', 'other.pdf', '..%2Fother.pdf']) {
      const response = await fetch(`${base}/asset/__external/${result.token}/${name}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.equal(await response.text(), '%PDF-1.7\nexternal fixture\n');
    }
    assert.equal((await fetch(`${base}/api/external-files/${result.token}/text`, inWindow('window-a'))).status, 404);
  });
});

test('a grant refuses a path component later swapped for a symlink', async () => {
  await withServer(async ({ base, outside, register }) => {
    const folder = path.join(outside, 'drafts');
    const elsewhere = path.join(outside, 'private');
    fs.mkdirSync(folder);
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(folder, 'notes.md'), '# Dropped');
    fs.writeFileSync(path.join(elsewhere, 'notes.md'), '# Not dropped');
    const result = await opened(await register('window-a', path.join(folder, 'notes.md')));
    assert.equal(result.kind, 'external');
    if (result.kind !== 'external') return;
    fs.renameSync(folder, `${folder}-moved`);
    fs.symlinkSync(elsewhere, folder, DIRECTORY_LINK);
    assert.equal((await fetch(`${base}/api/external-files/${result.token}/text`, inWindow('window-a'))).status, 404);
  });
});

test('dropping decides between the project copy, a grant, and a refusal', async () => {
  await withServer(async ({ outside, project, register }) => {
    fs.mkdirSync(path.join(project, 'drafts'));
    fs.writeFileSync(path.join(project, 'drafts', 'plan.md'), '# Plan');
    fs.writeFileSync(path.join(outside, 'report.docx'), 'docx bytes');
    fs.writeFileSync(path.join(outside, 'page.html'), '<p>page</p>');
    fs.writeFileSync(path.join(outside, 'clip.mp3'), 'audio');
    fs.writeFileSync(path.join(outside, 'data.csv'), 'a,b\n1,2\n');
    fs.writeFileSync(path.join(outside, 'server.log'), 'started\n');
    fs.writeFileSync(path.join(outside, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    fs.mkdirSync(path.join(outside, 'folder'));

    assert.deepEqual(await opened(await register('window-a', path.join(project, 'drafts', 'plan.md'))), {
      format: 'md',
      kind: 'project',
      path: 'drafts/plan.md',
    });
    for (const name of ['report.docx', 'page.html', 'clip.mp3', 'blob.bin']) {
      assert.deepEqual(await opened(await register('window-a', path.join(outside, name))), {
        kind: 'refused',
        name,
        reason: 'copy-required',
      });
    }
    assert.deepEqual(await opened(await register('window-a', path.join(outside, 'folder'))), {
      kind: 'refused',
      name: 'folder',
      reason: 'directory',
    });
    const csv = await opened(await register('window-a', path.join(outside, 'data.csv')));
    assert.equal(csv.kind === 'external' && csv.format, 'csv');
    const log = await opened(await register('window-a', path.join(outside, 'server.log')));
    assert.equal(log.kind === 'external' && log.format, 'generic');
  });
});

for (const alias of [false, true]) {
  test(`a file of another registered project opens through ${alias ? 'a directory alias' : 'its registered path'}`, async () => {
    await withServer(async ({ outside, register }) => {
      const other = path.join(outside, 'other-project');
      const registered = alias ? path.join(outside, 'project-alias') : other;
      fs.mkdirSync(path.join(other, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(other, 'notes', 'plan.md'), '# Plan');
      if (alias) fs.symlinkSync(other, registered, 'junction');
      await registerProjectFolderAsync(outside);
      await registerProjectFolderAsync(registered);
      try {
        assert.deepEqual(await opened(await register('window-a', path.join(other, 'notes', 'plan.md'))), {
          folderPath: filesystemPath.absolute(registered),
          format: 'md',
          kind: 'project',
          path: 'notes/plan.md',
        });
      } finally {
        await removeRecentAsync(registered);
        await removeRecentAsync(outside);
      }
    });
  });
}

// realpath keeps a macOS firmlink spelling as it is, so only the directory's
// identity on disk ties it to the spelling a dropped file arrives with.
const DATA_VOLUME = '/System/Volumes/Data';
test('a project spelled through the macOS data-volume firmlink still owns its files', {
  skip: process.platform !== 'darwin' || !fs.existsSync(`${DATA_VOLUME}${fs.realpathSync(os.tmpdir())}`),
}, async () => {
  await withServer(async ({ outside, project, register }) => {
    const other = path.join(outside, 'other-project');
    fs.mkdirSync(path.join(other, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(other, 'notes', 'plan.md'), '# Plan');
    fs.writeFileSync(path.join(project, 'own.md'), '# Own');
    const otherSpelled = `${DATA_VOLUME}${other}`;
    const projectSpelled = `${DATA_VOLUME}${project}`;
    await registerProjectFolderAsync(otherSpelled);
    try {
      assert.deepEqual(await opened(await register('window-a', path.join(other, 'notes', 'plan.md'))), {
        folderPath: otherSpelled,
        format: 'md',
        kind: 'project',
        path: 'notes/plan.md',
      });
      await runWithWindowId('window-b', () => openProjectFolder(projectSpelled));
      assert.deepEqual(await opened(await register('window-b', path.join(project, 'own.md'))), {
        format: 'md',
        kind: 'project',
        path: 'own.md',
      });
    } finally {
      await removeRecentAsync(otherSpelled);
      await removeRecentAsync(projectSpelled);
    }
  });
});

test("StashBase's own data never opens from a drop", async () => {
  await withServer(async ({ register }) => {
    const files = [
      path.join(os.homedir(), '.stashbase', 'drop-fixture.json'),
      path.join(appDataRoot(), 'derived.nosync', 'drop-fixture.md'),
    ];
    try {
      for (const file of files) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{}');
        assert.deepEqual(await opened(await register('window-a', file)), {
          kind: 'refused',
          name: path.basename(file),
          reason: 'unavailable',
        });
      }
    } finally {
      for (const file of files) fs.rmSync(file, { force: true });
    }
  });
});

test('generic text previews through its grant, and leaving the project revokes it', async () => {
  await withServer(async ({ base, outside, register, revealed }) => {
    const file = path.join(outside, 'server.log');
    fs.writeFileSync(file, 'a,b\n1,2\n');
    const result = await opened(await register('window-a', file));
    assert.equal(result.kind, 'external');
    if (result.kind !== 'external') return;
    const preview = await fetch(`${base}/api/external-files/${result.token}/preview`, inWindow('window-a'));
    assert.equal(preview.status, 200);
    const body = (await preview.json()) as { content?: string; kind: string; name: string };
    assert.equal(body.kind, 'text');
    assert.equal(body.name, result.path);
    assert.equal(body.content, 'a,b\n1,2\n');

    const shown = await fetch(`${base}/api/external-files/${result.token}/reveal`, { ...inWindow('window-a'), method: 'POST' });
    assert.equal(shown.status, 200);
    assert.deepEqual(revealed, [await fs.promises.realpath(file)]);

    clearCurrentFolder('window-a');
    assert.equal((await fetch(`${base}/api/external-files/${result.token}/preview`, inWindow('window-a'))).status, 404);
  });
});

test('an outside CSV reads as table pages and saves as text only through its owning window grant', async () => {
  await withServer(async ({ base, outside, register }) => {
    const file = path.join(outside, 'sales.csv');
    fs.writeFileSync(file, 'item,note\r\nA,"two\nlines"\r\nB,x\r\n');
    const result = await opened(await register('window-a', file));
    assert.equal(result.kind === 'external' && result.format, 'csv');
    if (result.kind !== 'external') return;
    const tableUrl = `${base}/api/external-files/${result.token}/table?start=1&count=10`;
    assert.equal((await fetch(tableUrl, inWindow('window-b'))).status, 404);
    assert.equal((await fetch(`${base}/api/external-files/${result.token}/table?start=-1&count=10`, inWindow('window-a'))).status, 400);
    const table = (await (await fetch(tableUrl, inWindow('window-a'))).json()) as { kind: string; rowCount: number; rows: string[][] };
    assert.equal(table.kind, 'table');
    assert.equal(table.rowCount, 3);
    assert.deepEqual(table.rows, [['A', 'two\nlines'], ['B', 'x']]);
    assert.equal((await fetch(`${base}/api/external-files/${result.token}/preview`, inWindow('window-a'))).status, 404);

    const read = (await (await fetch(`${base}/api/external-files/${result.token}/text`, inWindow('window-a'))).json()) as {
      format: string;
      version: string;
    };
    assert.equal(read.format, 'csv');
    const saved = await fetch(`${base}/api/external-files/${result.token}/text`, {
      body: JSON.stringify({ baseVersion: read.version, content: 'item,note\nA,"two\nlines"\nB,changed\n' }),
      headers: { 'content-type': 'application/json', [WINDOW_ID_HEADER]: 'window-a' },
      method: 'PUT',
    });
    assert.equal(saved.status, 200);
    // The cell's own LF survives; record breaks keep the file's CRLF.
    assert.equal(fs.readFileSync(file, 'utf8'), 'item,note\r\nA,"two\nlines"\r\nB,changed\r\n');
  });
});

test('an outside XLSX previews only through its owning window grant and remains read-only', async () => {
  await withServer(async ({ base, outside, register }) => {
    const file = path.join(outside, 'test.xlsx');
    const bytes = spreadsheetFixture();
    fs.writeFileSync(file, bytes);
    const result = await opened(await register('window-a', file));
    assert.equal(result.kind, 'external');
    if (result.kind !== 'external') return;
    const url = `${base}/api/external-files/${result.token}/preview`;
    assert.equal((await fetch(url, inWindow('window-b'))).status, 404);
    const preview = await fetch(url, inWindow('window-a'));
    assert.equal(preview.status, 200);
    const body = await preview.json() as { kind: string; workbook: { sheets: { name: string }[] } };
    assert.equal(body.kind, 'spreadsheet');
    assert.equal(body.workbook.sheets[0].name, '销售');
    assert.deepEqual(fs.readFileSync(file), bytes);
  });
});

test('a window without a project cannot open an external file', async () => {
  await withServer(async ({ outside, register }) => {
    const file = path.join(outside, 'notes.md');
    fs.writeFileSync(file, '# Outside');
    clearCurrentFolder('window-a');
    assert.deepEqual(await opened(await register('window-a', file)), {
      kind: 'refused',
      name: 'notes.md',
      reason: 'no-project',
    });
  });
});

test('a development server Electron did not start leaves its token only for its owner', () => {
  const env: NodeJS.ProcessEnv = { STASHBASE_EXTERNAL_FILE_TOKEN: 'from-main' };
  assert.equal(externalFileRegistrationToken(env), 'from-main');
  assert.equal(env.STASHBASE_EXTERNAL_FILE_TOKEN, undefined, 'read once, so no spawned process inherits it');
  assert.equal(externalFileRegistrationToken({}), '', 'a packaged server without a token registers nothing');
  fs.rmSync(DEVELOPMENT_REGISTRATION_TOKEN_FILE, { force: true });
  const token = externalFileRegistrationToken({ STASHBASE_DEV_VITE: '1' });
  assert.match(token, /^[0-9a-f]{64}$/u);
  assert.equal(fs.readFileSync(DEVELOPMENT_REGISTRATION_TOKEN_FILE, 'utf8'), token);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(DEVELOPMENT_REGISTRATION_TOKEN_FILE).mode & 0o777, 0o600);
  }
  assert.notEqual(externalFileRegistrationToken({ STASHBASE_DEV_VITE: '1' }), token, 'each start is fresh');
  fs.rmSync(DEVELOPMENT_REGISTRATION_TOKEN_FILE, { force: true });
});

test('an external text file saves against the version read, keeping its format', async () => {
  await withServer(async ({ base, outside, project, register }) => {
    const file = path.join(outside, 'notes.md');
    fs.writeFileSync(file, '﻿# Notes\r\n\r\nFirst.\r\n');
    fs.chmodSync(file, 0o640);
    const result = await opened(await register('window-a', file));
    assert.equal(result.kind, 'external');
    if (result.kind !== 'external') return;
    const save = (windowId: string, body: unknown) =>
      fetch(`${base}/api/external-files/${result.token}/text`, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', [WINDOW_ID_HEADER]: windowId },
        method: 'PUT',
      });
    const read = (await (await fetch(`${base}/api/external-files/${result.token}/text`, inWindow('window-a'))).json()) as {
      content: string;
      version: string;
    };

    const saved = await save('window-a', { baseVersion: read.version, content: '# Notes\n\nSecond.\n' });
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { name: string; version: string };
    assert.equal(body.name, result.path);
    assert.equal(fs.readFileSync(file, 'utf8'), '﻿# Notes\r\n\r\nSecond.\r\n', 'BOM and line endings survive');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(outside), ['notes.md'], 'no staging file is left beside it');
    assert.deepEqual(fs.readdirSync(project), [], 'nothing reaches the project');

    // A change made elsewhere since the editor read it is a conflict.
    fs.writeFileSync(file, '# Changed elsewhere\n');
    const stale = await save('window-a', { baseVersion: body.version, content: '# Mine\n' });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code: string }).code, 'FILE_CHANGED');
    assert.equal(fs.readFileSync(file, 'utf8'), '# Changed elsewhere\n');

    assert.equal((await save('window-b', { content: '# Other window\n', overwrite: true })).status, 404);

    // Writing a deleted file back is the reader's explicit choice.
    fs.rmSync(file);
    assert.equal((await save('window-a', { baseVersion: body.version, content: '# Back\n' })).status, 404);
    assert.equal((await save('window-a', { content: '# Back\n', overwrite: true })).status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), '# Back\n');
  });
});

test('only text files are saved through a grant', async () => {
  await withServer(async ({ base, outside, register }) => {
    const pdf = path.join(outside, 'paper.pdf');
    fs.writeFileSync(pdf, '%PDF-1.7\n');
    const result = await opened(await register('window-a', pdf));
    assert.equal(result.kind, 'external');
    if (result.kind !== 'external') return;
    const response = await fetch(`${base}/api/external-files/${result.token}/text`, {
      body: JSON.stringify({ content: 'text', overwrite: true }),
      headers: { 'content-type': 'application/json', [WINDOW_ID_HEADER]: 'window-a' },
      method: 'PUT',
    });
    assert.equal(response.status, 404);
    assert.equal(fs.readFileSync(pdf, 'utf8'), '%PDF-1.7\n');
  });
});
