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
  claudePlatform,
  codexPowerShellInstallerScript,
  installClaude,
  installCodex,
  loginToAgent,
  resolveCodexInstallerShell,
  verifyAgentExecutable,
  type AgentBootstrapDependencies,
} from '../agent-runtime-installer.ts';
import {
  consumeAgentSetupFailure,
  getAgentRuntimeDebugState,
  initialAgentDiscoveryPolicy,
  managedAgentRuntimeRoot,
  managedCodexBinDir,
  managedCodexInstallerHome,
  managedCodexReleasesDir,
  setAgentRuntimeDebugState,
} from '../agent-runtime-paths.ts';

function fakeDependencies(overrides: Partial<AgentBootstrapDependencies> = {}) {
  let installed = false;
  let authenticated = true;
  let configured = 0;
  const dependencies: AgentBootstrapDependencies = {
    resolveExecutable: () => installed ? '/managed/codex' : null,
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

test('missing runtime moves through install and MCP configuration to ready', async () => {
  const fake = fakeDependencies();
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  assert.equal(coordinator.begin('codex').phase, 'installing');
  const settled = await coordinator.wait('codex');

  assert.equal(settled.phase, 'ready');
  assert.equal(settled.progress, 1);
  assert.equal(fake.configured(), 1);
});

test('existing runtime skips download but still ensures MCP configuration', () => {
  let installs = 0;
  let configured = 0;
  const fake = fakeDependencies({
    resolveExecutable: () => '/system/claude',
    installRuntime: async () => { installs += 1; },
    configureMcp: () => { configured += 1; },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  assert.equal(coordinator.begin('claude').phase, 'ready');
  assert.equal(installs, 0);
  assert.equal(configured, 1);
});

test('installed Codex stops at a distinct authentication failure before MCP configuration', () => {
  let configured = 0;
  const fake = fakeDependencies({
    resolveExecutable: () => '/managed/codex',
    isAuthenticated: () => false,
    configureMcp: () => { configured += 1; },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  const status = coordinator.begin('codex');

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
  assert.equal(coordinator.begin('codex').failure?.stage, 'authentication');

  assert.equal(coordinator.login('codex').phase, 'authenticating');
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
    assert.equal(agentIsAuthenticated('codex', executable), false);
    await loginToAgent('codex', executable, new AbortController().signal);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup connects MCP for discovered runtimes without installing missing ones', () => {
  let installed = true;
  let installs = 0;
  let configured = 0;
  const fake = fakeDependencies({
    resolveExecutable: () => installed ? '/system/codex' : null,
    installRuntime: async () => { installs += 1; },
    configureMcp: () => { configured += 1; },
  });
  const coordinator = new AgentBootstrapCoordinator(fake.dependencies);

  assert.equal(coordinator.connectIfInstalled('codex').phase, 'ready');
  installed = false;
  assert.equal(coordinator.connectIfInstalled('claude').phase, 'idle');
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

  assert.equal(coordinator.begin('codex').phase, 'installing');
  assert.equal((await coordinator.wait('codex')).phase, 'failed');
  externallyInstalled = true;

  const checked = coordinator.connectIfInstalled('codex', { probeLoginShell: true });

  assert.equal(checked.phase, 'ready');
  assert.equal(installs, 1);
  assert.equal(configured, 1);
});

test('startup MCP repair does not consume the next explicit setup failure', () => {
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

  assert.equal(coordinator.connectIfInstalled('codex').phase, 'ready');
  assert.equal(configured, 1);
  assert.equal(nextFailure, 'mcp');
  assert.equal(coordinator.begin('codex').failure?.stage, 'mcp');
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
  const settled = coordinator.begin('codex');
  assert.equal(settled.phase, 'failed');
  assert.equal(settled.failure?.stage, 'installation');
  assert.equal(settled.failure?.code, 'simulated');
  assert.equal(settled.failure?.manualRecovery, undefined);
  assert.match(settled.failure?.message ?? '', /Simulated Agent installation failure/);

  assert.equal(coordinator.begin('codex').phase, 'installing');
  assert.equal((await coordinator.wait('codex')).phase, 'ready');
});

test('an injected MCP failure retries only MCP when the runtime exists', () => {
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

  const failed = coordinator.begin('codex');
  assert.equal(failed.failure?.stage, 'mcp');
  assert.equal(failed.failure?.code, 'simulated');
  assert.equal(failed.failure?.manualRecovery, undefined);
  assert.equal(installs, 0);
  assert.equal(configured, 0);

  assert.equal(coordinator.begin('codex').phase, 'ready');
  assert.equal(installs, 0);
  assert.equal(configured, 1);
});

test('real installation and MCP errors advertise only their relevant manual recovery', async () => {
  const installFailure = new AgentBootstrapCoordinator(fakeDependencies({
    installRuntime: async () => { throw new Error('download unavailable'); },
  }).dependencies);
  assert.equal(installFailure.begin('codex').phase, 'installing');
  const failedInstall = await installFailure.wait('codex');
  assert.equal(failedInstall.failure?.stage, 'installation');
  assert.equal(failedInstall.failure?.manualRecovery, 'install-command');

  const mcpFailure = new AgentBootstrapCoordinator(fakeDependencies({
    resolveExecutable: () => '/system/codex',
    configureMcp: () => { throw new Error('config is read-only'); },
  }).dependencies);
  const failedMcp = mcpFailure.begin('codex');
  assert.equal(failedMcp.failure?.stage, 'mcp');
  assert.equal(failedMcp.failure?.manualRecovery, 'mcp-settings');
});

test('Claude release platform mapping stays provider-shaped', () => {
  assert.equal(claudePlatform('darwin', 'arm64', false), 'darwin-arm64');
  assert.equal(claudePlatform('linux', 'x64', false), 'linux-x64');
  assert.equal(claudePlatform('linux', 'arm64', true), 'linux-arm64-musl');
  assert.equal(claudePlatform('win32', 'x64', false), 'win32-x64');
  assert.throws(() => claudePlatform('freebsd', 'x64', false), /does not publish/);
});

test('Claude staging cleanup never masks the executable verification failure', async () => {
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-cleanup-test-'));
  const version = '2.1.233';
  const platform = claudePlatform();
  const binary = Buffer.from('fake Claude executable');
  const verifierFailure = new Error('Claude verifier timed out after 20 seconds.');
  process.env.STASHBASE_LOCAL_DATA_ROOT = root;
  mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith('/latest')) return new Response(version);
    if (url.endsWith('/manifest.json')) {
      return new Response(JSON.stringify({
        version,
        platforms: {
          [platform]: {
            binary: process.platform === 'win32' ? 'claude.exe' : 'claude',
            checksum: crypto.createHash('sha256').update(binary).digest('hex'),
            size: binary.length,
          },
        },
      }));
    }
    return new Response(binary);
  });
  const originalRmSync = fs.rmSync;
  let cleanupOptions: fs.RmDirOptions | undefined;
  mock.method(fs, 'rmSync', ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (String(target).includes('.staging.')) {
      cleanupOptions = options;
      throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${target}\\claude.exe'`), {
        code: 'EPERM',
        syscall: 'unlink',
      });
    }
    return originalRmSync(target, options);
  }) as typeof fs.rmSync);
  try {
    await assert.rejects(
      installClaude(() => {}, new AbortController().signal, () => { throw verifierFailure; }),
      (error) => {
        assert.equal(error, verifierFailure);
        return true;
      },
    );
    assert.ok((cleanupOptions?.maxRetries ?? 0) > 0);
    assert.ok((cleanupOptions?.retryDelay ?? 0) > 0);
  } finally {
    mock.restoreAll();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent executable verification reports the native exit code and stderr', {
  skip: process.platform === 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agent-verifier-test-'));
  const executable = path.join(root, 'agent');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "blocked by policy\\n" >&2\nexit 23\n');
  fs.chmodSync(executable, 0o755);
  try {
    assert.throws(
      () => verifyAgentExecutable(executable, 'Claude Code'),
      /Claude Code.*exited with code 23.*blocked by policy/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent executable verification identifies a timeout', {
  skip: process.platform === 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agent-verifier-timeout-test-'));
  const executable = path.join(root, 'agent');
  fs.writeFileSync(executable, '#!/bin/sh\nwhile :; do :; done\n');
  fs.chmodSync(executable, 0o755);
  try {
    assert.throws(
      () => verifyAgentExecutable(executable, 'Claude Code', process.env, 25),
      /Claude Code.*timed out after 25ms/i,
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

test('PowerShell Codex bootstrap pins managed paths inside the official script', () => {
  const officialScript = '[CmdletBinding()]\nparam(\n  [string]$Release\n)\nWrite-Host "official installer"\n';
  const installer = codexPowerShellInstallerScript(
    officialScript,
    {
      CODEX_INSTALL_DIR: "C:\\Users\\O'Brien\\AppData\\Local\\StashBase\\agent-runtimes\\codex\\bin",
      CODEX_HOME: "C:\\Users\\O'Brien\\AppData\\Local\\StashBase\\agent-runtimes\\codex\\installer-home",
    },
  );

  assert.ok(installer.startsWith('[CmdletBinding()]\nparam(\n  [string]$Release\n)\n'));
  assert.ok(installer.includes("$env:CODEX_INSTALL_DIR = 'C:\\Users\\O''Brien\\AppData\\Local\\StashBase\\agent-runtimes\\codex\\bin'"));
  assert.ok(installer.includes("$env:CODEX_HOME = 'C:\\Users\\O''Brien\\AppData\\Local\\StashBase\\agent-runtimes\\codex\\installer-home'"));
  assert.ok(installer.includes('$env:CODEX_NON_INTERACTIVE = "true"'));
  assert.ok(installer.indexOf('$env:CODEX_HOME') < installer.indexOf('Write-Host "official installer"'));
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
      fs.readdirSync(managedAgentRuntimeRoot('codex')).some((entry) => entry.startsWith('.installer-script.')),
      false,
    );
  } finally {
    mock.restoreAll();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex post-install verification preserves the isolated installer environment', async () => {
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-install-test-'));
  process.env.STASHBASE_LOCAL_DATA_ROOT = root;
  const fixtureExecutable = path.join(root, 'fixture-codex.exe');
  if (process.platform === 'win32') fs.writeFileSync(fixtureExecutable, 'installed Codex');
  const installer = process.platform === 'win32'
    ? [
      '$null = [System.IO.Directory]::CreateDirectory($env:CODEX_INSTALL_DIR)',
      '$codexPath = Join-Path $env:CODEX_INSTALL_DIR "codex.exe"',
      `Move-Item -LiteralPath '${fixtureExecutable.replaceAll("'", "''")}' -Destination $codexPath`,
      'if (-not (Test-Path -LiteralPath $codexPath -PathType Leaf)) { throw "fixture did not create codex.exe" }',
      '',
    ].join('\n')
    : `#!/bin/sh
set -eu
mkdir -p "$CODEX_INSTALL_DIR"
: > "$CODEX_INSTALL_DIR/codex"
chmod +x "$CODEX_INSTALL_DIR/codex"
`;
  mock.method(globalThis, 'fetch', async () => new Response(installer));
  let verified = false;
  let selectedShell: ReturnType<typeof resolveCodexInstallerShell> | undefined;
  try {
    try {
      await installCodex(() => {}, new AbortController().signal, {
        resolveInstallerShell: () => {
          selectedShell = resolveCodexInstallerShell();
          return selectedShell;
        },
        verifyExecutable: (executable, label, env) => {
          verified = true;
          assert.equal(executable, path.join(managedCodexBinDir(), process.platform === 'win32' ? 'codex.exe' : 'codex'));
          assert.equal(label, 'Codex');
          assert.equal(env.CODEX_INSTALL_DIR, managedCodexBinDir());
          assert.equal(env.CODEX_HOME, managedCodexInstallerHome());
        },
      });
    } catch (error) {
      const entries = fs.readdirSync(root, { recursive: true }).map(String).sort().join(', ');
      throw new Error(`${String(error)} Managed test entries: ${entries || '(empty)'}`, { cause: error });
    }
    assert.equal(verified, true);
    if (process.platform === 'win32') assert.equal(selectedShell?.kind, 'powershell-7');
  } finally {
    mock.restoreAll();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex leaves the visible bin path for the official installer to create', async () => {
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-bin-ownership-test-'));
  process.env.STASHBASE_LOCAL_DATA_ROOT = root;
  mock.method(globalThis, 'fetch', async () => new Response('# official installer'));
  try {
    await installCodex(() => {}, new AbortController().signal, {
      runInstallerScript: async (_shell, _script, env) => {
        assert.equal(fs.existsSync(managedCodexBinDir()), false);
        const executable = path.join(
          env.CODEX_INSTALL_DIR ?? '',
          process.platform === 'win32' ? 'codex.exe' : 'codex',
        );
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.writeFileSync(executable, 'installed Codex');
        if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
      },
      verifyExecutable: () => {},
    });
  } finally {
    mock.restoreAll();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex installation reports missing managed output without a fabricated ENOENT check', async () => {
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-missing-output-test-'));
  process.env.STASHBASE_LOCAL_DATA_ROOT = root;
  mock.method(globalThis, 'fetch', async () => new Response('# official installer'));
  let verified = false;
  try {
    await assert.rejects(
      installCodex(() => {}, new AbortController().signal, {
        runInstallerScript: async () => {},
        verifyExecutable: () => { verified = true; },
      }),
      (error) => {
        assert.match(String(error), /exited successfully.*did not create an executable/i);
        assert.doesNotMatch(String(error), /ENOENT/);
        return true;
      },
    );
    assert.equal(verified, false);
  } finally {
    mock.restoreAll();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex installation resolves the official current package when the visible bin link is unavailable', async () => {
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-current-layout-test-'));
  process.env.STASHBASE_LOCAL_DATA_ROOT = root;
  const currentExecutable = path.join(
    managedCodexInstallerHome(),
    'packages',
    'standalone',
    'current',
    'bin',
    process.platform === 'win32' ? 'codex.exe' : 'codex',
  );
  mock.method(globalThis, 'fetch', async () => new Response('# installer'));
  try {
    await installCodex(() => {}, new AbortController().signal, {
      runInstallerScript: async () => {
        fs.mkdirSync(path.dirname(currentExecutable), { recursive: true });
        fs.writeFileSync(currentExecutable, 'installed Codex');
        if (process.platform !== 'win32') fs.chmodSync(currentExecutable, 0o755);
      },
      verifyExecutable: (executable) => {
        if (!fs.existsSync(executable)) throw new Error(`spawnSync ${executable} ENOENT`);
        assert.equal(executable, currentExecutable);
      },
    });
  } finally {
    mock.restoreAll();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex installation resolves a physical official release when both junctions are unavailable', async (context) => {
  const target = process.platform === 'win32'
    ? process.arch === 'arm64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc'
    : process.platform === 'darwin'
      ? process.arch === 'arm64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin'
      : process.platform === 'linux'
        ? process.arch === 'arm64' ? 'x86_64-unknown-linux-gnu' : 'aarch64-unknown-linux-gnu'
        : null;
  if (!target || !['arm64', 'x64'].includes(process.arch)) {
    context.skip('Codex does not publish a managed runtime for this test platform.');
    return;
  }
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-release-layout-test-'));
  process.env.STASHBASE_LOCAL_DATA_ROOT = root;
  const releaseExecutable = path.join(
    managedCodexReleasesDir(),
    `0.147.0-${target}`,
    'bin',
    process.platform === 'win32' ? 'codex.exe' : 'codex',
  );
  mock.method(globalThis, 'fetch', async () => new Response('# installer'));
  try {
    await installCodex(() => {}, new AbortController().signal, {
      runInstallerScript: async () => {
        fs.mkdirSync(path.dirname(releaseExecutable), { recursive: true });
        fs.writeFileSync(releaseExecutable, 'installed Codex');
        if (process.platform !== 'win32') fs.chmodSync(releaseExecutable, 0o755);
      },
      verifyExecutable: (executable) => {
        assert.equal(executable, releaseExecutable);
      },
    });
  } finally {
    mock.restoreAll();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('development fixtures can isolate discovery from developer-installed Agents', () => {
  assert.equal(initialAgentDiscoveryPolicy({}), 'auto');
  assert.equal(initialAgentDiscoveryPolicy({ STASHBASE_AGENT_DISCOVERY_POLICY: 'managed-only' }), 'auto');
  assert.equal(initialAgentDiscoveryPolicy({
    STASHBASE_DEV_RUNTIME: '1',
    STASHBASE_AGENT_DISCOVERY_POLICY: 'managed-only',
  }), 'managed-only');
  assert.equal(initialAgentDiscoveryPolicy({
    STASHBASE_DEV_VITE: '1',
    STASHBASE_AGENT_DISCOVERY_POLICY: 'system-only',
  }), 'system-only');
  assert.equal(initialAgentDiscoveryPolicy({
    STASHBASE_AGENT_DEBUG: '1',
    STASHBASE_AGENT_DISCOVERY_POLICY: 'managed-only',
  }), 'managed-only');
  assert.equal(initialAgentDiscoveryPolicy({
    STASHBASE_AGENT_DEBUG: '1',
    STASHBASE_AGENT_DISCOVERY_POLICY: 'invalid',
  }), 'auto');
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

test('managed-only discovery ignores the global Agent without uninstalling it', () => {
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  const previousDebug = process.env.STASHBASE_AGENT_DEBUG;
  const previousCodexBin = process.env.STASHBASE_CODEX_BIN;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agent-runtime-test-'));
  const systemExecutable = path.join(root, process.platform === 'win32' ? 'system-codex.exe' : 'system-codex');
  process.env.STASHBASE_LOCAL_DATA_ROOT = root;
  process.env.STASHBASE_AGENT_DEBUG = '1';
  process.env.STASHBASE_CODEX_BIN = systemExecutable;
  try {
    const executable = path.join(managedCodexBinDir(), process.platform === 'win32' ? 'codex.exe' : 'codex');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(systemExecutable, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
    if (process.platform !== 'win32') fs.chmodSync(systemExecutable, 0o755);

    setAgentRuntimeDebugState({ discoveryPolicy: 'auto' });
    assert.equal(resolveAgentCli({ name: 'codex', envNames: ['STASHBASE_CODEX_BIN'], logLabel: 'Codex' }), systemExecutable);
    setAgentRuntimeDebugState({ discoveryPolicy: 'managed-only' });
    assert.equal(resolveAgentCli({ name: 'codex', envNames: ['STASHBASE_CODEX_BIN'], logLabel: 'Codex' }), executable);
  } finally {
    setAgentRuntimeDebugState({ discoveryPolicy: 'auto', nextFailure: 'none' });
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    if (previousDebug === undefined) delete process.env.STASHBASE_AGENT_DEBUG;
    else process.env.STASHBASE_AGENT_DEBUG = previousDebug;
    if (previousCodexBin === undefined) delete process.env.STASHBASE_CODEX_BIN;
    else process.env.STASHBASE_CODEX_BIN = previousCodexBin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit readiness finds a version-manager Agent through the login shell', { skip: process.platform === 'win32' }, () => {
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
      resolveAgentCliWithLoginShell({ name: `stashbase-test-agent-${process.pid}`, envNames: [], logLabel: 'Test Agent' }),
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

test('the deferred startup pass probes the login shell; the boot pass never does', () => {
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

  // Synchronous boot pass: no probe, runtime invisible, no connect — boot
  // must stay quick and never spawn a shell.
  assert.equal(coordinator.connectIfInstalled('codex').phase, 'idle');
  assert.deepEqual(probes.at(-1), undefined);
  assert.equal(configured, 0);

  // Deferred pass: probes the login shell, finds the runtime, connects —
  // no waiting for the first New Chat.
  assert.equal(coordinator.connectIfInstalled('codex', { probeLoginShell: true }).phase, 'ready');
  assert.deepEqual(probes.at(-1), { probeLoginShell: true });
  assert.equal(configured, 1);
});
