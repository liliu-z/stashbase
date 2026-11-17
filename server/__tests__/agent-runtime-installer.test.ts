import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { agentCliSearchDirs, resolveAgentCli, resolveAgentCliWithLoginShell } from '../agent-cli.ts';
import { AgentAuthenticationRequiredError } from '../agent-setup-diagnostic.ts';
import {
  AgentBootstrapCoordinator,
  agentIsAuthenticated,
  agentPowerShellInstallerScript,
  agentSignInUrl,
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
    verifyExecutable: async () => {},
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

async function connect(coordinator: AgentBootstrapCoordinator, id: 'codex' | 'claude', options?: { probeLoginShell?: boolean; source?: 'startup' }) {
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

test('native credential rejection requires a new login even when a later status reads cached sign-in',
  { skip: process.platform === 'win32' }, async (t) => {
    for (const id of ['claude', 'codex'] as const) {
      for (const mixedSignedOut of [false, true]) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-native-refused-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const executable = path.join(root, id);
        const statusCommand = id === 'claude' ? 'auth status' : 'login status';
        const loginCommand = id === 'claude' ? 'auth login' : 'login ';
        const signedOut = mixedSignedOut ? (id === 'claude' ? '{"loggedIn":false}' : 'Not logged in') : '';
        fs.writeFileSync(executable, `#!/bin/sh
if [ "$1 $2" = '${statusCommand}' ]; then
  if [ -f '${root}/cached-sign-in' ]; then echo '{"loggedIn":true}'; exit 0; fi
  echo '${signedOut}'
  echo 'API Error: 401 {"error":{"type":"authentication_error","message":"OAuth access token is invalid"}}' >&2
  exit 1
elif [ "$1 $2" = '${loginCommand}' ]; then touch '${root}/login-ran'
else exit 42; fi
`, { mode: 0o755 });
        const fixture = fakeDependencies({
          resolveExecutable: () => executable,
          isAuthenticated: agentIsAuthenticated,
          login: loginToAgent,
        });
        const coordinator = new AgentBootstrapCoordinator(fixture.dependencies);
        const refused = await connect(coordinator, id, { source: 'startup' });
        assert.equal(refused.failure?.code, 'authentication-required');
        assert.equal(refused.failure?.retryAction, 'login');
        assert.match(refused.failure?.message ?? '', /401.*OAuth access token is invalid/);
        assert.equal(coordinator.isExpectedSignOut(id, refused), false, 'an explicit refusal is not ordinary signed-out startup');
        assert.equal(fs.existsSync(path.join(root, 'login-ran')), false, 'a status check never launches login');
        fs.writeFileSync(path.join(root, 'cached-sign-in'), '');
        assert.equal((await prepare(coordinator, id)).failure?.code, 'authentication-required');
        assert.equal(fixture.configured(), 0, 'a cached sign-in cannot erase the provider refusal');
        coordinator.login(id);
        assert.equal((await coordinator.wait(id)).phase, 'ready');
        assert.equal(fs.existsSync(path.join(root, 'login-ran')), true, 'explicit sign-in must run the browser login');
        assert.equal(fixture.configured(), 1);
        assert.equal((await connect(coordinator, id)).phase, 'ready');
      }
    }
  });

test('unanswered native sign-in checks retain check recovery instead of requesting a new login',
  { skip: process.platform === 'win32' }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-auth-check-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // A path's digits are not provider output and cannot establish an HTTP 401.
    const executable = path.join(root, 'claude-401');
    for (const message of ['fetch failed: ECONNRESET', 'OAuth service unavailable: 503', 'unknown command: auth status']) {
      fs.writeFileSync(executable, `#!/bin/sh\necho '${message}' >&2\nexit 1\n`, { mode: 0o755 });
      const fixture = fakeDependencies({ resolveExecutable: () => executable, isAuthenticated: agentIsAuthenticated });
      const coordinator = new AgentBootstrapCoordinator(fixture.dependencies);
      const failed = await connect(coordinator, 'claude');
      assert.equal(failed.failure?.code, 'authentication-check-failed');
      assert.equal(failed.failure?.retryAction, 'bootstrap');
      assert.ok(failed.failure?.message.includes(message));
      assert.equal(fixture.configured(), 0);
    }
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

test('retrying a failed first install reruns the installer when the partial executable cannot run', async () => {
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
    verifyExecutable: async () => {
      if (installs === 1) throw new Error('partial copy');
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

test('retrying a failed install uses an executable that runs instead of downloading again', async () => {
  let executable: string | null = null;
  let installs = 0;
  const verified: string[] = [];
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => executable,
    resolveNativeExecutable: () => null,
    installRuntime: async () => {
      installs++;
      throw new Error('installation timed out after 8 minutes');
    },
    verifyExecutable: async (_id, candidate) => { verified.push(candidate); },
  }).dependencies);
  coordinator.begin('codex');
  assert.equal((await coordinator.wait('codex')).failure?.stage, 'installation');
  // Installed meanwhile through npm, outside StashBase.
  executable = '/npm/codex';
  coordinator.begin('codex');
  assert.equal((await coordinator.wait('codex')).phase, 'ready');
  assert.equal(installs, 1);
  assert.deepEqual(verified, ['/npm/codex']);
});

test('the first explicit connection repairs a broken discovered CLI, with or without an earlier startup check', async () => {
  for (const id of ['claude', 'codex', 'antigravity'] as const) {
    for (const checkedAtStartup of [false, true]) {
      let native: string | null = null;
      let installs = 0;
      const old = `/npm/${id}`;
      const verified: string[] = [];
      const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
        resolveExecutable: () => native ?? old,
        resolveNativeExecutable: () => native,
        installRuntime: async () => { installs++; native = `/home/.local/bin/${id}`; },
        verifyExecutable: async (_id, candidate) => {
          verified.push(candidate);
          if (candidate !== native) throw new Error('The launcher has no platform binary.');
        },
        isAuthenticated: (_id, candidate) => {
          if (candidate !== native) throw new Error('Cannot run the discovered CLI.');
          return true;
        },
      }).dependencies);
      if (checkedAtStartup) {
        coordinator.connectIfInstalled(id);
        assert.equal((await coordinator.wait(id)).failure?.retryAction, 'bootstrap',
          'a broken CLI must offer repair, not another login');
      }
      assert.equal(installs, 0, 'discovery alone never authorizes installation');
      coordinator.begin(id);
      assert.equal((await coordinator.wait(id)).phase, 'ready', `${id}: startup=${checkedAtStartup}`);
      assert.equal(installs, 1, 'the first explicit Connect repairs the installation');
      assert.deepEqual(verified, checkedAtStartup && id === 'antigravity' ? [old, old] : [old]);
    }
  }
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

test('production first connection and update run installer scripts, select native output, and preserve broken npm copies',
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
        for (const action of ['bootstrap', 'update']) {
          fs.rmSync(path.join(root, '.local/bin', id), { force: true });
          if (action === 'bootstrap') agentBootstrapCoordinator.begin(id);
          else updateAgentBootstrap(id);
          const status = await agentBootstrapCoordinator.wait(id);
          assert.equal(status.phase, 'ready', `${id} ${action}: ${JSON.stringify(status)}`);
          assert.equal(resolveAgentCli({ name: id, envNames: [], logLabel: id }), path.join(root, '.local/bin', id));
          assert.equal(fs.readFileSync(old, 'utf8'), original);
        }
      }
      assert.deepEqual(requests, [
        'https://claude.ai/install.sh', 'https://claude.ai/install.sh',
        'https://chatgpt.com/codex/install.sh', 'https://chatgpt.com/codex/install.sh',
      ]);
      assert.match(fs.readFileSync(path.join(root, '.claude.json'), 'utf8'), /stashbase/);
      assert.match(fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8'), /stashbase/);
      process.env.STASHBASE_CLAUDE_BIN = path.join(root, '.npm-global/bin/claude');
      assert.equal(agentSupportsInAppUpdate('claude'), false);
      assert.throws(() => updateAgentBootstrap('claude'), /executable override/);
      assert.equal(requests.length, 4, 'an explicit override is not silently bypassed by another installation');
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

  // StashBase's own check comes first; only the browser step is the reader's.
  assert.equal(coordinator.login('codex').phase, 'configuring');
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

/** A POSIX stand-in for a CLI whose `login status` reads a marker file and
 * whose `login` runs the given body. */
function fakeLoginCli(t: { after(fn: () => void): void }, login: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-login-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'codex');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    `if [ "$1 $2" = "login status" ]; then [ -f '${root}/signed-in' ] && exit 0; echo "Not logged in" >&2; exit 1; fi`,
    `if [ "$1" = "login" ]; then touch '${root}/login-ran'; ${login}; fi`,
    'exit 9',
    '',
  ].join('\n'), { mode: 0o755 });
  return {
    executable,
    signIn: () => fs.writeFileSync(path.join(root, 'signed-in'), ''),
    loginRan: () => fs.existsSync(path.join(root, 'login-ran')),
  };
}

test('sign-in finishes when the CLI reads signed in although its login keeps waiting',
  { skip: process.platform === 'win32' }, async (t) => {
    const cli = fakeLoginCli(t, `touch "$(dirname "$0")/signed-in"; sleep 30`);
    const started = Date.now();
    await loginToAgent('codex', cli.executable, new AbortController().signal, {}, { pollMs: 20 });
    assert.ok(cli.loginRan());
    assert.ok(Date.now() - started < 10_000);
  });

test('sign-in opens no browser for a CLI that is already signed in, unless the provider refused it',
  { skip: process.platform === 'win32' }, async (t) => {
    const cli = fakeLoginCli(t, 'exit 0');
    cli.signIn();
    await loginToAgent('codex', cli.executable, new AbortController().signal);
    assert.equal(cli.loginRan(), false);
    await loginToAgent('codex', cli.executable, new AbortController().signal, { reauthenticate: true });
    assert.equal(cli.loginRan(), true);
  });

test('a timed out sign-in offers the printed page and keeps its output without the attempt state',
  { skip: process.platform === 'win32' }, async (t) => {
    const cli = fakeLoginCli(t, `echo 'If your browser did not open, visit: https://auth.example.com/oauth/authorize?state=secret-state'; sleep 30`);
    const urls: string[] = [];
    await assert.rejects(
      loginToAgent('codex', cli.executable, new AbortController().signal, {
        onSignInUrl: (url) => urls.push(url),
      }, { pollMs: 20, timeoutMs: 400 }),
      (error: Error & { stderr?: string }) => {
        assert.match(error.message, /timed out.*auth\.example\.com/s);
        assert.match(error.message, /Last output: .*visit: https:\/\/auth\.example\.com\/oauth\/authorize/);
        assert.doesNotMatch(`${error.message}${error.stderr}`, /secret-state/);
        return true;
      },
    );
    assert.deepEqual(urls, ['https://auth.example.com/oauth/authorize?state=secret-state']);
  });

test('only a printed page that finishes sign-in on this machine is offered, once it has fully arrived', () => {
  // Shapes the real CLIs print (Claude 2.1.280, Codex 0.160.0), attempt state elided.
  const claude = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s\nPaste code here if prompted > ';
  const codex = 'Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s\n';
  assert.equal(agentSignInUrl(claude), undefined);
  assert.equal(
    agentSignInUrl(codex),
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s',
  );
  assert.equal(agentSignInUrl(codex.slice(0, codex.indexOf('&redirect_uri'))), undefined);
});

test('a provider refusal makes the next sign-in reauthenticate until the runtime is ready again', async () => {
  const requests: boolean[] = [];
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/managed/codex',
    login: async (_id, _executable, _signal, options) => { requests.push(options.reauthenticate === true); },
  }).dependencies);
  coordinator.requireSignIn('codex', 'Your access token could not be refreshed.');
  coordinator.login('codex');
  assert.equal((await coordinator.wait('codex')).phase, 'ready');
  coordinator.login('codex');
  await coordinator.wait('codex');
  assert.deepEqual(requests, [true, false]);
});

test('a provider refusal survives an in-flight local status check and later rechecks until sign-in', async () => {
  let answer!: (authenticated: boolean) => void;
  let gate = new Promise<boolean>((resolve) => { answer = resolve; });
  const fixture = fakeDependencies({
    resolveExecutable: () => '/managed/codex',
    isAuthenticated: () => gate,
  });
  const coordinator = new AgentBootstrapCoordinator(fixture.dependencies);
  coordinator.connectIfInstalled('codex');
  await new Promise<void>((resolve) => setImmediate(resolve));
  coordinator.requireSignIn('codex', 'workspace routing discovery unauthorized (401)');
  assert.equal(coordinator.status('codex').phase, 'configuring', 'keep the running check visible until it settles');
  answer(true);
  const refused = await coordinator.wait('codex');
  assert.equal(refused.failure?.code, 'authentication-required');
  assert.match(refused.failure?.message ?? '', /unauthorized \(401\)/);
  assert.equal(fixture.configured(), 0);
  gate = Promise.resolve(true);
  assert.equal((await connect(coordinator, 'codex')).failure?.code, 'authentication-required');
  coordinator.login('codex');
  assert.equal((await coordinator.wait('codex')).phase, 'ready');
});

test('the printed sign-in page reaches the status while the browser step runs', async () => {
  let finish!: () => void;
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/managed/codex',
    login: async (_id, _executable, _signal, options) => {
      options.onSignInUrl?.('https://auth.example.com/oauth/authorize?state=1');
      await new Promise<void>((resolve) => { finish = resolve; });
    },
  }).dependencies);
  coordinator.login('codex');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(coordinator.status('codex'), {
    phase: 'authenticating',
    message: 'Finish signing in to Codex in your browser.',
    signInUrl: 'https://auth.example.com/oauth/authorize?state=1',
  });
  finish();
  assert.equal((await coordinator.wait('codex')).phase, 'ready');
});

test('sign-in asks for the browser only once the runtime opens it', async () => {
  let open!: () => void;
  let finish!: () => void;
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/managed/codex',
    login: async (_id, _executable, _signal, options) => {
      await new Promise<void>((resolve) => { open = resolve; });
      options.onBrowserSignIn?.();
      await new Promise<void>((resolve) => { finish = resolve; });
    },
  }).dependencies);
  coordinator.login('codex');
  await new Promise<void>((resolve) => setImmediate(resolve));
  // The login is still looking for a sign-in already in place: StashBase's
  // own check, which offers no Stop.
  assert.deepEqual(coordinator.status('codex'), { phase: 'configuring', message: 'Checking Codex sign-in…' });
  open();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(coordinator.status('codex'), {
    phase: 'authenticating',
    message: 'Finish signing in to Codex in your browser.',
  });
  finish();
  assert.equal((await coordinator.wait('codex')).phase, 'ready');
});

test('stopping a browser sign-in retires the login and leaves the runtime signed out', async () => {
  let retired = false;
  let logins = 0;
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/managed/codex',
    isAuthenticated: () => false,
    login: async (_id, _executable, signal, options) => {
      if (++logins > 1) return;
      options.onBrowserSignIn?.();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      retired = true;
      throw new Error('Codex sign-in was cancelled.');
    },
  }).dependencies);
  coordinator.login('codex');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stopped = await coordinator.stop('codex');
  assert.equal(retired, true, 'the login process is retired before the stop answers');
  assert.equal(stopped.phase, 'failed');
  // Signed out, so the next step is Sign in rather than a failed step's Retry.
  assert.equal(stopped.failure?.code, 'authentication-required');
  assert.equal(stopped.failure?.retryAction, 'login');
  assert.match(stopped.failure?.message ?? '', /Codex sign-in was stopped\.$/);
  // A new Sign in starts its own attempt instead of joining the stopped one.
  coordinator.login('codex');
  assert.equal((await coordinator.wait('codex')).failure?.code, 'authentication-required');
  assert.equal(logins, 2);
});

test('a stop that lands in the sign-in check reads as stopped, not as a failed check', async () => {
  let checking!: () => void;
  const started = new Promise<void>((resolve) => { checking = resolve; });
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/managed/codex',
    login: async () => undefined,
    isAuthenticated: async (_id, _executable, signal) => {
      checking();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('Agent probe was cancelled.');
    },
  }).dependencies);
  coordinator.login('codex');
  await started;
  const stopped = await coordinator.stop('codex');
  assert.equal(stopped.failure?.code, 'authentication-required');
  assert.match(stopped.failure?.message ?? '', /Codex sign-in was stopped\.$/);
});

test('stopping leaves a background connection, an update, and an idle runtime alone', async () => {
  let release!: () => void;
  let discovered = Promise.resolve();
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: async () => {
      await discovered;
      return '/managed/codex';
    },
  }).dependencies);
  assert.equal((await coordinator.stop('codex')).phase, 'idle');
  // A stop that arrives once another run has replaced the sign-in, such as a
  // late one, answers at once and leaves that run to finish.
  for (const start of [() => coordinator.connectIfInstalled('codex'), () => coordinator.update('codex')]) {
    discovered = new Promise<void>((resolve) => { release = resolve; });
    start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.notEqual((await coordinator.stop('codex')).phase, 'failed');
    release();
    assert.equal((await coordinator.wait('codex')).phase, 'ready');
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

  assert.equal((await connect(coordinator, 'codex', { source: 'startup' })).phase, 'ready');
  installed = false;
  assert.equal((await connect(coordinator, 'claude', { source: 'startup' })).phase, 'idle');
  assert.equal(installs, 0);
  assert.equal(configured, 1);
});

test('ordinary signed-out startup keeps login recovery without a failed setup report', async (t) => {
  const { telemetry } = await import('../telemetry.ts');
  const events: any[] = [];
  t.mock.method(telemetry, 'scoped', () => (event: unknown) => events.push(event));
  let signedIn = false;
  const fixture = fakeDependencies({
    resolveExecutable: () => '/system/claude',
    isAuthenticated: () => signedIn,
    login: async () => { signedIn = true; },
  });
  const coordinator = new AgentBootstrapCoordinator(fixture.dependencies);
  const status = await connect(coordinator, 'claude', { source: 'startup' });
  assert.equal(status.failure?.code, 'authentication-required');
  assert.equal(status.failure?.retryAction, 'login');
  assert.equal(coordinator.isExpectedSignOut('claude', status), true);
  assert.equal(fixture.configured(), 0);
  assert.equal(events.length, 0, 'a normal startup prerequisite is not failed setup');

  await connect(coordinator, 'claude');
  const explicit = events.find(event => event.event === 'agent_setup_result');
  assert.equal(explicit.context.action, 'connect');
  assert.equal(explicit.context.retry_of, undefined, 'no retry link to an unreported startup');
  assert.equal(explicit.failure_stage, 'authentication');
  coordinator.login('claude');
  assert.equal((await coordinator.wait('claude')).phase, 'ready');
  assert.equal(coordinator.isExpectedSignOut('claude'), false);
  assert.equal(fixture.configured(), 1);
});

test('startup retains diagnostics for rejected credentials, unanswered probes, and MCP failures', async (t) => {
  const { telemetry } = await import('../telemetry.ts');
  const events: any[] = [];
  t.mock.method(telemetry, 'scoped', () => (event: unknown) => events.push(event));
  for (const scenario of ['credential-rejected', 'previous-refusal', 'check-failed', 'mcp-failed'] as const) {
    events.length = 0;
    const fixture = fakeDependencies({
      resolveExecutable: () => '/system/claude',
      isAuthenticated: () => {
        if (scenario === 'credential-rejected') throw new AgentAuthenticationRequiredError('401 OAuth access token is invalid');
        if (scenario === 'check-failed') throw new Error('Agent probe timed out after 10000ms.');
        return scenario !== 'previous-refusal';
      },
      configureMcp: () => { if (scenario === 'mcp-failed') throw new Error('EACCES: MCP config is not writable'); },
    });
    const coordinator = new AgentBootstrapCoordinator(fixture.dependencies);
    if (scenario === 'previous-refusal') coordinator.requireSignIn('claude', 'Provider refused the stored credential.');
    const status = await connect(coordinator, 'claude', { source: 'startup' });
    assert.equal(status.phase, 'failed', scenario);
    assert.equal(coordinator.isExpectedSignOut('claude', status), false, scenario);
    const results = events.filter(event => event.event === 'agent_setup_result');
    assert.equal(results.length, 1, scenario);
    assert.equal(results[0].context.action, 'startup', scenario);
    assert.equal(results[0].outcome, 'failed', scenario);
    assert.equal(results[0].failure_stage, scenario === 'mcp-failed' ? 'mcp' : 'authentication', scenario);
    assert.ok(results[0].diagnostic.message, scenario);
  }
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

  assert.equal((await connect(coordinator, 'codex', { source: 'startup' })).phase, 'ready');
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
  assert.match(settled.failure?.message ?? '', /Simulated agent installation failure/);

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
  assert.equal(coordinator.login('codex').phase, 'configuring');
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
      /PowerShell 7 \(pwsh\.exe\)\.$/,
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
    if (process.platform === 'win32') {
      // PowerShell 7 must be chosen whenever it is installed; without it, the
      // same installer has to succeed under the built-in Windows PowerShell.
      const powerShell7Installed = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0
        || [process.env.ProgramW6432, process.env.ProgramFiles]
          .some((dir) => dir && fs.existsSync(path.join(dir, 'PowerShell', '7', 'pwsh.exe')));
      assert.equal(selectedShell?.kind, powerShell7Installed ? 'powershell-7' : 'windows-powershell');
    }
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
      /Invalid agent turn failure simulation/,
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
  const previousIsolation = process.env.STASHBASE_ISOLATED_AGENTS;
  delete process.env.STASHBASE_ISOLATED_AGENTS;
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
    if (previousIsolation === undefined) delete process.env.STASHBASE_ISOLATED_AGENTS;
    else process.env.STASHBASE_ISOLATED_AGENTS = previousIsolation;
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

test('failed setup reports native error causes once with its action and failing phase', async (t) => {
  const { telemetry } = await import('../telemetry.ts');
  const events: any[] = [];
  t.mock.method(telemetry, 'scoped', () => (event: unknown) => events.push(event));
  const error = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const coordinator = new AgentBootstrapCoordinator(fakeDependencies({ installRuntime: async () => { throw error; } }).dependencies);
  coordinator.begin('codex');
  coordinator.begin('codex');
  await coordinator.wait('codex');
  const stages = events.filter((event) => event.event === 'agent_setup_stage');
  assert.deepEqual(stages.map((event) => [event.stage, event.outcome]), [['discovery', 'started'], ['discovery', 'success'], ['installation', 'started']]);
  const results = events.filter((event) => event.event === 'agent_setup_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].stage, 'prepare');
  assert.equal(results[0].failure_stage, 'installation');
  assert.equal(results[0].outcome, 'failed');
  assert.equal(results[0].diagnostic.causes[0].code, 'ECONNREFUSED');
  assert.match(results[0].diagnostic.message, /fetch failed/);
  coordinator.begin('codex');
  await coordinator.wait('codex');
  const retried = events.filter((event) => event.event === 'agent_setup_result')[1];
  assert.equal(retried.context.retry_of, results[0].context.attempt_id);
  assert.notEqual(retried.context.attempt_id, results[0].context.attempt_id);
});

test('successful installation is recorded separately from the following sign-in failure', async (t) => {
  const { telemetry } = await import('../telemetry.ts');
  const events: any[] = [];
  t.mock.method(telemetry, 'scoped', () => (event: unknown) => events.push(event));
  const fake = fakeDependencies({ isAuthenticated: () => false });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);
  coordinator.begin('claude');
  await coordinator.wait('claude');
  const installed = events.find((event) => event.event === 'agent_setup_stage' && event.stage === 'installation' && event.outcome === 'success');
  const result = events.find((event) => event.event === 'agent_setup_result');
  assert.ok(installed);
  assert.equal(result.context.attempt_id, installed.attempt_id);
  assert.equal(result.failure_stage, 'authentication');
  assert.match(result.diagnostic.message, /installed.*not signed in/);
});
