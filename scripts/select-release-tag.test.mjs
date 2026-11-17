import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticReleaseTag, isNewerRelease } from './select-release-tag.mjs';
import { parse } from 'yaml';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const candidate = {
  run: { event: 'push', conclusion: 'success', head_branch: 'main',
    head_repository: { full_name: 'liliu-z/stashbase' }, head_sha: 'exact-commit' },
  repository: 'liliu-z/stashbase', version: '3.1.0', previousVersion: '3.0.0',
  subject: 'chore: bump to 3.1.0', sha: 'exact-commit',
};

test('only an explicit version commit with successful exact-commit main CI initiates publication', () => {
  assert.equal(automaticReleaseTag(candidate), 'v3.1.0');
  for (const patch of [
    { subject: 'fix(editor): improve typing' }, { previousVersion: '3.1.0' }, { sha: 'other' },
    ...[{ event: 'pull_request' }, { conclusion: 'failure' }, { conclusion: 'cancelled' },
      { head_branch: 'release/v3.1.0' }, { head_repository: { full_name: 'other/fork' } }]
      .map((patch) => ({ run: { ...candidate.run, ...patch } })),
  ]) assert.equal(automaticReleaseTag({ ...candidate, ...patch }), null);
});

test('repeated or delayed CI completions cannot move the stable channel backwards', () => {
  assert.equal(isNewerRelease('v3.1.0', undefined), true);
  assert.equal(isNewerRelease('v3.10.0', 'v3.9.9'), true);
  assert.equal(isNewerRelease('v4.0.0', 'v3.99.99'), true);
  assert.equal(isNewerRelease('v3.1.0', 'v3.1.0'), false);
  assert.equal(isNewerRelease('v3.1.0', 'v3.1.1'), false);
  assert.equal(isNewerRelease('v3.99.0', 'v4.0.0'), false);
});

test('the automatic CLI creates only the verified tag and refuses to move an existing tag', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tag-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: candidate.version }));
  const eventPath = path.join(tmp, 'event.json');
  const statePath = path.join(tmp, 'state.json');
  const callsPath = path.join(tmp, 'calls.jsonl');
  const outputPath = path.join(tmp, 'outputs');
  fs.writeFileSync(eventPath, JSON.stringify({ workflow_run: candidate.run }));
  const preload = `import cp from 'node:child_process'; import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));
    cp.execFileSync=(command,args)=>{
      fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify([command,args])+'\\n');
      if(command==='git') {
        if(args[0]==='show') return '{"version":"3.0.0"}';
        if(args[0]==='log') return 'chore: bump to 3.1.0';
        if(args[0]==='rev-parse') return 'exact-commit';
      }
      if(command==='gh') {
        if(args[1]==='graphql') return JSON.stringify({data:{repository:{latestRelease:{tagName:state.latest}}}});
        if(args[1]?.includes('matching-refs')) return JSON.stringify(state.refs);
        if(args.includes('POST')) return '{}';
      }
      throw new Error('Unexpected subprocess');
    };syncBuiltinESMExports();`;
  const run = (state) => {
    fs.writeFileSync(statePath, JSON.stringify(state));
    fs.writeFileSync(callsPath, ''); fs.writeFileSync(outputPath, '');
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(new URL('./select-release-tag.mjs', import.meta.url))], {
      cwd: tmp, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_run',
        GITHUB_REPOSITORY: candidate.repository, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
    });
    return { ...result, calls: fs.readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse) };
  };
  const fresh = run({ latest: 'v3.0.0', refs: [] });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'tag=v3.1.0\n');
  assert.ok(fresh.calls.some(([command, args]) => command === 'gh' && args.includes('POST')
    && args.includes('ref=refs/tags/v3.1.0') && args.includes('sha=exact-commit')));
  const conflict = run({ latest: 'v3.0.0', refs: [{ ref: 'refs/tags/v3.1.0', object: { type: 'commit', sha: 'wrong' } }] });
  assert.notEqual(conflict.status, 0);
  assert.ok(conflict.calls.every(([, args]) => !args.includes('POST')));
  const repeated = run({ latest: 'v3.1.0', refs: [] });
  assert.equal(repeated.status, 0);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'tag=\n');
  assert.ok(repeated.calls.every(([, args]) => !args.includes('POST')));
});

test('one successful source workflow precedes the tag gate, components, packaging and publication', () => {
  const read = (name) => parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const ci = read('ci');
  assert.deepEqual(ci.on.push.branches, ['main']);
  const release = read('release');
  assert.deepEqual(release.on.workflow_run, { workflows: ['CI'], types: ['completed'], branches: ['main'] });
  assert.equal(release.jobs['release-ci-gate'].needs, 'select-tag');
  assert.deepEqual(release.jobs['prepare-draft'].needs, ['select-tag', 'release-ci-gate']);
  assert.equal(release.jobs.extractor.needs, 'prepare-draft');
  for (const platform of ['macos', 'linux', 'windows']) {
    assert.deepEqual(release.jobs[platform].needs, ['prepare-draft', 'extractor']);
    assert.equal(read(`release-${platform}`).on.workflow_dispatch, undefined);
  }
  assert.equal(ci.jobs['source-build'].steps.find((s) => s.run === 'pnpm test:opencode:native')['timeout-minutes'], 5);
  assert.ok(ci.jobs['source-build']['timeout-minutes'] <= 45);
});
