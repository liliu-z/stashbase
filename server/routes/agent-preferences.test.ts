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
      assert.deepEqual(await (await fetch(url)).json(), {defaultAgent:'stashbase',defaultModels:{},defaultEfforts:{},projects:[]});
      config.writeAppConfigStrict({...config.readAppConfigStrict(), agentPreferences:[{scope:filesystemPath.absolute(project),agent:'codex',models:{codex:'writer'}}]});
      assert.equal((await (await fetch(url)).json()).defaultAgent, 'codex');
      assert.deepEqual((await (await fetch(url)).json()).defaultModels, {codex:'writer'});
      assert.equal(config.readAppConfigStrict().lastSelectedAgent, undefined);
      assert.equal((await save(project, 'codex')).status, 200);
      assert.equal((await save(nested, 'claude')).status, 200);
      assert.equal((await save('/unregistered', 'codex')).status, 404);
      assert.equal((await save(project, 'other')).status, 400);
      assert.deepEqual(await (await fetch(url)).json(), {defaultAgent:'claude',defaultModels:{codex:'writer'},defaultEfforts:{},projects:[{scope:filesystemPath.absolute(project),agent:'codex',models:{codex:'writer'}}, {scope:filesystemPath.absolute(nested),agent:'claude'}]});
      assert.equal((await save(project, 'codex', 'high')).status, 200);
      assert.equal((await (await fetch(url)).json()).defaultAgent, 'claude');
      assert.equal((await save(project, 'claude')).status, 200);
      assert.equal((await save(project, 'claude', 'medium')).status, 200);
      assert.equal((await save(project, 'codex', 'low')).status, 200);
      assert.deepEqual(config.readAppConfigStrict().agentPreferences.find(entry => entry.scope === filesystemPath.absolute(project)), {
        scope: filesystemPath.absolute(project), agent: 'claude', models: {codex:'writer'}, efforts: {codex:'low',claude:'medium'},
      });
      assert.equal((await save(project, 'codex', null)).status, 200);
      assert.equal((await save(project, 'codex', '')).status, 400);
      assert.equal((await save(project, 'codex', 2)).status, 400);
      assert.equal((await save('/unregistered', 'codex', 'high')).status, 404);
      let saved = (await (await fetch(url)).json()).projects.find(entry => entry.scope === filesystemPath.absolute(project));
      assert.deepEqual(saved.efforts, {codex:null,claude:'medium'});
      assert.equal((await (await fetch(url)).json()).defaultEfforts.codex, null);
      // Every Agent's level survives the next read and write, Antigravity's included.
      assert.equal((await save(project, 'antigravity', 'high')).status, 200);
      assert.equal((await save(project, 'claude', 'medium')).status, 200);
      saved = (await (await fetch(url)).json()).projects.find(entry => entry.scope === filesystemPath.absolute(project));
      assert.deepEqual(saved.efforts, {codex:null,claude:'medium',antigravity:'high'});
      assert.equal(saved.agent, 'claude');
      const chooseModel = (scope, agent, model) => fetch(url, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({scope,agent,model}) });
      assert.equal((await chooseModel(project, 'codex', 'writer')).status, 200);
      assert.equal((await chooseModel(project, 'claude', 'opus')).status, 200);
      assert.equal((await chooseModel(project, 'antigravity', 'gemini')).status, 200);
      assert.equal((await save(project, 'codex', 'high')).status, 200);
      const chosen = (await (await fetch(url)).json()).projects.find(entry => entry.scope === filesystemPath.absolute(project));
      assert.deepEqual(chosen.models, { codex: 'writer', claude: 'opus', antigravity: 'gemini' });
      assert.deepEqual(chosen.efforts, { codex: 'high', claude: 'medium', antigravity: 'high' });
      let defaults = await (await fetch(url)).json();
      assert.deepEqual(defaults.defaultModels, chosen.models);
      assert.deepEqual(defaults.defaultEfforts, chosen.efforts);
      assert.deepEqual(config.readAppConfigStrict().lastSelectedModels, defaults.defaultModels);
      assert.deepEqual(config.readAppConfigStrict().lastSelectedEfforts, defaults.defaultEfforts);
      assert.equal(chosen.agent, 'claude');
      assert.equal((await chooseModel(project, 'codex', null)).status, 200);
      assert.equal(config.readAppConfigStrict().agentPreferences.find(entry => entry.scope === filesystemPath.absolute(project)).models.codex, null);
      assert.equal((await (await fetch(url)).json()).defaultModels.codex, null);
      for (const model of ['', 'x'.repeat(201), 42]) {
        assert.equal((await chooseModel(project, 'codex', model)).status, 400);
      }
      assert.equal((await chooseModel('/unregistered', 'codex', 'writer')).status, 404);
      assert.equal(config.readAppConfigStrict().workspace.showHiddenFiles, true);
      assert.equal((await (await fetch(url)).json()).defaultAgent, 'claude');
      assert.equal((await save(project, 'stashbase')).status, 200);
      assert.equal(config.readAppConfigStrict().lastSelectedAgent, 'stashbase');
      // Editing a different project's model must not replace the explicit Default choice.
      assert.equal((await chooseModel(nested, 'claude', 'opus')).status, 200);
      assert.equal((await (await fetch(url)).json()).defaultAgent, 'stashbase');
      // A later model choice supplies new projects without replacing an explicit
      // native-default reset in this project or another Agent's preferences.
      assert.equal((await chooseModel(nested, 'codex', 'writer')).status, 200);
      defaults = await (await fetch(url)).json();
      assert.equal(defaults.defaultModels.codex, 'writer');
      assert.equal(defaults.projects.find(entry => entry.scope === filesystemPath.absolute(project)).models.codex, null);
      assert.equal(defaults.defaultEfforts.codex, 'high');
      const { removeRecentAsync } = await import('./server/folder.ts');
      await removeRecentAsync(project);
      assert.deepEqual(config.readAppConfigStrict().agentPreferences, [{scope:filesystemPath.absolute(nested),agent:'claude',models:{claude:'opus',codex:'writer'}}]);
      assert.equal((await (await fetch(url)).json()).defaultAgent, 'stashbase');
      assert.deepEqual((await (await fetch(url)).json()).defaultEfforts, { codex: 'high', claude: 'medium', antigravity: 'high' });
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
