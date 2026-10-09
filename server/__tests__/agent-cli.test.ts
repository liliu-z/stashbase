import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  agentCliExecutableCandidates,
  agentCliVersion,
  isWindowsLaunchableAgentCliPath,
  parseAgentCliVersion,
  resolveAgentCli,
  resolveNativeAgentCli,
} from '../agent-cli.ts';

test('native installations win over npm copies, while explicit executable overrides still win', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-cli-choice-'));
  t.mock.method(os, 'homedir', () => root);
  const previous = process.env.STASHBASE_TEST_AGENT_BIN;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'AppData', 'Local');
  try {
    for (const name of ['claude', 'codex']) {
      const file = process.platform === 'win32' ? `${name}.exe` : name;
      const native = path.join(root, '.local', 'bin', file);
      const npm = path.join(root, '.npm-global', 'bin', file);
      for (const candidate of [native, npm]) {
        fs.mkdirSync(path.dirname(candidate), { recursive: true });
        fs.writeFileSync(candidate, 'fixture', { mode: 0o755 });
      }
      const spec = { name, envNames: ['STASHBASE_TEST_AGENT_BIN'], logLabel: name };
      delete process.env.STASHBASE_TEST_AGENT_BIN;
      assert.equal(resolveAgentCli(spec), native, 'the native copy must be selected for new sessions');
      process.env.STASHBASE_TEST_AGENT_BIN = npm;
      assert.equal(resolveAgentCli(spec), npm, 'an explicit executable choice must stay authoritative');
      assert.equal(fs.readFileSync(npm, 'utf8'), 'fixture', 'discovery must preserve the npm copy');
    }
  } finally {
    if (previous === undefined) delete process.env.STASHBASE_TEST_AGENT_BIN;
    else process.env.STASHBASE_TEST_AGENT_BIN = previous;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a leftover npm shim in the native bin directory cannot satisfy native install verification', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-cli-shim-'));
  t.mock.method(os, 'homedir', () => root);
  const bin = path.join(root, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nnode "$basedir/../node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n', { mode: 0o755 });
  try {
    assert.equal(resolveNativeAgentCli('claude'), null);
    assert.equal(fs.existsSync(bin), true, 'the npm shim remains untouched');
    fs.rmSync(bin);
    fs.mkdirSync(bin);
    assert.equal(resolveNativeAgentCli('claude'), null, 'an executable directory is not a launcher');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows agent CLI discovery prefers launchable shims over extensionless npm files', () => {
  assert.deepEqual(agentCliExecutableCandidates('codex', 'win32'), [
    'codex.exe',
    'codex.cmd',
    'codex.bat',
    'codex.com',
    'codex',
  ]);
  assert.equal(isWindowsLaunchableAgentCliPath('C:\\Users\\Alice\\AppData\\Roaming\\npm\\codex'), false);
  assert.equal(isWindowsLaunchableAgentCliPath('C:\\Users\\Alice\\AppData\\Roaming\\npm\\codex.cmd'), true);
});

test('non-Windows agent CLI discovery keeps bare command lookup', () => {
  assert.deepEqual(agentCliExecutableCandidates('codex', 'darwin'), ['codex']);
});

test('agent CLI version parsing reads the release number out of either provider format', () => {
  assert.equal(parseAgentCliVersion('2.1.220 (Claude Code)'), '2.1.220');
  assert.equal(parseAgentCliVersion('codex-cli 0.104.0\n'), '0.104.0');
  assert.equal(parseAgentCliVersion('Claude Code'), null);
});

test('version checks are asynchronous and coalesce concurrent readers', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-slow-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, '#!/bin/sh\nsleep 0.2\necho "2.1.300 (Claude Code)"\n', { mode: 0o755 });
  let settled = false;
  const version = agentCliVersion(file).then((value) => { settled = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, 'the shared server remains responsive during --version');
  assert.equal(await version, '2.1.300');
});

test('agent CLI version is read once per executable change and never for a missing file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-cli-version-'));
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, '#!/bin/sh\n');
  let reads = 0;
  const read = () => `2.1.${++reads}`;
  try {
    assert.deepEqual(await Promise.all([agentCliVersion(file, read), agentCliVersion(file, read)]), ['2.1.1', '2.1.1']);
    assert.equal(await agentCliVersion(file, read), '2.1.1', 'the listing is polled; the executable is not re-run');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    assert.equal(await agentCliVersion(file, read), '2.1.2', 'an updater replacing the file in place is seen');
    assert.equal(await agentCliVersion(path.join(dir, 'missing'), read), null);
    assert.equal(reads, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
