import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/** The switch is one project's, kept by the server against the project's
 *  identity, and read back by every surface that renders a dollar sign. */
test('project math mode persists per project, answers off by default, rejects other scopes, and is forgotten with the project', () => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-math-mode-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      import express from 'express';
      const config = await import('./server/app-config.ts');
      const { mount } = await import('./server/routes/project-math-mode.ts');
      const { filesystemPath } = await import('./server/filesystem-path.ts');
      const { removeRecentAsync } = await import('./server/folder.ts');
      const project = path.join(os.homedir(), 'notes');
      const other = path.join(os.homedir(), 'thesis');
      fs.mkdirSync(project, { recursive: true });
      fs.mkdirSync(other, { recursive: true });
      config.writeAppConfigStrict({ recentFolders: [project, other].map(folder => ({ path: folder, openedAt: new Date().toISOString() })) });
      const app = express(); app.use(express.json()); mount(app);
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const url = 'http://127.0.0.1:' + server.address().port + '/api/project-math-mode';
      const read = (scope) => fetch(url + '?scope=' + encodeURIComponent(scope));
      const write = (scope, enabled, extra) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope, enabled, ...(extra ?? {}) }) });

      // Off until the reader says otherwise, and the record says nothing.
      assert.deepEqual(await (await read(project)).json(), { scope: filesystemPath.absolute(project), enabled: false });
      assert.equal(config.readAppConfigStrict().mathMode, undefined);
      // Another project's answer is its own, and still off.
      assert.equal((await (await read(other)).json()).enabled, false);

      assert.equal((await write(project, true)).status, 200);
      assert.deepEqual(await (await read(project)).json(), { scope: filesystemPath.absolute(project), enabled: true });
      assert.equal((await (await read(other)).json()).enabled, false);
      assert.deepEqual(config.readAppConfigStrict().mathMode, [{ scope: filesystemPath.absolute(project), enabled: true }]);

      // A second spelling of the same folder is the same project: one record,
      // not two, and the registered identity comes back.
      assert.deepEqual(await (await read(project + path.sep)).json(), { scope: filesystemPath.absolute(project), enabled: true });
      assert.equal((await write(project + path.sep, false)).status, 200);
      assert.equal(config.readAppConfigStrict().mathMode, undefined);
      assert.equal((await write(project, true)).status, 200);
      assert.equal((await write(other, true)).status, 200);
      assert.deepEqual(config.readAppConfigStrict().mathMode, [
        { scope: filesystemPath.absolute(project), enabled: true },
        { scope: filesystemPath.absolute(other), enabled: true },
      ]);

      // Turning it off again leaves nothing behind.
      assert.deepEqual(await (await write(other, false)).json(), { scope: filesystemPath.absolute(other), enabled: false });
      assert.deepEqual(config.readAppConfigStrict().mathMode, [{ scope: filesystemPath.absolute(project), enabled: true }]);

      // Only a registered project has a state.
      assert.equal((await read('/unregistered')).status, 404);
      assert.equal((await read('')).status, 400);
      assert.equal((await write('/unregistered', true)).status, 404);
      assert.equal((await write(project, 'yes')).status, 400);
      assert.equal((await write(project, true, { extra: true })).status, 400);
      assert.equal((await write('', true)).status, 400);

      // Removing the project forgets its choice, the way its Agent choice goes.
      await removeRecentAsync(project);
      assert.equal(config.readAppConfigStrict().mathMode, undefined);
      assert.equal((await read(project)).status, 404);

      // An unreadable config is refused rather than quietly rewritten: the
      // strict write throws and leaves the file byte-identical, and the route
      // can no longer resolve any scope through it.
      const file = path.join(os.homedir(), '.stashbase', 'config.json');
      fs.writeFileSync(file, '{broken');
      assert.throws(() => config.setProjectMathMode(other, true));
      assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
      assert.equal((await read(other)).status, 404);
      assert.equal((await write(other, true)).status, 404);
      await new Promise(resolve => server.close(resolve));
    `], { encoding: 'utf8', env: { ...process.env, HOME: temporaryHome, USERPROFILE: temporaryHome }, timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});
