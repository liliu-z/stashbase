import './isolated-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { ensureAgentMcp } from '../agent-mcp.ts';
import { resolveAgentCli, resolveAgentCliWithLoginShell } from '../agent-cli.ts';
import { ownAgentProcess, retireAgentProcess, closeAgentProcesses } from '../agent-process.ts';

test('MCP preparation uses each CLI custom config home without changing default configs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-custom-agent-home-'));
  const keys = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const;
  const previous = keys.map((key) => process.env[key]);
  t.after(() => {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [id, key, file] of [['codex', 'CODEX_HOME', 'config.toml'], ['claude', 'CLAUDE_CONFIG_DIR', '.claude.json']] as const) {
    const home = path.join(root, id);
    fs.mkdirSync(home);
    process.env[key] = home;
    const config = path.join(home, file);
    fs.writeFileSync(config, id === 'codex' ? 'model = "kept"\n' : '{"theme":"kept"}');
    const defaultConfig = id === 'codex' ? path.join(os.homedir(), '.codex', 'config.toml') : path.join(os.homedir(), '.claude.json');
    const before = fs.existsSync(defaultConfig) ? fs.readFileSync(defaultConfig, 'utf8') : null;
    ensureAgentMcp(id);
    assert.match(fs.readFileSync(config, 'utf8'), /stashbase/);
    assert.match(fs.readFileSync(config, 'utf8'), /kept/);
    assert.equal(fs.existsSync(defaultConfig) ? fs.readFileSync(defaultConfig, 'utf8') : null, before);
  }
});

test('MCP setup preserves unrelated commented/quoted tables and multiline text, and refuses invalid config', () => {
  const config = path.join(os.homedir(), '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const unrelated = `[mcp_servers."other"] # keep this server\ncommand = "other-server"\nnote = '''\n[mcp_servers.stashbase]\nnot a table\n'''\n`;
  fs.writeFileSync(config, `[mcp_servers."stashbase"] # our old entry\ncommand = "old"\n\n${unrelated}`);
  ensureAgentMcp('codex');
  const updated = fs.readFileSync(config, 'utf8');
  assert.ok(updated.includes(unrelated));
  assert.ok(!updated.includes('command = "old"'));
  ensureAgentMcp('codex');
  assert.equal(fs.readFileSync(config, 'utf8'), updated, 'unchanged setup must not rewrite the file');
  const malformed = '[mcp_servers.stashbase\ncommand = "keep"';
  fs.writeFileSync(config, malformed);
  assert.throws(() => ensureAgentMcp('codex'), /leaving it untouched/);
  assert.equal(fs.readFileSync(config, 'utf8'), malformed);
  fs.rmSync(config);
});

test('Claude MCP setup keeps the user\'s other settings and asks for StashBase tools to stay loaded', () => {
  const config = path.join(os.homedir(), '.claude.json');
  fs.writeFileSync(config, JSON.stringify({
    theme: 'dark',
    mcpServers: { other: { command: 'other-server' }, stashbase: { command: 'old' } },
  }));
  ensureAgentMcp('claude');
  const updated = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(updated.theme, 'dark');
  assert.deepEqual(updated.mcpServers.other, { command: 'other-server' });
  assert.equal(updated.mcpServers.stashbase.alwaysLoad, true);
  assert.notEqual(updated.mcpServers.stashbase.command, 'old');
  const malformed = '{ "mcpServers": ';
  fs.writeFileSync(config, malformed);
  assert.throws(() => ensureAgentMcp('claude'), /leaving it untouched/);
  assert.equal(fs.readFileSync(config, 'utf8'), malformed);
  fs.rmSync(config);
});

test('valid login-shell discoveries survive elapsed time and disappear only when their file disappears', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-cli-cache-'));
  const shell = path.join(root, 'shell');
  const binary = path.join(root, 'custom-agent');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(shell, `#!/bin/sh\nprintf '%s\\n' '${binary}'\n`, { mode: 0o755 });
  const previous = process.env.SHELL;
  t.after(() => { if (previous === undefined) delete process.env.SHELL; else process.env.SHELL = previous; fs.rmSync(root, { recursive: true, force: true }); });
  process.env.SHELL = shell;
  const spec = { name: `stashbase-cache-${process.pid}`, envNames: [], logLabel: 'Fixture' };
  assert.equal(await resolveAgentCliWithLoginShell(spec), binary);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 301_000);
  assert.equal(resolveAgentCli(spec), binary);
  fs.rmSync(binary);
  assert.equal(resolveAgentCli(spec), null);
});

for (const leaderExits of [false, true]) test(`native retirement closes descendants when leader ${leaderExits ? 'crashes first' : 'receives termination'}`,  { skip: process.platform === 'win32' }, async () => {
  const leaf = `process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000);`;
  const parent = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>{console.log(child.pid);${leaderExits ? 'process.exit(1);' : ''}});setInterval(()=>{},1000);`;
  const child = ownAgentProcess(spawn(process.execPath, ['-e', parent], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
  try {
    if (leaderExits) await new Promise<void>((resolve) => child.once('close', () => resolve()));
    const retirement = retireAgentProcess(child);
    assert.equal(retireAgentProcess(child), retirement);
    await retirement;
    assert.throws(() => process.kill(-child.pid!, 0), { code: 'ESRCH' });
    await closeAgentProcesses();
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already reaped */ }
  }
});
