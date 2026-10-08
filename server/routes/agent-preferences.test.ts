import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('project Agent choices persist in isolation, reject unregistered scopes, and preserve corrupt config', () => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agent-choice-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      import express from 'express';
      const config = await import('./server/app-config.ts');
      const { mount } = await import('./server/routes/agent-preferences.ts');
      const { filesystemPath } = await import('./server/filesystem-path.ts');
      const project = path.join(os.homedir(), 'project');
      const nested = path.join(project, 'nested');
      fs.mkdirSync(nested, { recursive: true });
      config.writeAppConfigStrict({ recentFolders: [project, nested].map(path => ({ path, openedAt: new Date().toISOString() })), workspace: { showHiddenFiles: true } });
      const app = express(); app.use(express.json()); mount(app);
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const url = 'http://127.0.0.1:' + server.address().port + '/api/agent-preferences';
      const save = (scope, agent, effort) => fetch(url, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({scope,agent,...(effort === undefined ? {} : {effort})}) });
      assert.deepEqual(await (await fetch(url)).json(), []);
      assert.equal((await save(project, 'codex')).status, 200);
      assert.equal((await save(nested, 'claude')).status, 200);
      assert.equal((await save('/unregistered', 'codex')).status, 404);
      assert.equal((await save(project, 'other')).status, 400);
      assert.deepEqual(await (await fetch(url)).json(), [{scope:filesystemPath.absolute(project),agent:'codex'}, {scope:filesystemPath.absolute(nested),agent:'claude'}]);
      assert.equal((await save(project, 'codex', 'high')).status, 200);
      assert.equal((await save(project, 'claude')).status, 200);
      assert.equal((await save(project, 'claude', 'medium')).status, 200);
      assert.equal((await save(project, 'codex', 'low')).status, 200);
      assert.deepEqual(config.readAppConfigStrict().agentPreferences.find(entry => entry.scope === filesystemPath.absolute(project)), {
        scope: filesystemPath.absolute(project), agent: 'claude', efforts: {codex:'low',claude:'medium'},
      });
      assert.equal((await save(project, 'codex', null)).status, 200);
      assert.equal((await save(project, 'codex', '')).status, 400);
      assert.equal((await save(project, 'codex', 2)).status, 400);
      assert.equal((await save('/unregistered', 'codex', 'high')).status, 404);
      const saved = (await (await fetch(url)).json()).find(entry => entry.scope === filesystemPath.absolute(project));
      assert.deepEqual(saved.efforts, {codex:null,claude:'medium'});
      assert.equal(saved.agent, 'claude');
      // A persona chosen in an older Chat becomes the project's choice for new
      // Chats without changing its Agent; null starts them with none.
      const choose = (scope, agent, persona) => fetch(url, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({scope,agent,persona}) });
      assert.equal((await choose(project, 'codex', 'journalist')).status, 200);
      let chosen = (await (await fetch(url)).json()).find(entry => entry.scope === filesystemPath.absolute(project));
      assert.equal(chosen.persona, 'journalist');
      assert.equal(chosen.agent, 'claude');
      assert.equal((await choose(project, 'claude', null)).status, 200);
      chosen = (await (await fetch(url)).json()).find(entry => entry.scope === filesystemPath.absolute(project));
      assert.equal(chosen.persona, null);
      assert.equal((await choose(project, 'claude', '../escape')).status, 400);
      assert.equal(config.readAppConfigStrict().workspace.showHiddenFiles, true);
      const { removeRecentAsync } = await import('./server/folder.ts');
      await removeRecentAsync(project);
      assert.deepEqual(config.readAppConfigStrict().agentPreferences, [{scope:filesystemPath.absolute(nested),agent:'claude'}]);
      assert.ok(fs.existsSync(nested));
      const file = path.join(os.homedir(), '.stashbase/config.json');
      fs.writeFileSync(file, '{broken');
      assert.equal((await fetch(url)).status, 500);
      assert.equal((await save(nested, 'codex')).status, 500);
      assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
      await new Promise(resolve => server.close(resolve));
    `], { encoding: 'utf8', env: { ...process.env, HOME: temporaryHome, USERPROFILE: temporaryHome }, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(temporaryHome, { recursive: true, force: true }); }
});
