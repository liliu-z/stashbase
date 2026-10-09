import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { agentCliSearchDirs, resolveAgentCli, resolveAgentCliWithLoginShell } from '../agent-cli.ts';
import {
  AgentBootstrapCoordinator,
  agentIsAuthenticated,
  agentPowerShellInstallerScript,
  CLAUDE_PS1_BOOTSTRAP,
  CODEX_PS1_BOOTSTRAP,
  installClaude,
  installCodex,
  loginToAgent,
  resolveClaudeInstallerShell,
  resolveCodexInstallerShell,
  verifyAgentExecutable,
  windowsUserPathRepairScript,
  agentBootstrapCoordinator,
  agentSupportsInAppUpdate,
  updateAgentBootstrap,
  type AgentBootstrapDependencies,
} from '../agent-runtime-installer.ts';
import {
  consumeAgentSetupFailure,
  consumeAgentTurnFailure,
  getAgentRuntimeDebugState,
  agentInstallerTempRoot,
  setAgentRuntimeDebugState,
  simulatedTurnFailureScript,
  type AgentTurnFailureSimulation,
} from '../agent-runtime-paths.ts';

function fakeDependencies(overrides: Partial<AgentBootstrapDependencies> = {}) {
  let installed = false;
  let authenticated = true;
  let configured = 0;
  const dependencies: AgentBootstrapDependencies = {
    resolveExecutable: () => installed ? '/managed/codex' : null,
    resolveNativeExecutable: () => installed ? '/managed/codex' : null,
    installRuntime: async (_id, update) => {
      update({ progress: 0.5, message: 'Downloading… 50%' });
      await Promise.resolve();
      installed = true;
    },
    isAuthenticated: () => authenticated,
    login: async () => { authenticated = true; },
    configureMcp: () => { configured += 1; },
    consumeFailure: () => false,
    ...overrides,
  };
  return {
    dependencies,
    configured: () => configured,
  };
}

async function prepare(coordinator: AgentBootstrapCoordinator, id: 'codex' | 'claude') {
  coordinator.begin(id);
  return coordinator.wait(id);
}

async function connect(coordinator: AgentBootstrapCoordinator, id: 'codex' | 'claude', options?: { probeLoginShell?: boolean }) {
  coordinator.connectIfInstalled(id, options);
  return coordinator.wait(id);
}

test('a concurrent Update cannot be acknowledged by an unrelated login', async () => {
  let complete!: () => void;
  let installs = 0;
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/old/codex',
    resolveNativeExecutable: () => '/old/codex',
    login: () => new Promise<void>((resolve) => { complete = resolve; }),
    installRuntime: async () => { installs++; },
  }).dependencies);
  coordinator.login('codex');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.throws(() => coordinator.update('codex'), /already.*signing in/i);
  complete();
  await coordinator.wait('codex');
  coordinator.update('codex');
  assert.equal((await coordinator.wait('codex')).phase, 'ready');
  assert.equal(installs, 1);
});

test('a timed out installer is retired before Retry starts a new installation', async () => {
  let installs = 0;
  let retired = false;
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/native/claude',
    resolveNativeExecutable: () => '/native/claude',
    installRuntime: async (_id, _update, signal) => {
      if (++installs > 1) { assert.equal(retired, true); return; }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      retired = true;
      signal.throwIfAborted();
    },
  }).dependencies, { installationTimeoutMs: 20 });
  coordinator.update('claude');
  const failed = await coordinator.wait('claude');
  assert.match(failed.failure?.message ?? '', /timed out/i);
  assert.equal(failed.failure?.retryAction, 'update');
  coordinator.update('claude');
  assert.equal((await coordinator.wait('claude')).phase, 'ready');
  assert.equal(installs, 2);
});

test('Claude sign-in checks and browser login use the selected CLI and keep readiness gated',
  { skip: process.platform === 'win32' }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-auth-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const executable = path.join(root, 'claude');
    fs.writeFileSync(executable, `#!/bin/sh
if [ "$1 $2" = 'auth status' ]; then
  if [ -f '${root}/signed-in' ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; exit 1; fi
elif [ "$1 $2" = 'auth login' ]; then touch '${root}/signed-in'
else exit 42; fi
`, { mode: 0o755 });
    const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
      resolveExecutable: () => executable,
      isAuthenticated: agentIsAuthenticated,
      login: loginToAgent,
    }).dependencies);
    assert.equal((await prepare(coordinator, 'claude')).failure?.code, 'authentication-required');
    coordinator.login('claude');
    assert.equal((await coordinator.wait('claude')).phase, 'ready');
  });

test('installer failures retain stdout and network cause diagnostics', { skip: process.platform === 'win32' }, async (t) => {
  for (const install of [installClaude, installCodex]) {
    t.mock.method(globalThis, 'fetch', async () => new Response("echo 'EACCES: cannot write native launcher'\nexit 13\n"));
    await assert.rejects(install(() => {}, new AbortController().signal), /EACCES.*native launcher/);
    t.mock.restoreAll();
    t.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' }) });
    });
    await assert.rejects(install(() => {}, new AbortController().signal), /Download.*(?:claude.ai|chatgpt.com).*ENOTFOUND/s);
    t.mock.restoreAll();
  }
});

test('the production installer process is killed on deadline before Retry', { skip: process.platform === 'win32' }, async (t) => {
  let attempts = 0;
  let pid = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(++attempts === 1
    ? 'echo $$\nwhile :; do sleep 1; done\n' : 'exit 0\n'));
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/native/codex',
    resolveNativeExecutable: () => '/native/codex',
    installRuntime: (_id, update, signal) => installCodex((next) => {
      if (/^\d+$/.test(next.message ?? '')) pid = Number(next.message);
      update(next);
    }, signal, { resolveInstalledExecutable: () => '/native/codex', verifyExecutable: () => {} }),
  }).dependencies, { installationTimeoutMs: 250 });
  coordinator.update('codex');
  assert.match((await coordinator.wait('codex')).failure?.message ?? '', /timed out/);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
  coordinator.update('codex');
  assert.equal((await coordinator.wait('codex')).phase, 'ready');
  assert.equal(attempts, 2);
});

test('missing runtime moves through install and MCP configuration to ready', async () => {
  const fake = fakeDependencies();
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  assert.equal(coordinator.begin('codex').phase, 'configuring');
  const settled = await coordinator.wait('codex');

  assert.equal(settled.phase, 'ready');
  assert.equal(settled.progress, 1);
  assert.equal(fake.configured(), 1);
});

test('existing runtime skips download but still ensures MCP configuration', async () => {
  let installs = 0;
  let configured = 0;
  const fake = fakeDependencies({
    resolveExecutable: () => '/system/claude',
    installRuntime: async () => { installs += 1; },
    configureMcp: () => { configured += 1; },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  assert.equal((await prepare(coordinator, 'claude')).phase, 'ready');
  assert.equal(installs, 0);
  assert.equal(configured, 1);
});

test('Update installs the native runtime over an npm or native selection and reconnects using that copy', async () => {
  for (const id of ['claude', 'codex'] as const) {
    for (const source of ['npm', 'native']) {
      let executable = `/${source}/${id}`;
      let installs = 0;
      let configured = 0;
      const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
        resolveExecutable: () => executable,
        resolveNativeExecutable: () => executable.startsWith('/native/') ? executable : null,
        installRuntime: async (installedId) => {
          assert.equal(installedId, id);
          installs++;
          executable = `/native/${id}`;
        },
        isAuthenticated: (_id, selected) => { assert.equal(selected, `/native/${id}`); return true; },
        configureMcp: () => { configured++; },
      }).dependencies);
      coordinator.update(id);
      assert.equal((await coordinator.wait(id)).phase, 'ready');
      assert.equal(installs, 1);
      assert.equal(configured, 1);
    }
  }
});

test('a failed native update retries installation instead of silently reconnecting the old runtime', async () => {
  let installs = 0;
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/npm/claude',
    installRuntime: async () => { installs++; throw new Error('Download failed'); },
  }).dependencies);
  for (let attempt = 1; attempt <= 2; attempt++) {
    coordinator.update('claude');
    const status = await coordinator.wait('claude');
    assert.equal(status.failure?.retryAction, 'update');
    assert.match(status.failure?.message ?? '', /Download failed/);
    assert.equal(installs, attempt);
  }
});

test('retrying a failed first install reruns verification even when a partial executable remains', async () => {
  let executable: string | null = null;
  let installs = 0;
  let configured = 0;
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => executable,
    resolveNativeExecutable: () => executable,
    installRuntime: async () => {
      executable = '/native/claude';
      if (++installs === 1) throw new Error('Downloaded executable did not pass verification');
    },
    configureMcp: () => { configured++; },
  }).dependencies);
  coordinator.begin('claude');
  assert.equal((await coordinator.wait('claude')).failure?.retryAction, 'bootstrap');
  assert.equal(configured, 0);
  coordinator.begin('claude');
  assert.equal((await coordinator.wait('claude')).phase, 'ready');
  assert.equal(installs, 2);
  assert.equal(configured, 1);
});

test('native installation cannot report success while discovery still selects the npm copy', async () => {
  let configured = 0;
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/npm/claude',
    resolveNativeExecutable: () => '/native/claude',
    installRuntime: async () => {},
    configureMcp: () => { configured++; },
  }).dependencies);
  coordinator.update('claude');
  const status = await coordinator.wait('claude');
  assert.equal(status.phase, 'failed');
  assert.equal(status.failure?.stage, 'installation');
  assert.equal(status.failure?.retryAction, 'update');
  assert.equal(configured, 0);
});

test('native update cancellation keeps the old runtime and prevents MCP configuration', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let configured = false;
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/npm/claude',
    installRuntime: async (_id, _update, signal) => {
      entered();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
    configureMcp: () => { configured = true; },
  }).dependencies);
  coordinator.update('claude');
  await started;
  assert.deepEqual(await coordinator.cancelAll(), ['claude']);
  assert.equal(coordinator.status('claude').phase, 'failed');
  assert.equal(configured, false);
});

test('the production update path runs official installer scripts, selects native output, and preserves npm copies',
  { skip: process.platform === 'win32' }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-native-update-'));
    t.mock.method(os, 'homedir', () => root);
    const keys = ['HOME', 'STASHBASE_LOCAL_DATA_ROOT', 'STASHBASE_CLAUDE_BIN', 'CLAUDE_CODE_BIN',
      'STASHBASE_CODEX_BIN', 'CODEX_CLI_BIN', 'CODEX_CLI_PATH'];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.HOME = root;
    process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(root, 'app-data');
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      requests.push(url);
      const id = url === 'https://claude.ai/install.sh' ? 'claude' : 'codex';
      return new Response(`#!/bin/sh
set -eu
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/${id}" <<'CLI'
#!/bin/sh
echo '9.9.9'
CLI
chmod +x "$HOME/.local/bin/${id}"
`);
    });
    try {
      for (const id of ['claude', 'codex'] as const) {
        const old = path.join(root, '.npm-global', 'bin', id);
        fs.mkdirSync(path.dirname(old), { recursive: true });
        const original = '#!/bin/sh\necho "npm copy must not run during update" >&2\nexit 71\n';
        fs.writeFileSync(old, original, { mode: 0o755 });
        updateAgentBootstrap(id);
        const status = await agentBootstrapCoordinator.wait(id);
        assert.equal(status.phase, 'ready', JSON.stringify(status));
        assert.equal(resolveAgentCli({ name: id, envNames: [], logLabel: id }), path.join(root, '.local/bin', id));
        assert.equal(fs.readFileSync(old, 'utf8'), original);
      }
      assert.deepEqual(requests, ['https://claude.ai/install.sh', 'https://chatgpt.com/codex/install.sh']);
      assert.match(fs.readFileSync(path.join(root, '.claude.json'), 'utf8'), /stashbase/);
      assert.match(fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8'), /stashbase/);
      process.env.STASHBASE_CLAUDE_BIN = path.join(root, '.npm-global/bin/claude');
      assert.equal(agentSupportsInAppUpdate('claude'), false);
      assert.throws(() => updateAgentBootstrap('claude'), /executable override/);
      assert.equal(requests.length, 2, 'an explicit override is not silently bypassed by another installation');
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test('installed Codex stops at a distinct authentication failure before MCP configuration', async () => {
  let configured = 0;
  const fake = fakeDependencies({
    resolveExecutable: () => '/managed/codex',
    isAuthenticated: () => false,
    configureMcp: () => { configured += 1; },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  const status = await prepare(coordinator, 'codex');

  assert.equal(status.phase, 'failed');
  assert.equal(status.failure?.stage, 'authentication');
  assert.equal(status.failure?.code, 'authentication-required');
  assert.equal(status.failure?.manualRecovery, undefined);
  assert.match(status.failure?.message ?? '', /installed.*not signed in/i);
  assert.equal(configured, 0);
});

test('Codex browser login uses the discovered executable and resumes MCP preparation', async () => {
  let authenticated = false;
  let configured = 0;
  let loginExecutable = '';
  let completeLogin!: () => void;
  const fake = fakeDependencies({
    resolveExecutable: () => '/managed/codex',
    isAuthenticated: () => authenticated,
    login: async (_id, executable) => {
      loginExecutable = executable;
      await new Promise<void>((resolve) => { completeLogin = resolve; });
      authenticated = true;
    },
    configureMcp: () => { configured += 1; },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);
  assert.equal((await prepare(coordinator, 'codex')).failure?.stage, 'authentication');

  assert.equal(coordinator.login('codex').phase, 'authenticating');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(loginExecutable, '/managed/codex');
  completeLogin();
  const settled = await coordinator.wait('codex');

  assert.equal(settled.phase, 'ready');
  assert.equal(configured, 1);
});

test('Codex authentication commands use the selected executable', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-auth-test-'));
  const executable = path.join(root, 'codex');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1 $2" = "login status" ]; then echo "Not logged in" >&2; exit 1; fi',
    'if [ "$1" = "login" ]; then exit 0; fi',
    'exit 9',
    '',
  ].join('\n'));
  fs.chmodSync(executable, 0o755);
  try {
    assert.equal(await agentIsAuthenticated('codex', executable), false);
    await loginToAgent('codex', executable, new AbortController().signal);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup connects MCP for discovered runtimes without installing missing ones', async () => {
  let installed = true;
  let installs = 0;
  let configured = 0;
  const fake = fakeDependencies({
    resolveExecutable: () => installed ? '/system/codex' : null,
    installRuntime: async () => { installs += 1; },
    configureMcp: () => { configured += 1; },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  assert.equal((await connect(coordinator, 'codex')).phase, 'ready');
  installed = false;
  assert.equal((await connect(coordinator, 'claude')).phase, 'idle');
  assert.equal(installs, 0);
  assert.equal(configured, 1);
});

test('recheck recovers a failed setup from an externally installed runtime without downloading', async () => {
  let externallyInstalled = false;
  let installs = 0;
  let configured = 0;
  const fake = fakeDependencies({
    resolveExecutable: () => externallyInstalled ? '/system/codex' : null,
    installRuntime: async () => {
      installs += 1;
      throw new Error('download failed');
    },
    configureMcp: () => { configured += 1; },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  assert.equal(coordinator.begin('codex').phase, 'configuring');
  assert.equal((await coordinator.wait('codex')).phase, 'failed');
  externallyInstalled = true;

  const checked = await connect(coordinator, 'codex', { probeLoginShell: true });

  assert.equal(checked.phase, 'ready');
  assert.equal(installs, 1);
  assert.equal(configured, 1);
});

test('startup MCP repair does not consume the next explicit setup failure', async () => {
  let nextFailure: 'mcp' | null = 'mcp';
  let configured = 0;
  const fake = fakeDependencies({
    resolveExecutable: () => '/system/codex',
    configureMcp: () => { configured += 1; },
    consumeFailure: (stage) => {
      if (nextFailure !== stage) return false;
      nextFailure = null;
      return true;
    },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  assert.equal((await connect(coordinator, 'codex')).phase, 'ready');
  assert.equal(configured, 1);
  assert.equal(nextFailure, 'mcp');
  assert.equal((await prepare(coordinator, 'codex')).failure?.stage, 'mcp');
  assert.equal(nextFailure, null);
  assert.equal(configured, 1);
});

test('an injected installation failure is classified and consumed before retry', async () => {
  let nextFailure: 'installation' | 'mcp' | null = 'installation';
  const fake = fakeDependencies({
    consumeFailure: (stage) => {
      if (nextFailure !== stage) return false;
      nextFailure = null;
      return true;
    },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);
  const settled = await prepare(coordinator, 'codex');
  assert.equal(settled.phase, 'failed');
  assert.equal(settled.failure?.stage, 'installation');
  assert.equal(settled.failure?.code, 'simulated');
  assert.equal(settled.failure?.manualRecovery, undefined);
  assert.match(settled.failure?.message ?? '', /Simulated Agent installation failure/);

  assert.equal(coordinator.begin('codex').phase, 'configuring');
  assert.equal((await coordinator.wait('codex')).phase, 'ready');
});

test('an injected MCP failure retries only MCP when the runtime exists', async () => {
  let nextFailure: 'installation' | 'mcp' | null = 'mcp';
  let installs = 0;
  let configured = 0;
  const fake = fakeDependencies({
    resolveExecutable: () => '/system/codex',
    installRuntime: async () => { installs += 1; },
    configureMcp: () => { configured += 1; },
    consumeFailure: (stage) => {
      if (nextFailure !== stage) return false;
      nextFailure = null;
      return true;
    },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  const failed = await prepare(coordinator, 'codex');
  assert.equal(failed.failure?.stage, 'mcp');
  assert.equal(failed.failure?.code, 'simulated');
  assert.equal(failed.failure?.manualRecovery, undefined);
  assert.equal(installs, 0);
  assert.equal(configured, 0);

  assert.equal((await prepare(coordinator, 'codex')).phase, 'ready');
  assert.equal(installs, 0);
  assert.equal(configured, 1);
});

test('an injected signed-out simulation stops Codex at the sign-in gate once', async () => {
  let nextFailure: 'authentication' | null = 'authentication';
  let configured = 0;
  const fake = fakeDependencies({
    resolveExecutable: () => '/system/codex',
    configureMcp: () => { configured += 1; },
    consumeFailure: (stage) => {
      if (nextFailure !== stage) return false;
      nextFailure = null;
      return true;
    },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  const failed = await prepare(coordinator, 'codex');
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.failure?.stage, 'authentication');
  assert.equal(failed.failure?.code, 'authentication-required');
  assert.match(failed.failure?.message ?? '', /Simulated signed-out/);
  assert.equal(configured, 0);

  assert.equal((await prepare(coordinator, 'codex')).phase, 'ready');
  assert.equal(configured, 1);
});

test('the signed-out simulation never arms Claude and is not consumed by login verification', async () => {
  let consumed = 0;
  const claude = fakeDependencies({
    resolveExecutable: () => '/system/claude',
    consumeFailure: (stage) => {
      if (stage !== 'authentication') return false;
      consumed += 1;
      return true;
    },
  });
  assert.equal((await prepare(new AgentBootstrapCoordinator(claude.dependencies), 'claude')).phase, 'ready');
  assert.equal(consumed, 0);

  // A completed Codex login verifies for real instead of consuming the gate
  // simulation, so signing in cannot appear to fail because of a stale toggle.
  const codex = fakeDependencies({
    resolveExecutable: () => '/system/codex',
    consumeFailure: (stage) => {
      if (stage !== 'authentication') return false;
      consumed += 1;
      return true;
    },
  });
  const coordinator = new AgentBootstrapCoordinator(codex.dependencies);
  assert.equal(coordinator.login('codex').phase, 'authenticating');
  assert.equal((await coordinator.wait('codex')).phase, 'ready');
  assert.equal(consumed, 0);
});

test('real installation and MCP errors advertise only their relevant manual recovery', async () => {
  const installFailure = new AgentBootstrapCoordinator(fakeDependencies({
    installRuntime: async () => { throw new Error('download unavailable'); },
  }).dependencies);
  assert.equal(installFailure.begin('codex').phase, 'configuring');
  const failedInstall = await installFailure.wait('codex');
  assert.equal(failedInstall.failure?.stage, 'installation');
  assert.equal(failedInstall.failure?.manualRecovery, 'install-command');

  const mcpFailure = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/system/codex',
    configureMcp: () => { throw new Error('config is read-only'); },
  }).dependencies);
  const failedMcp = await prepare(mcpFailure, 'codex');
  assert.equal(failedMcp.failure?.stage, 'mcp');
  assert.equal(failedMcp.failure?.manualRecovery, 'mcp-settings');
});

test('Claude installer shell is bash on POSIX and shares the Codex PowerShell selection', () => {
  const posix = resolveClaudeInstallerShell('darwin', {}, () => false);
  assert.deepEqual(posix, { command: '/bin/bash', args: [], kind: 'posix' });
  const windows = resolveClaudeInstallerShell('win32', { SystemRoot: 'C:\\Windows' }, () => false);
  assert.equal(windows.kind, 'windows-powershell');
});

test('Claude install runs the official installer and verifies the discovered executable', async () => {
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-official-test-'));
  process.env.STASHBASE_LOCAL_DATA_ROOT = root;
  const installed = path.join(root, 'local-bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  const fixture = process.platform === 'win32'
    ? [
      '$null = [System.IO.Directory]::CreateDirectory((Split-Path -Parent ' + `'${installed.replaceAll("'", "''")}'))`,
      `Set-Content -LiteralPath '${installed.replaceAll("'", "''")}' -Value 'installed Claude'`,
      'Write-Output "Setting up Claude..."',
      '',
    ].join('\n')
    : `#!/bin/bash
set -eu
[[ -z "\${ELECTRON_RUN_AS_NODE:-}" ]]
mkdir -p "${path.dirname(installed)}"
: > "${installed}"
chmod +x "${installed}"
echo "Setting up Claude..."
`;
  mock.method(globalThis, 'fetch', async () => new Response(fixture));
  let verified = false;
  const updates: string[] = [];
  try {
    await installClaude((update) => {
      if (update.message) updates.push(update.message);
    }, new AbortController().signal, {
      resolveInstalledExecutable: () => (fs.existsSync(installed) ? installed : null),
      verifyExecutable: (executable, label) => {
        verified = true;
        assert.equal(executable, installed);
        assert.equal(label, 'Claude');
      },
    });
    assert.equal(verified, true);
    assert.ok(updates.some((message) => /Setting up Claude/.test(message)));
    assert.equal(updates.at(-1), 'Claude installed.');
  } finally {
    mock.restoreAll();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude install reports a missing executable without a fabricated ENOENT', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('#!/bin/bash\ntrue\n'));
  let verified = false;
  try {
    await assert.rejects(
      installClaude(() => {}, new AbortController().signal, {
        runInstallerScript: async () => {},
        resolveInstalledExecutable: () => null,
        verifyExecutable: () => { verified = true; },
      }),
      (error) => {
        assert.match(String(error), /exited successfully but no 'claude' executable.*standard install locations/i);
        assert.doesNotMatch(String(error), /ENOENT/);
        return true;
      },
    );
    assert.equal(verified, false);
  } finally {
    mock.restoreAll();
  }
});

test('the Windows user-Path repair is additive, raw-form-preserving, and setx-free', () => {
  const script = windowsUserPathRepairScript();
  // Reads the raw value so %VAR% entries elsewhere in Path are never expanded
  // in place, and writes back as REG_EXPAND_SZ.
  assert.ok(script.includes("'DoNotExpandEnvironmentNames'"));
  assert.ok(script.includes('-Type ExpandString'));
  // Appends the raw entry only when no existing entry expands to the same
  // directory; never rewrites or removes entries, never truncates via setx.
  assert.ok(script.includes("$entry = '%USERPROFILE%\\.local\\bin'"));
  assert.ok(script.includes('if (-not $has)'));
  assert.ok(script.includes("$raw.TrimEnd(';') + ';' + $entry"));
  assert.doesNotMatch(script, /setx/i);
  // Broadcasts WM_SETTINGCHANGE so shells opened from Explorer see it.
  assert.ok(script.includes('SendMessageTimeout'));
  assert.ok(script.includes('"Environment"'));
});

test('Claude verifier failures surface as the installation failure', async () => {
  const verifierFailure = new Error('Claude verifier timed out after 20 seconds.');
  mock.method(globalThis, 'fetch', async () => new Response('#!/bin/bash\ntrue\n'));
  try {
    await assert.rejects(
      installClaude(() => {}, new AbortController().signal, {
        runInstallerScript: async () => {},
        resolveInstalledExecutable: () => '/fake/claude',
        verifyExecutable: () => { throw verifierFailure; },
      }),
      (error) => {
        assert.equal(error, verifierFailure);
        return true;
      },
    );
  } finally {
    mock.restoreAll();
  }
});

test('Agent executable verification reports the native exit code and stderr', {
  skip: process.platform === 'win32',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agent-verifier-test-'));
  const executable = path.join(root, 'agent');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "blocked by policy\\n" >&2\nexit 23\n');
  fs.chmodSync(executable, 0o755);
  try {
    await assert.rejects(
      () => verifyAgentExecutable(executable, 'Claude'),
      /Claude.*exited with code 23.*blocked by policy/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent executable verification identifies a timeout', {
  skip: process.platform === 'win32',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agent-verifier-timeout-test-'));
  const executable = path.join(root, 'agent');
  fs.writeFileSync(executable, '#!/bin/sh\nwhile :; do :; done\n');
  fs.chmodSync(executable, 0o755);
  try {
    await assert.rejects(
      () => verifyAgentExecutable(executable, 'Claude', process.env, 25),
      /Claude.*timed out after 25ms/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows Codex installation prefers PowerShell 7 from PATH', () => {
  const pwsh = 'C:\\Tools\\PowerShell\\pwsh.exe';
  const shell = resolveCodexInstallerShell(
    'win32',
    { Path: 'C:\\Windows\\System32;C:\\Tools\\PowerShell' },
    (candidate) => candidate === pwsh,
  );

  assert.equal(shell.command, pwsh);
  assert.equal(shell.kind, 'powershell-7');
});

test('Windows Codex installation finds standard PowerShell 7 when the app PATH is stale', () => {
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const shell = resolveCodexInstallerShell(
    'win32',
    { ProgramFiles: 'C:\\Program Files', Path: 'C:\\Windows\\System32' },
    (candidate) => candidate === pwsh,
  );

  assert.equal(shell.command, pwsh);
  assert.equal(shell.kind, 'powershell-7');
});

test('Windows Agent discovery includes the official Codex standalone bin when PATH is stale', () => {
  const localAppData = 'C:\\Users\\bingwu\\AppData\\Local';
  const dirs = agentCliSearchDirs(
    'win32',
    { LOCALAPPDATA: localAppData, APPDATA: 'C:\\Users\\bingwu\\AppData\\Roaming' },
    'C:\\Users\\bingwu',
  );

  assert.ok(dirs.includes(path.win32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin')));
});

test('Windows Codex installation falls back to Windows PowerShell only when pwsh is unavailable', () => {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const shell = resolveCodexInstallerShell(
    'win32',
    { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32' },
    (candidate) => candidate === powershell,
  );

  assert.equal(shell.command, powershell);
  assert.equal(shell.kind, 'windows-powershell');
});

test('PowerShell bootstrap strips redirecting environment and never pins install paths', () => {
  const officialScript = '[CmdletBinding()]\nparam(\n  [string]$Release\n)\nWrite-Host "official installer"\n';
  const installer = agentPowerShellInstallerScript(officialScript, CODEX_PS1_BOOTSTRAP);

  assert.ok(installer.startsWith('[CmdletBinding()]\nparam(\n  [string]$Release\n)\n'));
  // The official installer owns its layout: stale pinning from older
  // StashBase versions is REMOVED, never assigned.
  assert.ok(installer.includes('Remove-Item Env:\\CODEX_INSTALL_DIR'));
  assert.ok(installer.includes('Remove-Item Env:\\CODEX_HOME'));
  assert.doesNotMatch(installer, /\$env:CODEX_INSTALL_DIR\s*=/);
  assert.doesNotMatch(installer, /\$env:CODEX_HOME\s*=/);
  assert.ok(installer.includes('$env:CODEX_NON_INTERACTIVE = "true"'));
  assert.ok(installer.indexOf('Remove-Item Env:\\CODEX_HOME') < installer.indexOf('Write-Host "official installer"'));

  const claudeInstaller = agentPowerShellInstallerScript('Write-Host "claude"', CLAUDE_PS1_BOOTSTRAP);
  assert.ok(claudeInstaller.includes('Remove-Item Env:\\ELECTRON_RUN_AS_NODE'));
  assert.ok(claudeInstaller.indexOf('$ErrorActionPreference') < claudeInstaller.indexOf('Write-Host "claude"'));
});

test('PowerShell bootstrap never lands ahead of a bare param block', () => {
  // The real head of Claude's official install.ps1: a bare multi-line param
  // block with nested parentheses and no [CmdletBinding()]. `param` must stay
  // the first statement or PowerShell reports it as an unknown command.
  const officialScript = [
    'param(',
    '    [Parameter(Position=0)]',
    "    [ValidatePattern('^(stable|latest)$')]",
    '    [string]$Target = "latest"',
    ')',
    '',
    'Set-StrictMode -Version Latest',
    '',
  ].join('\r\n');
  const installer = agentPowerShellInstallerScript(officialScript, CLAUDE_PS1_BOOTSTRAP);

  assert.ok(installer.startsWith('param('));
  const bootstrapAt = installer.indexOf('Remove-Item Env:\\ELECTRON_RUN_AS_NODE');
  assert.ok(bootstrapAt > installer.indexOf('[string]$Target'));
  assert.ok(bootstrapAt < installer.indexOf('Set-StrictMode'));
  // The nested parenthesis inside [Parameter(Position=0)] must not be
  // mistaken for the block's closing parenthesis.
  assert.ok(installer.indexOf(')\r\n') > installer.indexOf('$Target'));
});

test('Windows PowerShell architecture failures explain the PowerShell 7 recovery', async () => {
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-shell-test-'));
  process.env.STASHBASE_LOCAL_DATA_ROOT = root;
  mock.method(globalThis, 'fetch', async () => new Response('# installer'));
  try {
    await assert.rejects(
      installCodex(() => {}, new AbortController().signal, {
        resolveInstallerShell: () => ({
          command: 'powershell.exe',
          args: [],
          kind: 'windows-powershell',
        }),
        runInstallerScript: async () => {
          throw new Error("The property 'OSArchitecture' cannot be found on this object.");
        },
      }),
      /PowerShell 7.*pwsh\.exe.*retry/i,
    );
  } finally {
    mock.restoreAll();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PowerShell Codex installer failures do not fall through to executable ENOENT', async () => {
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-powershell-error-test-'));
  const fakePowerShell = path.join(root, 'fake-powershell.cjs');
  process.env.STASHBASE_LOCAL_DATA_ROOT = root;
  fs.writeFileSync(fakePowerShell, `
const fs = require('node:fs');
const scriptPath = process.argv[2];
if (scriptPath && scriptPath.endsWith('.ps1')) {
  const script = fs.readFileSync(scriptPath, 'utf8');
  process.stderr.write('Codex package download blocked by proxy.');
  process.exitCode = script.includes('# official installer') ? 23 : 24;
} else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    process.stderr.write('Codex package download blocked by proxy.');
    process.exitCode = 0;
  });
}
`);
  mock.method(globalThis, 'fetch', async () => new Response('# official installer'));
  try {
    await assert.rejects(
      installCodex(() => {}, new AbortController().signal, {
        resolveInstallerShell: () => ({
          command: process.execPath,
          args: [fakePowerShell],
          kind: 'powershell-7',
        }),
        verifyExecutable: (executable) => {
          throw new Error(`spawnSync ${executable} ENOENT`);
        },
      }),
      (error) => {
        assert.match(String(error), /Codex package download blocked by proxy/);
        assert.doesNotMatch(String(error), /ENOENT/);
        return true;
      },
    );
    assert.equal(
      fs.readdirSync(agentInstallerTempRoot('codex')).some((entry) => entry.startsWith('.installer-script.')),
      false,
    );
  } finally {
    mock.restoreAll();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex install runs the official script unpinned and verifies the discovered executable', async () => {
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  const previousInstallDir = process.env.CODEX_INSTALL_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-install-test-'));
  process.env.STASHBASE_LOCAL_DATA_ROOT = root;
  // A stale pin inherited from an older StashBase version must not redirect
  // the official installer.
  process.env.CODEX_INSTALL_DIR = path.join(root, 'stale-private-bin');
  const installed = path.join(root, 'local-bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  const installer = process.platform === 'win32'
    ? [
      'Write-Output "stashbase fixture installer started"',
      'if ($env:CODEX_INSTALL_DIR) { throw "bootstrap leaked CODEX_INSTALL_DIR" }',
      'if ($env:CODEX_HOME) { throw "bootstrap leaked CODEX_HOME" }',
      '$null = [System.IO.Directory]::CreateDirectory((Split-Path -Parent ' + `'${installed.replaceAll("'", "''")}'))`,
      `Set-Content -LiteralPath '${installed.replaceAll("'", "''")}' -Value 'installed Codex'`,
      '',
    ].join('\n')
    : `#!/bin/sh
set -eu
[ -z "\${CODEX_INSTALL_DIR:-}" ]
[ -z "\${CODEX_HOME:-}" ]
[ "\${CODEX_NON_INTERACTIVE:-}" = "true" ]
mkdir -p "${path.dirname(installed)}"
: > "${installed}"
chmod +x "${installed}"
`;
  mock.method(globalThis, 'fetch', async () => new Response(installer));
  let verified = false;
  let selectedShell: ReturnType<typeof resolveCodexInstallerShell> | undefined;
  const updates: string[] = [];
  try {
    try {
      await installCodex((update) => {
        if (update.message) updates.push(update.message);
      }, new AbortController().signal, {
        resolveInstallerShell: () => {
          selectedShell = resolveCodexInstallerShell();
          return selectedShell;
        },
        resolveInstalledExecutable: () => (fs.existsSync(installed) ? installed : null),
        verifyExecutable: (executable, label) => {
          verified = true;
          assert.equal(executable, installed);
          assert.equal(label, 'Codex');
        },
      });
    } catch (error) {
      const entries = fs.readdirSync(root, { recursive: true }).map(String).sort().join(', ');
      throw new Error(
        `${String(error)} Test entries: ${entries || '(empty)'}. `
        + `Selected shell: ${JSON.stringify(selectedShell)}. Updates: ${JSON.stringify(updates)}`,
        { cause: error },
      );
    }
    assert.equal(verified, true);
    assert.equal(fs.existsSync(path.join(root, 'stale-private-bin')), false);
    if (process.platform === 'win32') assert.equal(selectedShell?.kind, 'powershell-7');
  } finally {
    mock.restoreAll();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    if (previousInstallDir === undefined) delete process.env.CODEX_INSTALL_DIR;
    else process.env.CODEX_INSTALL_DIR = previousInstallDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex installation reports missing output without a fabricated ENOENT check', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('# official installer'));
  let verified = false;
  try {
    await assert.rejects(
      installCodex(() => {}, new AbortController().signal, {
        runInstallerScript: async () => {},
        resolveInstalledExecutable: () => null,
        verifyExecutable: () => { verified = true; },
      }),
      (error) => {
        assert.match(String(error), /exited successfully but no 'codex' executable.*standard install locations/i);
        assert.doesNotMatch(String(error), /ENOENT/);
        return true;
      },
    );
    assert.equal(verified, false);
  } finally {
    mock.restoreAll();
  }
});



test('development failure injection is mutually exclusive and one-shot', () => {
  const previousDebug = process.env.STASHBASE_AGENT_DEBUG;
  process.env.STASHBASE_AGENT_DEBUG = '1';
  try {
    setAgentRuntimeDebugState({ nextFailure: 'mcp' });
    assert.equal(getAgentRuntimeDebugState().nextFailure, 'mcp');
    assert.equal(consumeAgentSetupFailure('installation'), false);
    assert.equal(getAgentRuntimeDebugState().nextFailure, 'mcp');
    assert.equal(consumeAgentSetupFailure('mcp'), true);
    assert.equal(getAgentRuntimeDebugState().nextFailure, 'none');
    assert.equal(consumeAgentSetupFailure('mcp'), false);
  } finally {
    setAgentRuntimeDebugState({ nextFailure: 'none' });
    if (previousDebug === undefined) delete process.env.STASHBASE_AGENT_DEBUG;
    else process.env.STASHBASE_AGENT_DEBUG = previousDebug;
  }
});

test('development turn failure injection is one-shot and independent of setup injection', () => {
  const previousDebug = process.env.STASHBASE_AGENT_DEBUG;
  process.env.STASHBASE_AGENT_DEBUG = '1';
  try {
    setAgentRuntimeDebugState({ nextFailure: 'mcp', nextTurnFailure: 'rate-limit' });
    assert.equal(getAgentRuntimeDebugState().nextTurnFailure, 'rate-limit');
    assert.equal(consumeAgentTurnFailure(), 'rate-limit');
    assert.equal(consumeAgentTurnFailure(), null);
    assert.equal(getAgentRuntimeDebugState().nextTurnFailure, 'none');
    // The setup simulation is a separate one-shot value.
    assert.equal(getAgentRuntimeDebugState().nextFailure, 'mcp');
    assert.throws(
      () => setAgentRuntimeDebugState({ nextTurnFailure: 'invalid' as AgentTurnFailureSimulation }),
      /Invalid Agent turn failure simulation/,
    );
  } finally {
    setAgentRuntimeDebugState({ nextFailure: 'none', nextTurnFailure: 'none' });
    if (previousDebug === undefined) delete process.env.STASHBASE_AGENT_DEBUG;
    else process.env.STASHBASE_AGENT_DEBUG = previousDebug;
  }
});

test('every turn failure script is bounded prose and only crash is session-fatal', () => {
  const kinds = ['rate-limit', 'quota', 'auth-expired', 'network', 'crash'] as const;
  for (const kind of kinds) {
    const script = simulatedTurnFailureScript(kind);
    assert.match(script.message, /^Simulated failure: /);
    assert.equal(script.fatal, kind === 'crash');
  }
});


test('explicit readiness finds a version-manager Agent through the login shell', { skip: process.platform === 'win32' }, async () => {
  const previousShell = process.env.SHELL;
  const previousFakeBin = process.env.STASHBASE_TEST_SHELL_AGENT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agent-shell-test-'));
  const shell = path.join(root, 'fake-shell');
  const executable = path.join(root, 'version-manager-agent');
  fs.writeFileSync(shell, '#!/bin/sh\nprintf "%s\\n" "$STASHBASE_TEST_SHELL_AGENT"\n');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(shell, 0o755);
  fs.chmodSync(executable, 0o755);
  process.env.SHELL = shell;
  process.env.STASHBASE_TEST_SHELL_AGENT = executable;
  try {
    assert.equal(
      await resolveAgentCliWithLoginShell({ name: `stashbase-test-agent-${process.pid}`, envNames: [], logLabel: 'Test Agent' }),
      executable,
    );
  } finally {
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    if (previousFakeBin === undefined) delete process.env.STASHBASE_TEST_SHELL_AGENT;
    else process.env.STASHBASE_TEST_SHELL_AGENT = previousFakeBin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('login-shell discovery is requested explicitly; catalog discovery stays cheap', async () => {
  const probes: Array<{ probeLoginShell?: boolean } | undefined> = [];
  let configured = 0;
  const fake = fakeDependencies({
    resolveExecutable: (_id, options) => {
      probes.push(options);
      // Only a login shell can resolve this runtime (nvm/homebrew paths).
      return options?.probeLoginShell ? '/login-shell/codex' : null;
    },
    configureMcp: () => { configured += 1; },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  // Cheap discovery does not launch a shell.
  assert.equal((await connect(coordinator, 'codex')).phase, 'idle');
  assert.equal(probes.at(-1)?.probeLoginShell, undefined);
  assert.equal(configured, 0);

  // Readiness explicitly requests login-shell discovery and finds the runtime.
  assert.equal((await connect(coordinator, 'codex', { probeLoginShell: true })).phase, 'ready');
  assert.equal(probes.at(-1)?.probeLoginShell, true);
  assert.equal(configured, 1);
});

test('pending authentication keeps the event loop live, deduplicates checks, and is cancelled on shutdown', async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let checks = 0;
  let configured = 0;
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: async () => '/fixture/codex',
    isAuthenticated: async (_id, _executable, signal) => {
      checks += 1;
      started();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      return true;
    },
    configureMcp: () => { configured += 1; },
  }).dependencies);
  assert.equal(coordinator.connectIfInstalled('codex').phase, 'configuring');
  await entered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.throws(() => coordinator.begin('codex'), /already.*checking/);
  coordinator.connectIfInstalled('codex');
  assert.equal(checks, 1);
  assert.deepEqual(await coordinator.cancelAll(), ['codex']);
  assert.equal(configured, 0);
});

test('CLI probes time out and cancel while unrelated event-loop work remains live', async () => {
  const { probeAgentCommand } = await import('../agent-probe.ts');
  const options = { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, timeoutMs: 100 };
  const stalled = probeAgentCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
  const timeout = assert.rejects(stalled, /timed out/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await timeout;
  const controller = new AbortController();
  const cancelled = assert.rejects(probeAgentCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    ...options, timeoutMs: 10_000, signal: controller.signal,
  }), /cancelled/);
  controller.abort();
  await cancelled;
});

test('update refuses a missing runtime without downloading or running anything', async () => {
  let installs = 0;
  const fake = fakeDependencies({
    resolveExecutable: () => null,
    installRuntime: async () => { installs += 1; },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  coordinator.update('claude');
  const status = await coordinator.wait('claude');

  assert.equal(status.phase, 'failed');
  assert.equal(status.failure?.stage, 'discovery');
  assert.equal(status.failure?.code, 'runtime-unavailable');
  assert.equal(installs, 0);
});

test('a failing updater surfaces as an installation failure with the manual install route', async () => {
  const fake = fakeDependencies({
    resolveExecutable: () => '/system/claude',
    installRuntime: async () => { throw new Error('native installation folder is not writable'); },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  coordinator.update('claude');
  const status = await coordinator.wait('claude');

  assert.equal(status.phase, 'failed');
  assert.equal(status.failure?.stage, 'installation');
  assert.equal(status.failure?.code, 'operation-failed');
  assert.equal(status.failure?.manualRecovery, 'install-command');
  assert.match(status.failure?.message ?? '', /not writable/);
});
