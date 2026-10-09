import { telemetry } from './telemetry.ts';
/**
 * On-demand installation coordinator for application-scoped Agent runtimes.
 *
 * The coordinator is intentionally dependency-injected so the New Chat
 * bootstrap state machine can be tested without downloading a 300 MB binary,
 * touching provider credentials, or rewriting a real MCP config.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  consumeAgentSetupFailure,
  agentInstallerTempRoot,
  type NativeAgentId,
} from './agent-runtime-paths.ts';
import { probeAgentCommand } from './agent-probe.ts';
import { agentSetupDiagnostic } from './agent-setup-diagnostic.ts';
import { ensureAgentMcp } from './agent-mcp.ts';
import {
  agentCliEnv,
  agentCliOverride,
  agentCliNeedsShell,
  commandDir,
  resolveAgentCli,
  resolveAgentCliWithLoginShell,
  resolveNativeAgentCli,
} from './agent-cli.ts';
import { terminateExtractorTree as terminateInstallerTree, waitForExtractorTree } from './extractor-process.ts';
import type {
  AgentBootstrapFailureCode,
  AgentBootstrapFailureStage,
  AgentBootstrapManualRecovery,
  AgentBootstrapStatus,
  AgentBootstrapAction,
} from '../shared/agent-runtime.ts';

export type {
  AgentBootstrapFailure,
  AgentBootstrapFailureCode,
  AgentBootstrapFailureStage,
  AgentBootstrapManualRecovery,
  AgentBootstrapPhase,
  AgentBootstrapStatus,
} from '../shared/agent-runtime.ts';

type ProgressUpdate = Pick<AgentBootstrapStatus, 'progress' | 'message'>;

export interface AgentBootstrapDependencies {
  resolveExecutable(id: NativeAgentId, options?: { probeLoginShell?: boolean; signal?: AbortSignal }): string | null | Promise<string | null>;
  resolveNativeExecutable(id: NativeAgentId): string | null;
  installRuntime(id: NativeAgentId, update: (next: ProgressUpdate) => void, signal: AbortSignal): Promise<void>;
  isAuthenticated(id: NativeAgentId, executable: string, signal?: AbortSignal): boolean | Promise<boolean>;
  login(id: NativeAgentId, executable: string, signal: AbortSignal): Promise<void>;
  configureMcp(id: NativeAgentId): void;
  consumeFailure(stage: 'installation' | 'authentication' | 'mcp'): boolean;
}

const IDLE_STATUS: AgentBootstrapStatus = { phase: 'idle' };

export class AgentSetupBusyError extends Error { readonly status = 409; }

const INSTALLATION_TIMEOUT_MS = 8 * 60_000;
const ACTION_LABELS = { bootstrap: 'Install / connect', login: 'Sign in', update: 'Update', connect: 'Check' } as const;
const ACTION_PROGRESS = { bootstrap: 'setting up', login: 'signing in', update: 'updating', connect: 'checking its installation' } as const;

export class AgentBootstrapCoordinator {
  private readonly statuses = new Map<NativeAgentId, AgentBootstrapStatus>();
  private readonly controllers = new Map<NativeAgentId, AbortController>();
  private readonly runs = new Map<NativeAgentId, Promise<void>>();
  private readonly actions = new Map<NativeAgentId, AgentBootstrapAction | 'connect'>();

  constructor(
    private readonly dependencies: AgentBootstrapDependencies,
    private readonly limits = { installationTimeoutMs: INSTALLATION_TIMEOUT_MS },
  ) {}

  status(id: NativeAgentId): AgentBootstrapStatus {
    return this.statuses.get(id) ?? IDLE_STATUS;
  }

  begin(id: NativeAgentId): AgentBootstrapStatus {
    return this.start(id, 'bootstrap', { probeLoginShell: true });
  }

  login(id: NativeAgentId): AgentBootstrapStatus {
    return this.start(id, 'login', { probeLoginShell: true });
  }

  /** A provider refusal invalidates readiness without deleting its credentials. */
  requireSignIn(id: NativeAgentId, message: string): void {
    if (this.runs.has(id)) return;
    this.fail(id, 'login', 'authentication', 'authentication-required', new Error(message));
  }

  /** Startup and explicit recheck can repair installed runtimes, never download. */
  connectIfInstalled(id: NativeAgentId, options?: { probeLoginShell?: boolean }): AgentBootstrapStatus {
    return this.start(id, 'connect', options);
  }

  /** Run the official standalone installer, then reconnect authentication and
   * MCP using the verified native copy. Existing npm installations stay intact. */
  update(id: NativeAgentId): AgentBootstrapStatus {
    return this.start(id, 'update', { probeLoginShell: true });
  }

  private start(
    id: NativeAgentId,
    action: AgentBootstrapAction | 'connect',
    options?: { probeLoginShell?: boolean },
  ): AgentBootstrapStatus {
    if (this.runs.has(id)) {
      if (action !== 'connect' && action !== this.actions.get(id)) {
        const running = this.actions.get(id)!;
        throw new AgentSetupBusyError(`${agentLabel(id)} is already ${ACTION_PROGRESS[running]}. Wait for it to finish, then retry ${ACTION_LABELS[action]}.`);
      }
      return this.status(id);
    }
    // A failed first install can leave an executable behind. Retry must rerun
    // the installer and its verification instead of accepting that partial copy.
    const retryInstallation = action === 'bootstrap' && this.status(id).failure?.stage === 'installation';
    const controller = new AbortController();
    const { signal } = controller;
    this.controllers.set(id, controller);
    this.actions.set(id, action);
    this.statuses.set(id, {
      phase: action === 'login' ? 'authenticating' : action === 'update' ? 'installing' : 'configuring',
      message: `Checking ${agentLabel(id)}…`,
    });
    // Register ownership before calling any injected dependency. Discovery,
    // authentication, installation and login share cancellation and deduplication.
    const run = Promise.resolve().then(async () => {
      let stage: AgentBootstrapFailureStage = 'discovery';
      try {
        signal.throwIfAborted();
        let executable = await this.dependencies.resolveExecutable(id, { ...options, signal });
        signal.throwIfAborted();
        if (!executable || action === 'update' || retryInstallation) {
          if (action === 'connect') {
            this.statuses.set(id, IDLE_STATUS);
            return;
          }
          if (!executable && (action === 'login' || action === 'update')) {
            this.fail(id, action, 'discovery', 'runtime-unavailable', new Error(`${agentLabel(id)} is not installed.`));
            return;
          }
          stage = 'installation';
          if (this.dependencies.consumeFailure('installation')) {
            this.fail(id, action, stage, 'simulated', new Error('Simulated Agent installation failure.'));
            return;
          }
          this.statuses.set(id, { phase: 'installing', progress: 0, message: `${action === 'update' ? 'Updating' : 'Preparing'} ${agentLabel(id)}…` });
          const timer = setTimeout(() => controller.abort(new Error(
            `${agentLabel(id)} installation timed out after ${Math.ceil(this.limits.installationTimeoutMs / 60_000)} minutes. Retry to download and install again.`,
          )), this.limits.installationTimeoutMs);
          try {
            await this.dependencies.installRuntime(id, (next) => {
              if (!signal.aborted) this.statuses.set(id, { phase: 'installing', ...next });
            }, signal);
          } finally {
            clearTimeout(timer);
          }
          signal.throwIfAborted();
          executable = await this.dependencies.resolveExecutable(id, { signal });
          signal.throwIfAborted();
          if (!executable) {
            this.fail(id, action, stage, 'runtime-unavailable',
              new Error(`${agentLabel(id)} installation finished without a usable executable.`), 'install-command');
            return;
          }
          if (executable !== this.dependencies.resolveNativeExecutable(id)) {
            throw new Error(`${agentLabel(id)} native installation is not the selected executable. Check your executable override, then retry.`);
          }
        }
        stage = 'authentication';
        if (action === 'login') {
          this.statuses.set(id, { phase: 'authenticating', message: `Finish signing in to ${agentLabel(id)} in your browser…` });
          await this.dependencies.login(id, executable, signal);
          signal.throwIfAborted();
        }
        if (!await this.checkAuthentication(id, executable, action, signal)) return;
        signal.throwIfAborted();
        this.statuses.set(id, { phase: 'configuring', progress: 1, message: 'Connecting StashBase MCP…' });
        this.configure(id, action);
      } catch (error) {
        this.fail(id, action, stage, 'operation-failed', signal.aborted ? signal.reason : error, stage === 'installation' ? 'install-command' : undefined);
      }
    }).finally(() => {
      if (action !== 'connect') telemetry.capture({ event: 'agent_setup_result', runtime: id,
        stage: action === 'login' ? 'login' : action === 'update' ? 'update' : 'prepare',
        outcome: signal.aborted ? 'cancelled' : this.status(id).phase === 'ready' ? 'success' : 'failed' });
      this.controllers.delete(id);
      this.actions.delete(id);
      this.runs.delete(id);
    });
    this.runs.set(id, run);
    return this.status(id);
  }

  private async checkAuthentication(
    id: NativeAgentId, executable: string, action: AgentBootstrapAction | 'connect', signal: AbortSignal,
  ): Promise<boolean> {
    if (action === 'bootstrap' && id === 'codex' && this.dependencies.consumeFailure('authentication')) {
      this.fail(id, action, 'authentication', 'authentication-required', new Error('Simulated signed-out Codex runtime.'));
      return false;
    }
    try {
      const authenticated = await this.dependencies.isAuthenticated(id, executable, signal);
      signal.throwIfAborted();
      if (authenticated) return true;
      this.fail(id, action, 'authentication', 'authentication-required',
        new Error(`${agentLabel(id)} is installed, but it is not signed in.`));
    } catch (error) {
      this.fail(id, action, 'authentication', 'authentication-check-failed', error);
    }
    return false;
  }

  private configure(id: NativeAgentId, action: AgentBootstrapAction | 'connect'): void {
    if (action !== 'connect' && this.dependencies.consumeFailure('mcp')) {
      this.fail(id, action, 'mcp', 'simulated', new Error('Simulated MCP configuration failure.'));
      return;
    }
    try {
      this.dependencies.configureMcp(id);
      this.statuses.set(id, { phase: 'ready', progress: 1, message: `${agentLabel(id)} is ready.` });
    } catch (error) {
      this.fail(id, action, 'mcp', 'operation-failed', error, 'mcp-settings');
    }
  }

  async wait(id: NativeAgentId): Promise<AgentBootstrapStatus> {
    await this.runs.get(id);
    return this.status(id);
  }

  async cancelAll(): Promise<NativeAgentId[]> {
    const ids = [...this.runs.keys()];
    for (const id of ids) this.controllers.get(id)?.abort();
    await Promise.allSettled(ids.map((id) => this.runs.get(id)));
    return ids;
  }

  private fail(
    id: NativeAgentId,
    action: AgentBootstrapAction | 'connect',
    stage: AgentBootstrapFailureStage,
    code: AgentBootstrapFailureCode,
    error: unknown,
    manualRecovery?: AgentBootstrapManualRecovery,
  ): void {
    const message = agentSetupDiagnostic(error);
    this.statuses.set(id, {
      phase: 'failed',
      failure: {
        stage,
        code,
        message: `${agentLabel(id)} · ${ACTION_LABELS[action]} · ${stage}\n${message}`,
        retryable: true,
        manualRecovery,
        retryAction: action === 'connect' ? 'bootstrap' : action,
      },
    });
  }
}

function agentLabel(id: NativeAgentId): string {
  return id === 'codex' ? 'Codex' : 'Claude';
}

function agentCliSpec(id: NativeAgentId) {
  return id === 'codex'
    ? { name: 'codex', envNames: ['STASHBASE_CODEX_BIN', 'CODEX_CLI_BIN', 'CODEX_CLI_PATH'], logLabel: 'Codex' }
    : { name: 'claude', envNames: ['STASHBASE_CLAUDE_BIN', 'CLAUDE_CODE_BIN'], logLabel: 'Claude' };
}

function resolveInstalledExecutable(id: NativeAgentId): string | null {
  return resolveAgentCli(agentCliSpec(id));
}

/** Ask the selected CLI before declaring readiness; this never starts login. */
export async function agentIsAuthenticated(
  id: NativeAgentId, executable: string, signal?: AbortSignal,
): Promise<boolean> {
  const result = await probeAgentCommand(executable, id === 'claude' ? ['auth', 'status'] : ['login', 'status'], {
    timeoutMs: 10_000,
    signal,
    shell: agentCliNeedsShell(executable),
    env: agentCliEnv({}, [commandDir(executable)]),
  });
  const output = `${result.stdout}\n${result.stderr}`.replace(/\s+/g, ' ').trim().slice(-800);
  if (result.status === 0) return true;
  if (result.status === 1 && (id === 'claude' ? /"loggedIn"\s*:\s*false/.test(output) : /not logged in/i.test(output))) return false;
  throw new Error(`Could not check ${agentLabel(id)} sign-in using ${executable} (exit ${result.status ?? 'unknown'}${output ? `: ${output}` : ''}).`);
}

const AGENT_LOGIN_TIMEOUT_MS = 10 * 60_000;

/** Run the Agent's own browser-based login. The selected CLI opens the provider
 * page and writes credentials to its normal home; no token passes through
 * StashBase. */
export async function loginToAgent(
  id: NativeAgentId,
  executable: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const label = agentLabel(id);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, id === 'claude' ? ['auth', 'login'] : ['login'], {
      env: agentCliEnv({}, [commandDir(executable)]),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: agentCliNeedsShell(executable),
    });
    const completion = waitForExtractorTree(child);
    let output = '';
    let settled = false;
    let timedOut = false;
    const append = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => terminateInstallerTree(child);
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateInstallerTree(child);
    }, AGENT_LOGIN_TIMEOUT_MS);
    timeout.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    void completion.then((code) => {
      const detail = output.replace(/\s+/g, ' ').trim().slice(-800);
      if (signal.aborted) finish(new Error(`${label} sign-in was cancelled.`));
      else if (code === 0) finish();
      else if (timedOut) finish(new Error(`${label} sign-in timed out after 10 minutes. Retry to open sign-in again.`));
      else finish(new Error(detail || `${label} sign-in exited with code ${code ?? 'unknown'}.`));
    }, (error) => finish(error));
  });
}

export const agentBootstrapCoordinator = new AgentBootstrapCoordinator({
  resolveExecutable: (id, options) => options?.probeLoginShell
    ? resolveAgentCliWithLoginShell(agentCliSpec(id), undefined, options.signal)
    : resolveInstalledExecutable(id),
  resolveNativeExecutable: resolveNativeAgentCli,
  installRuntime: installNativeRuntime,
  isAuthenticated: agentIsAuthenticated,
  login: loginToAgent,
  configureMcp: (id) => { ensureAgentMcp(id); },
  consumeFailure: consumeAgentSetupFailure,
});

export function agentBootstrapStatus(id: NativeAgentId): AgentBootstrapStatus {
  return agentBootstrapCoordinator.status(id);
}

export function beginAgentBootstrap(id: NativeAgentId): AgentBootstrapStatus {
  return agentBootstrapCoordinator.begin(id);
}

export function loginAgentBootstrap(id: NativeAgentId): AgentBootstrapStatus {
  return agentBootstrapCoordinator.login(id);
}

/** Updates use each provider's standalone installer. Explicit executable
 * overrides outside that layout cannot be replaced by an in-app update. */
export function agentSupportsInAppUpdate(id: NativeAgentId): boolean {
  const override = agentCliOverride(agentCliSpec(id));
  return !override || override === resolveNativeAgentCli(id);
}

/** Explicit user recovery when the installed runtime is too old for what a
 * chat asked of it: install and select the provider's native copy. */
export function updateAgentBootstrap(id: NativeAgentId): AgentBootstrapStatus {
  if (!agentSupportsInAppUpdate(id)) throw new Error(`Remove the ${agentLabel(id)} executable override before updating its native installation.`);
  return agentBootstrapCoordinator.update(id);
}

/** Explicit user recovery after fixing an installation outside StashBase.
 * Re-run discovery (including the login-shell probe) and MCP preparation for
 * an executable that now exists, but never authorize another download. */
export function recheckAgentBootstrap(id: NativeAgentId): AgentBootstrapStatus {
  return agentBootstrapCoordinator.connectIfInstalled(id, { probeLoginShell: true });
}

/** One asynchronous startup pass includes login-shell discovery. */
export async function connectInstalledAgentMcpOnStartup(): Promise<Array<{ id: NativeAgentId; status: AgentBootstrapStatus }>> {
  return Promise.all((['codex', 'claude'] as const).map(async (id) => {
    agentBootstrapCoordinator.connectIfInstalled(id, { probeLoginShell: true });
    return { id, status: await agentBootstrapCoordinator.wait(id) };
  }));
}

export function cancelAgentRuntimeInstalls(): Promise<NativeAgentId[]> {
  return agentBootstrapCoordinator.cancelAll();
}

async function installNativeRuntime(
  id: NativeAgentId,
  update: (next: ProgressUpdate) => void,
  signal: AbortSignal,
): Promise<void> {
  if (id === 'claude') return installClaude(update, signal);
  return installCodex(update, signal);
}

const CLAUDE_INSTALLER = process.platform === 'win32'
  ? 'https://claude.ai/install.ps1'
  : 'https://claude.ai/install.sh';

/** Claude's official installer script is written for bash (it relies on
 * `[[ ]]` and regex matching); Windows shares the Codex PowerShell
 * selection. */
export function resolveClaudeInstallerShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isFile: (candidate: string) => boolean = regularFile,
): CodexInstallerShell {
  const shell = resolveCodexInstallerShell(platform, env, isFile);
  return shell.kind === 'posix' ? { ...shell, command: '/bin/bash' } : shell;
}

export async function installClaude(
  update: (next: ProgressUpdate) => void,
  signal: AbortSignal,
  dependencies: Partial<AgentInstallDependencies> = {},
): Promise<void> {
  const verifyExecutable = dependencies.verifyExecutable ?? verifyAgentExecutable;
  const resolveInstallerShell = dependencies.resolveInstallerShell ?? resolveClaudeInstallerShell;
  const runScript = dependencies.runInstallerScript ?? claudeInstallerScriptRunner;
  const resolveInstalled = dependencies.resolveInstalledExecutable
    ?? (() => resolveNativeAgentCli('claude'));
  update({ message: 'Downloading the official Claude installer…' });
  const script = await fetchBoundedText(CLAUDE_INSTALLER, signal, 2_000_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
  };
  const shell = resolveInstallerShell();
  await runScript(shell, script, env, signal, (line) => {
    const message = line.trim();
    if (message) update({ message });
  });
  const executable = resolveInstalled();
  if (!executable) {
    throw new Error(
      "The official Claude installer exited successfully but no 'claude' executable "
      + 'was found in its standard install locations (such as ~/.local/bin). '
      + 'Check whether security software quarantined Claude, then retry the installation.',
    );
  }
  await verifyExecutable(executable, 'Claude', agentCliEnv(), 20_000, signal);
  // Unlike Codex's Windows installer, `claude.exe install` leaves its bin
  // dir off the user Path, so the CLI would be invisible to the user's own
  // terminal (StashBase discovery scans the directory and is unaffected).
  if (process.platform === 'win32') ensureWindowsClaudeOnUserPath(update);
  update({ progress: 1, message: 'Claude installed.' });
}

const WINDOWS_LOCAL_BIN_RAW = '%USERPROFILE%\\.local\\bin';

/** Additively repair the per-user Path so a fresh Claude install is usable
 * from the user's own terminal. Reads the raw (unexpanded) registry value,
 * appends the raw `%USERPROFILE%` entry only when no existing entry expands
 * to the same directory, writes back as REG_EXPAND_SZ so other entries keep
 * their variable forms, and broadcasts the environment change so newly
 * opened shells see it. Never uses `setx` (it truncates at 1024 chars) and
 * never removes or reorders entries. */
export function windowsUserPathRepairScript(rawEntry = WINDOWS_LOCAL_BIN_RAW): string {
  return [
    '$ErrorActionPreference = "Stop"',
    `$entry = '${rawEntry}'`,
    'if (-not (Test-Path HKCU:\\Environment)) { $null = New-Item -Path HKCU:\\Environment }',
    '$key = Get-Item HKCU:\\Environment',
    "$raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
    "$expandedEntry = [Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\\')",
    '$has = $false',
    "foreach ($part in ($raw -split ';')) {",
    "  if ($part -and ([Environment]::ExpandEnvironmentVariables($part).TrimEnd('\\') -ieq $expandedEntry)) { $has = $true }",
    '}',
    'if (-not $has) {',
    "  $next = if ($raw) { $raw.TrimEnd(';') + ';' + $entry } else { $entry }",
    "  Set-ItemProperty -Path HKCU:\\Environment -Name Path -Value $next -Type ExpandString",
    '}',
    '$signature = \'[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);\'',
    '$native = Add-Type -MemberDefinition $signature -Name PathBroadcast -Namespace StashBase -PassThru',
    '$result = [UIntPtr]::Zero',
    '$null = $native::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)',
  ].join('\r\n');
}

function ensureWindowsClaudeOnUserPath(update: (next: ProgressUpdate) => void): void {
  const shell = resolveCodexInstallerShell();
  const result = spawnSync(
    shell.command,
    ['-NoProfile', '-NonInteractive', '-Command', windowsUserPathRepairScript()],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  if (result.status === 0) {
    update({ message: 'Added %USERPROFILE%\\.local\\bin to your PATH — open a new terminal to use claude.' });
  } else {
    // The install itself succeeded and StashBase can use it either way;
    // terminal visibility falls back to the manual step.
    update({ message: 'Claude installed. To use it from a terminal, add %USERPROFILE%\\.local\\bin to your PATH.' });
  }
}

function claudeInstallerScriptRunner(
  shell: CodexInstallerShell,
  script: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  return runInstallerScript(shell, script, env, signal, onLine, {
    tempRoot: agentInstallerTempRoot('claude'),
    bootstrap: CLAUDE_PS1_BOOTSTRAP,
  });
}

const CODEX_INSTALLER = process.platform === 'win32'
  ? 'https://chatgpt.com/codex/install.ps1'
  : 'https://chatgpt.com/codex/install.sh';

export interface CodexInstallerShell {
  command: string;
  args: string[];
  kind: 'posix' | 'powershell-7' | 'windows-powershell';
}

type AgentExecutableVerifier = (
  executable: string,
  label: string,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
  signal?: AbortSignal,
) => void | Promise<void>;

type InstallerScriptRunner = (
  shell: CodexInstallerShell,
  script: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onLine: (line: string) => void,
) => Promise<void>;

export interface AgentInstallDependencies {
  verifyExecutable: AgentExecutableVerifier;
  resolveInstallerShell: () => CodexInstallerShell;
  runInstallerScript: InstallerScriptRunner;
  /** Post-install discovery of the freshly installed native executable in
   * the official user-level locations (`~/.local/bin`, the official
   * Windows standalone bin). Injected by tests so a developer machine's own
   * CLIs can never satisfy an install check. */
  resolveInstalledExecutable: () => string | null;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? env[key] : undefined;
  return typeof value === 'string' ? value : '';
}

function regularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveCodexInstallerShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isFile: (candidate: string) => boolean = regularFile,
): CodexInstallerShell {
  if (platform !== 'win32') return { command: '/bin/sh', args: [], kind: 'posix' };

  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
  const candidates: string[] = [];
  const pathValue = environmentValue(env, 'PATH');
  for (const entry of pathValue.split(path.win32.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (dir) candidates.push(path.win32.join(dir, 'pwsh.exe'));
  }
  for (const name of ['ProgramW6432', 'ProgramFiles']) {
    const programFiles = environmentValue(env, name);
    if (programFiles) candidates.push(path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isFile(candidate)) return { command: candidate, args, kind: 'powershell-7' };
  }

  const systemRoot = environmentValue(env, 'SystemRoot');
  const windowsPowerShell = systemRoot
    ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  return {
    command: isFile(windowsPowerShell) ? windowsPowerShell : 'powershell.exe',
    args,
    kind: 'windows-powershell',
  };
}

function codexInstallerFailure(error: unknown, shell: CodexInstallerShell): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (
    shell.kind === 'windows-powershell'
    && /property\s+['"]OSArchitecture['"]\s+cannot be found/i.test(failure.message)
  ) {
    return new Error(
      'The official Codex installer is incompatible with Windows PowerShell 5.1 on this PC. '
      + 'Install PowerShell 7 (pwsh.exe), then retry.',
    );
  }
  return failure;
}

export async function installCodex(
  update: (next: ProgressUpdate) => void,
  signal: AbortSignal,
  dependencies: Partial<AgentInstallDependencies> = {},
): Promise<void> {
  const verifyExecutable = dependencies.verifyExecutable ?? verifyAgentExecutable;
  const resolveInstallerShell = dependencies.resolveInstallerShell ?? resolveCodexInstallerShell;
  const runScript = dependencies.runInstallerScript ?? codexInstallerScriptRunner;
  const resolveInstalled = dependencies.resolveInstalledExecutable
    ?? (() => resolveNativeAgentCli('codex'));
  update({ message: 'Downloading the official Codex installer…' });
  const script = await fetchBoundedText(CODEX_INSTALLER, signal, 2_000_000);
  // The official installer owns its layout and the user's PATH profile:
  // strip any inherited pinning so a stale desktop environment can never
  // redirect it into a private, terminal-invisible location.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_INSTALL_DIR: undefined,
    CODEX_HOME: undefined,
    CODEX_NON_INTERACTIVE: 'true',
    ELECTRON_RUN_AS_NODE: undefined,
  };
  const shell = resolveInstallerShell();
  try {
    await runScript(shell, script, env, signal, (line) => {
      const message = line.replace(/^==>\s*/, '').trim();
      if (!message) return;
      update({
        message: /^Downloading Codex CLI$/i.test(message)
          ? 'Downloading Codex CLI… this may take several minutes.'
          : message,
      });
    });
  } catch (error) {
    throw codexInstallerFailure(error, shell);
  }
  const executable = resolveInstalled();
  if (!executable) {
    throw new Error(
      "The official Codex installer exited successfully but no 'codex' executable "
      + 'was found in its standard install locations (such as ~/.local/bin). '
      + 'Check whether security software quarantined Codex, then retry the installation.',
    );
  }
  await verifyExecutable(executable, 'Codex', agentCliEnv(), 20_000, signal);
  update({ progress: 1, message: 'Codex installed.' });
}

function codexInstallerScriptRunner(
  shell: CodexInstallerShell,
  script: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  return runInstallerScript(shell, script, env, signal, onLine, {
    tempRoot: agentInstallerTempRoot('codex'),
    bootstrap: CODEX_PS1_BOOTSTRAP,
  });
}

async function fetchBoundedText(url: string, signal: AbortSignal, maxBytes: number): Promise<string> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  try {
    const response = await fetch(url, { signal: bounded, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error('Installer exceeded its size limit.');
        chunks.push(value);
      }
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    throw new Error(`Download failed from ${new URL(url).host}: ${agentSetupDiagnostic(bounded.aborted ? bounded.reason : error)}`);
  }
}

export async function verifyAgentExecutable(
  executable: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await probeAgentCommand(executable, ['--version'], {
      env, timeoutMs, signal, shell: agentCliNeedsShell(executable),
    });
    if (result.status !== 0) {
      throw new Error(`exited with code ${result.status ?? 'unknown'}: ${[result.stderr, result.stdout].filter(Boolean).join('\n').trim()}`);
    }
  } catch (error) {
    throw new Error(`${label} was downloaded but did not pass its executable check at ${executable}: ${agentSetupDiagnostic(error)}`);
  }
}

async function runInstallerScript(
  shell: CodexInstallerShell,
  script: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onLine: (line: string) => void,
  options: { tempRoot: string; bootstrap: readonly string[] },
): Promise<void> {
  signal.throwIfAborted();
  let scriptDir: string | null = null;
  let scriptFile: string | null = null;
  if (shell.kind !== 'posix') {
    fs.mkdirSync(options.tempRoot, { recursive: true, mode: 0o700 });
    scriptDir = fs.mkdtempSync(path.join(options.tempRoot, '.installer-script.'));
    scriptFile = path.join(scriptDir, 'install.ps1');
    fs.writeFileSync(scriptFile, agentPowerShellInstallerScript(script, options.bootstrap), { mode: 0o600 });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(shell.command, scriptFile ? [...shell.args, scriptFile] : shell.args, {
        env,
        // POSIX cancellation addresses the installer process group by negative
        // PID. Windows uses taskkill /T instead, so keeping pwsh attached makes
        // its close event represent the script host that actually ran -File.
        detached: shell.kind === 'posix',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const completion = waitForExtractorTree(child);
      let output = '';
      let buffered = '';
      const append = (chunk: string) => { output = (output + chunk).slice(-4000); };
      const abort = () => terminateInstallerTree(child);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        append(chunk);
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = (lines.pop() ?? '').slice(-4000);
        for (const line of lines) onLine(agentSetupDiagnostic(line));
      });
      child.stderr.on('data', append);
      void completion.then((code) => {
        signal.removeEventListener('abort', abort);
        if (buffered.trim()) onLine(agentSetupDiagnostic(buffered));
        if (signal.aborted) reject(new Error('Agent installation was cancelled.'));
        else if (code === 0) resolve();
        else reject(new Error(`Official Agent installer exited with code ${code ?? 'unknown'}.\n${output.trim()}`));
      }, (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') append(error.message);
      });
      if (scriptFile) child.stdin.end();
      else child.stdin.end(script);
    });
  } finally {
    if (scriptDir) {
      try {
        fs.rmSync(scriptDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // The downloaded public installer contains no credentials. A transient
        // Windows lock must not replace the installation result that matters.
      }
    }
  }
}

/** The official installers own their standard install layout and the user's
 * PATH. The Windows bootstrap only enforces failure propagation, strips
 * environment that could redirect or derail the install (stale managed
 * pinning from older StashBase versions, the Electron node marker), and pins
 * non-interactive mode. Windows environment keys are case-insensitive and
 * packaged desktop processes can inherit stale or duplicate variants.
 * Executing one file also avoids a nested script invocation that can return
 * success without running its target on some packaged Windows
 * environments. */
export const CODEX_PS1_BOOTSTRAP = [
  '$ErrorActionPreference = "Stop"',
  'Remove-Item Env:\\CODEX_INSTALL_DIR -ErrorAction SilentlyContinue',
  'Remove-Item Env:\\CODEX_HOME -ErrorAction SilentlyContinue',
  '$env:CODEX_NON_INTERACTIVE = "true"',
  'Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
] as const;

export const CLAUDE_PS1_BOOTSTRAP = [
  '$ErrorActionPreference = "Stop"',
  'Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
] as const;

export function agentPowerShellInstallerScript(
  installerScript: string,
  bootstrapLines: readonly string[],
): string {
  const bootstrap = [...bootstrapLines, ''].join('\r\n');
  // PowerShell requires `param(...)` to be the script's first statement, so
  // the bootstrap must insert AFTER the parameter declaration. Codex declares
  // `[CmdletBinding()]` before its block; Claude opens with a bare multi-line
  // `param(` whose closing parenthesis starts its own line. Prepending the
  // bootstrap ahead of a param block turns `param` into an unknown command.
  const parameterBlock = installerScript.match(
    /^(?:\uFEFF)?\s*(?:\[CmdletBinding\(\)\]\s*\r?\n)?param\([\s\S]*?\r?\n\)\s*\r?\n/,
  )?.[0];
  if (!parameterBlock) return bootstrap + installerScript;
  return parameterBlock + bootstrap + installerScript.slice(parameterBlock.length);
}
