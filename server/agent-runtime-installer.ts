/**
 * On-demand installation coordinator for application-scoped Agent runtimes.
 *
 * The coordinator is intentionally dependency-injected so the New Chat
 * bootstrap state machine can be tested without downloading a 300 MB binary,
 * touching provider credentials, or rewriting a real MCP config.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  consumeAgentSetupFailure,
  managedAgentExecutable,
  managedAgentRuntimeRoot,
  managedClaudeReleasesDir,
  managedCodexBinDir,
  managedCodexInstallerHome,
  writeManagedClaudeManifest,
  type ManagedAgentId,
} from './agent-runtime-paths.ts';
import { ensureAgentMcp } from './agent-mcp.ts';
import {
  agentCliEnv,
  agentCliNeedsShell,
  commandDir,
  resolveAgentCli,
  resolveAgentCliWithLoginShell,
} from './agent-cli.ts';
import { terminateExtractorTree as terminateInstallerTree } from './extractor-process.ts';

export type AgentBootstrapPhase = 'idle' | 'installing' | 'authenticating' | 'configuring' | 'ready' | 'failed';
export type AgentBootstrapFailureStage = 'discovery' | 'installation' | 'authentication' | 'mcp';
export type AgentBootstrapFailureCode =
  | 'simulated'
  | 'operation-failed'
  | 'runtime-unavailable'
  | 'authentication-required'
  | 'authentication-check-failed';
export type AgentBootstrapManualRecovery = 'install-command' | 'mcp-settings';

export interface AgentBootstrapFailure {
  stage: AgentBootstrapFailureStage;
  code: AgentBootstrapFailureCode;
  message: string;
  retryable: boolean;
  manualRecovery?: AgentBootstrapManualRecovery;
}

export interface AgentBootstrapStatus {
  phase: AgentBootstrapPhase;
  progress?: number;
  message?: string;
  failure?: AgentBootstrapFailure;
}

type ProgressUpdate = Pick<AgentBootstrapStatus, 'progress' | 'message'>;

export interface AgentBootstrapDependencies {
  resolveExecutable(id: ManagedAgentId, options?: { probeLoginShell?: boolean }): string | null;
  installRuntime(id: ManagedAgentId, update: (next: ProgressUpdate) => void, signal: AbortSignal): Promise<void>;
  isAuthenticated(id: ManagedAgentId, executable: string): boolean;
  login(id: ManagedAgentId, executable: string, signal: AbortSignal): Promise<void>;
  configureMcp(id: ManagedAgentId): void;
  consumeFailure(stage: 'installation' | 'mcp'): boolean;
}

const IDLE_STATUS: AgentBootstrapStatus = { phase: 'idle' };

export class AgentBootstrapCoordinator {
  private readonly statuses = new Map<ManagedAgentId, AgentBootstrapStatus>();
  private readonly controllers = new Map<ManagedAgentId, AbortController>();
  private readonly runs = new Map<ManagedAgentId, Promise<void>>();

  constructor(private readonly dependencies: AgentBootstrapDependencies) {}

  status(id: ManagedAgentId): AgentBootstrapStatus {
    return this.statuses.get(id) ?? IDLE_STATUS;
  }

  begin(id: ManagedAgentId): AgentBootstrapStatus {
    if (this.runs.has(id)) return this.status(id);
    let executable: string | null;
    try {
      executable = this.dependencies.resolveExecutable(id, { probeLoginShell: true });
    } catch (error) {
      this.fail(id, 'discovery', 'operation-failed', error);
      return this.status(id);
    }
    if (executable) {
      this.prepare(id, executable);
      return this.status(id);
    }

    if (this.dependencies.consumeFailure('installation')) {
      this.fail(id, 'installation', 'simulated', new Error('Simulated Agent installation failure.'));
      return this.status(id);
    }

    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.statuses.set(id, { phase: 'installing', progress: 0, message: `Preparing ${agentLabel(id)}…` });
    const run = (async () => {
      // Yield once so `runs` owns the promise before even a simulated or
      // synchronous installer failure reaches the cleanup block.
      await Promise.resolve();
      try {
        await this.dependencies.installRuntime(id, (next) => {
          this.statuses.set(id, { phase: 'installing', ...next });
        }, controller.signal);
      } catch (error) {
        this.fail(id, 'installation', 'operation-failed', error, 'install-command');
        return;
      }
      let installedExecutable: string | null;
      try {
        installedExecutable = this.dependencies.resolveExecutable(id);
      } catch (error) {
        this.fail(id, 'installation', 'operation-failed', error, 'install-command');
        return;
      }
      if (!installedExecutable) {
        this.fail(
          id,
          'installation',
          'runtime-unavailable',
          new Error(`${agentLabel(id)} installation finished without a usable executable.`),
          'install-command',
        );
        return;
      }
      this.statuses.set(id, { phase: 'configuring', progress: 1, message: 'Connecting StashBase MCP…' });
      this.prepare(id, installedExecutable);
    })().finally(() => {
      this.controllers.delete(id);
      this.runs.delete(id);
    });
    this.runs.set(id, run);
    return this.status(id);
  }

  /** Start the provider-owned browser login with the exact executable that
   * discovery selected. Credentials remain in Codex's normal account home;
   * StashBase owns only the child-process lifecycle and readiness state. */
  login(id: ManagedAgentId): AgentBootstrapStatus {
    if (this.runs.has(id)) return this.status(id);
    let executable: string | null;
    try {
      executable = this.dependencies.resolveExecutable(id, { probeLoginShell: true });
    } catch (error) {
      this.fail(id, 'discovery', 'operation-failed', error);
      return this.status(id);
    }
    if (!executable) {
      this.fail(id, 'discovery', 'runtime-unavailable', new Error(`${agentLabel(id)} is not installed.`));
      return this.status(id);
    }
    if (id !== 'codex') {
      this.fail(id, 'authentication', 'operation-failed', new Error('In-app login is not supported for this Agent.'));
      return this.status(id);
    }

    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.statuses.set(id, {
      phase: 'authenticating',
      message: 'Finish signing in to Codex in your browser…',
    });
    const run = this.dependencies.login(id, executable, controller.signal).then(() => {
      if (!this.checkAuthentication(id, executable)) return;
      this.statuses.set(id, { phase: 'configuring', progress: 1, message: 'Connecting StashBase MCP…' });
      this.configure(id);
    }).catch((error) => {
      this.fail(id, 'authentication', 'operation-failed', error);
    }).finally(() => {
      this.controllers.delete(id);
      this.runs.delete(id);
    });
    this.runs.set(id, run);
    return this.status(id);
  }

  private prepare(id: ManagedAgentId, executable: string, allowSimulation = true): void {
    if (!this.checkAuthentication(id, executable)) return;
    this.configure(id, allowSimulation);
  }

  private checkAuthentication(id: ManagedAgentId, executable: string): boolean {
    try {
      if (this.dependencies.isAuthenticated(id, executable)) return true;
      this.fail(
        id,
        'authentication',
        'authentication-required',
        new Error(`${agentLabel(id)} is installed, but it is not signed in.`),
      );
    } catch (error) {
      this.fail(id, 'authentication', 'authentication-check-failed', error);
    }
    return false;
  }

  private configure(id: ManagedAgentId, allowSimulation = true): void {
    if (allowSimulation && this.dependencies.consumeFailure('mcp')) {
      this.fail(id, 'mcp', 'simulated', new Error('Simulated MCP configuration failure.'));
      return;
    }
    try {
      this.dependencies.configureMcp(id);
      this.statuses.set(id, { phase: 'ready', progress: 1, message: `${agentLabel(id)} is ready.` });
    } catch (error) {
      this.fail(id, 'mcp', 'operation-failed', error, 'mcp-settings');
    }
  }

  /** App startup may check authentication and repair MCP for runtimes it can
   * already discover, but it must never turn discovery into an implicit
   * download or login. The first post-bind pass skips login-shell probing; a
   * deferred pass repeats it WITH the probe (see
   * `connectInstalledAgentMcpAfterBoot`), so a system runtime that only a
   * login shell can resolve still auto-connects without waiting for the
   * first New Chat. */
  connectIfInstalled(id: ManagedAgentId, options?: { probeLoginShell?: boolean }): AgentBootstrapStatus {
    if (this.runs.has(id)) return this.status(id);
    let executable: string | null;
    try {
      executable = this.dependencies.resolveExecutable(id, options);
    } catch (error) {
      this.fail(id, 'discovery', 'operation-failed', error);
      return this.status(id);
    }
    if (!executable) return this.status(id);
    // Startup repair is background maintenance, not the explicit setup action
    // targeted by the development `nextFailure` control.
    this.prepare(id, executable, false);
    return this.status(id);
  }

  async reset(id: ManagedAgentId): Promise<void> {
    this.controllers.get(id)?.abort();
    await this.runs.get(id);
    this.statuses.delete(id);
  }

  async wait(id: ManagedAgentId): Promise<AgentBootstrapStatus> {
    await this.runs.get(id);
    return this.status(id);
  }

  async cancelAll(): Promise<ManagedAgentId[]> {
    const ids = [...this.runs.keys()];
    for (const id of ids) this.controllers.get(id)?.abort();
    await Promise.allSettled(ids.map((id) => this.runs.get(id)));
    return ids;
  }

  private fail(
    id: ManagedAgentId,
    stage: AgentBootstrapFailureStage,
    code: AgentBootstrapFailureCode,
    error: unknown,
    manualRecovery?: AgentBootstrapManualRecovery,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.statuses.set(id, {
      phase: 'failed',
      failure: {
        stage,
        code,
        message: message.slice(0, 1000),
        retryable: true,
        manualRecovery,
      },
    });
  }
}

function agentLabel(id: ManagedAgentId): string {
  return id === 'codex' ? 'Codex' : 'Claude Code';
}

function resolveManagedOrSystemExecutable(
  id: ManagedAgentId,
  options?: { probeLoginShell?: boolean },
): string | null {
  const resolver = options?.probeLoginShell ? resolveAgentCliWithLoginShell : resolveAgentCli;
  return resolver(id === 'codex'
    ? { name: 'codex', envNames: ['STASHBASE_CODEX_BIN', 'CODEX_CLI_BIN', 'CODEX_CLI_PATH'], logLabel: 'Codex' }
    : { name: 'claude', envNames: ['STASHBASE_CLAUDE_BIN', 'CLAUDE_CODE_BIN'], logLabel: 'Claude Code' });
}

/** Claude reports authentication through its native SDK connection. Codex
 * exposes a cheap, side-effect-free status command, so preparation can stop
 * before opening an app-server that cannot serve a turn. */
export function agentIsAuthenticated(id: ManagedAgentId, executable: string): boolean {
  if (id !== 'codex') return true;
  const timeoutMs = 10_000;
  const result = spawnSync(executable, ['login', 'status'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: agentCliNeedsShell(executable),
    env: agentCliEnv({}, [commandDir(executable)]),
  });
  const output = [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-800);
  if (result.status === 0) return true;
  if (result.status === 1 && /not logged in/i.test(output)) return false;
  const nativeError = result.error as NodeJS.ErrnoException | undefined;
  let detail: string;
  if (nativeError?.code === 'ETIMEDOUT') detail = `timed out after ${timeoutMs}ms`;
  else if (nativeError) detail = `could not start: ${nativeError.message}`;
  else if (result.status !== null) detail = `exited with code ${result.status}`;
  else if (result.signal) detail = `terminated by ${result.signal}`;
  else detail = 'returned no exit status';
  throw new Error(`Could not check Codex sign-in (${detail}${output ? `: ${output}` : ''}).`);
}

const CODEX_LOGIN_TIMEOUT_MS = 10 * 60_000;

/** Run Codex's own browser-based login. The selected CLI opens the provider
 * page and writes credentials to its normal home; no token passes through
 * StashBase. */
export async function loginToAgent(
  id: ManagedAgentId,
  executable: string,
  signal: AbortSignal,
): Promise<void> {
  if (id !== 'codex') throw new Error('In-app login is available only for Codex.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['login'], {
      env: agentCliEnv({}, [commandDir(executable)]),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: agentCliNeedsShell(executable),
    });
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
    }, CODEX_LOGIN_TIMEOUT_MS);
    timeout.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      const detail = output.replace(/\s+/g, ' ').trim().slice(-800);
      if (signal.aborted) finish(new Error('Codex sign-in was cancelled.'));
      else if (code === 0) finish();
      else if (timedOut) finish(new Error('Codex sign-in timed out after 10 minutes.'));
      else finish(new Error(detail || `Codex sign-in exited with code ${code ?? 'unknown'}.`));
    });
  });
}

export const agentBootstrapCoordinator = new AgentBootstrapCoordinator({
  resolveExecutable: resolveManagedOrSystemExecutable,
  installRuntime: installManagedRuntime,
  isAuthenticated: agentIsAuthenticated,
  login: loginToAgent,
  configureMcp: (id) => { ensureAgentMcp(id); },
  consumeFailure: consumeAgentSetupFailure,
});

export function agentBootstrapStatus(id: ManagedAgentId): AgentBootstrapStatus {
  return agentBootstrapCoordinator.status(id);
}

export function beginAgentBootstrap(id: ManagedAgentId): AgentBootstrapStatus {
  return agentBootstrapCoordinator.begin(id);
}

export function loginAgentBootstrap(id: ManagedAgentId): AgentBootstrapStatus {
  return agentBootstrapCoordinator.login(id);
}

/** Explicit user recovery after fixing an installation outside StashBase.
 * Re-run discovery (including the login-shell probe) and MCP preparation for
 * an executable that now exists, but never authorize another download. */
export function recheckAgentBootstrap(id: ManagedAgentId): AgentBootstrapStatus {
  return agentBootstrapCoordinator.connectIfInstalled(id, { probeLoginShell: true });
}

export function connectInstalledAgentMcpOnStartup(): Array<{ id: ManagedAgentId; status: AgentBootstrapStatus }> {
  return (['codex', 'claude'] as const).map((id) => ({
    id,
    status: agentBootstrapCoordinator.connectIfInstalled(id),
  }));
}

/** The deferred second startup pass, WITH the login-shell probe: system
 * runtimes that only a login shell can resolve (nvm/homebrew paths) still
 * auto-connect shortly after boot instead of waiting for the first New
 * Chat. Runs off the listen path — the probe spawns a shell. */
export function connectInstalledAgentMcpAfterBoot(): Array<{ id: ManagedAgentId; status: AgentBootstrapStatus }> {
  return (['codex', 'claude'] as const).map((id) => ({
    id,
    status: agentBootstrapCoordinator.connectIfInstalled(id, { probeLoginShell: true }),
  }));
}

export function resetAgentBootstrap(id: ManagedAgentId): Promise<void> {
  return agentBootstrapCoordinator.reset(id);
}

export function cancelAgentRuntimeInstalls(): Promise<ManagedAgentId[]> {
  return agentBootstrapCoordinator.cancelAll();
}

export function claudePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = platform === 'linux' && isMuslLinux(),
): string {
  const normalizedArch = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : '';
  if (!normalizedArch || !['darwin', 'linux', 'win32'].includes(platform)) {
    throw new Error(`Claude Code does not publish a managed runtime for ${platform}/${arch}.`);
  }
  return `${platform}-${normalizedArch}${platform === 'linux' && musl ? '-musl' : ''}`;
}

function isMuslLinux(): boolean {
  if (process.platform !== 'linux') return false;
  if (fs.existsSync('/lib/libc.musl-x86_64.so.1') || fs.existsSync('/lib/libc.musl-aarch64.so.1')) return true;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
    return !report.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

async function installManagedRuntime(
  id: ManagedAgentId,
  update: (next: ProgressUpdate) => void,
  signal: AbortSignal,
): Promise<void> {
  if (id === 'claude') return installClaude(update, signal);
  return installCodex(update, signal);
}

const CLAUDE_RELEASES = 'https://downloads.claude.ai/claude-code-releases';

interface ClaudeManifest {
  version: string;
  platforms: Record<string, { binary: string; checksum: string; size: number }>;
}

function removeInstallerStaging(staging: string): void {
  try {
    fs.rmSync(staging, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch {
    // A just-executed Windows binary may remain transiently locked by the OS
    // or endpoint protection. Staging is disposable; never let its cleanup
    // hide the installation or executable-verification failure that matters.
  }
}

export async function installClaude(
  update: (next: ProgressUpdate) => void,
  signal: AbortSignal,
  verifyExecutable: AgentExecutableVerifier = verifyAgentExecutable,
): Promise<void> {
  update({ progress: 0, message: 'Resolving the latest Claude Code release…' });
  const version = (await fetchBoundedText(`${CLAUDE_RELEASES}/latest`, signal, 200)).trim();
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
    throw new Error('Claude Code returned an invalid release version.');
  }
  const manifest = JSON.parse(
    await fetchBoundedText(`${CLAUDE_RELEASES}/${version}/manifest.json`, signal, 1_000_000),
  ) as ClaudeManifest;
  const platform = claudePlatform();
  const asset = manifest.platforms?.[platform];
  if (
    manifest.version !== version
    || !asset
    || !/^[a-f0-9]{64}$/.test(asset.checksum)
    || !Number.isSafeInteger(asset.size)
    || asset.size <= 0
    || asset.size > 1_000_000_000
  ) throw new Error(`Claude Code has no valid release manifest for ${platform}.`);

  const releaseRoot = path.join(managedClaudeReleasesDir(), version, platform);
  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const finalBinary = path.join(releaseRoot, binaryName);
  if (!fs.existsSync(finalBinary)) {
    const staging = `${releaseRoot}.staging.${process.pid}.${Date.now()}`;
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const stagingBinary = path.join(staging, binaryName);
    try {
      await downloadVerified(
        `${CLAUDE_RELEASES}/${version}/${platform}/${asset.binary}`,
        stagingBinary,
        asset.size,
        asset.checksum,
        signal,
        (progress) => update({ progress, message: `Downloading Claude Code… ${Math.round(progress * 100)}%` }),
      );
      if (process.platform !== 'win32') fs.chmodSync(stagingBinary, 0o755);
      verifyExecutable(stagingBinary, 'Claude Code', process.env);
      fs.mkdirSync(path.dirname(releaseRoot), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(releaseRoot)) fs.renameSync(staging, releaseRoot);
      else removeInstallerStaging(staging);
    } catch (error) {
      removeInstallerStaging(staging);
      throw error;
    }
  }
  verifyExecutable(finalBinary, 'Claude Code', process.env);
  const relative = path.relative(managedAgentRuntimeRoot('claude'), finalBinary);
  writeManagedClaudeManifest({ version, platform, executable: relative });
  update({ progress: 1, message: 'Claude Code installed.' });
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
) => void;

type InstallerScriptRunner = (
  shell: CodexInstallerShell,
  script: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onLine: (line: string) => void,
) => Promise<void>;

export interface CodexInstallDependencies {
  verifyExecutable: AgentExecutableVerifier;
  resolveInstallerShell: () => CodexInstallerShell;
  runInstallerScript: InstallerScriptRunner;
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
  dependencies: Partial<CodexInstallDependencies> = {},
): Promise<void> {
  const verifyExecutable = dependencies.verifyExecutable ?? verifyAgentExecutable;
  const resolveInstallerShell = dependencies.resolveInstallerShell ?? resolveCodexInstallerShell;
  const runScript = dependencies.runInstallerScript ?? runInstallerScript;
  update({ message: 'Downloading the official Codex installer…' });
  const script = await fetchBoundedText(CODEX_INSTALLER, signal, 2_000_000);
  const binDir = managedCodexBinDir();
  fs.mkdirSync(managedAgentRuntimeRoot('codex'), { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_INSTALL_DIR: binDir,
    CODEX_HOME: managedCodexInstallerHome(),
    CODEX_NON_INTERACTIVE: 'true',
    PATH: [binDir, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
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
  const executable = managedAgentExecutable('codex');
  if (!executable) {
    throw new Error(
      'The official Codex installer exited successfully but did not create an executable '
      + `under StashBase's managed runtime directory (${managedAgentRuntimeRoot('codex')}). `
      + 'Check whether security software quarantined Codex, then retry the installation.',
    );
  }
  verifyExecutable(executable, 'Codex', env);
  update({ progress: 1, message: 'Codex installed.' });
}

async function fetchBoundedText(url: string, signal: AbortSignal, maxBytes: number): Promise<string> {
  const response = await fetch(url, { signal, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) from ${new URL(url).host}.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error(`Download from ${new URL(url).host} exceeded its size limit.`);
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function downloadVerified(
  url: string,
  destination: string,
  expectedSize: number,
  expectedSha256: string,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<void> {
  const response = await fetch(url, { signal, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) from ${new URL(url).host}.`);
  const handle = await fs.promises.open(destination, 'wx', 0o700);
  const hash = crypto.createHash('sha256');
  let received = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset);
        offset += result.bytesWritten;
      }
      hash.update(chunk);
      received += chunk.length;
      if (received > expectedSize) throw new Error('Agent download exceeded the signed manifest size.');
      onProgress(Math.min(0.99, received / expectedSize));
    }
  } finally {
    await handle.close();
  }
  const actual = hash.digest('hex');
  if (received !== expectedSize) throw new Error(`Agent download was incomplete (${received} of ${expectedSize} bytes).`);
  if (actual !== expectedSha256) throw new Error('Agent download failed SHA-256 verification.');
  onProgress(1);
}

export function verifyAgentExecutable(
  executable: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 20_000,
): void {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...env, ELECTRON_RUN_AS_NODE: undefined },
  });
  if (result.status !== 0) {
    const nativeError = result.error as NodeJS.ErrnoException | undefined;
    const stderr = typeof result.stderr === 'string'
      ? result.stderr.replace(/\s+/g, ' ').trim().slice(-800)
      : '';
    let detail: string;
    if (nativeError?.code === 'ETIMEDOUT') detail = `timed out after ${timeoutMs}ms`;
    else if (nativeError) detail = `could not start: ${nativeError.message}`;
    else if (result.status !== null) detail = `exited with code ${result.status}`;
    else if (result.signal) detail = `terminated by ${result.signal}`;
    else detail = 'returned no exit status';
    throw new Error(
      `${label} was downloaded but did not pass its executable check (${detail}${stderr ? `: ${stderr}` : ''}).`,
    );
  }
}

async function runInstallerScript(
  shell: CodexInstallerShell,
  script: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  let scriptDir: string | null = null;
  let scriptFile: string | null = null;
  if (shell.kind !== 'posix') {
    const runtimeRoot = managedAgentRuntimeRoot('codex');
    fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    scriptDir = fs.mkdtempSync(path.join(runtimeRoot, '.installer-script.'));
    scriptFile = path.join(scriptDir, 'install.ps1');
    fs.writeFileSync(scriptFile, codexPowerShellInstallerScript(script, env), { mode: 0o600 });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(shell.command, scriptFile ? [...shell.args, scriptFile] : shell.args, {
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      let buffered = '';
      const abort = () => terminateInstallerTree(child);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      });
      child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', abort);
        if (buffered.trim()) onLine(buffered);
        if (signal.aborted) reject(new Error('Agent installation was cancelled.'));
        else if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Official Agent installer exited with code ${code ?? 'unknown'}.`));
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

function powerShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Pin installer-owned paths inside the official PowerShell file itself.
 * Windows environment keys are case-insensitive and packaged desktop
 * processes can inherit stale or duplicate variants. Executing one file also
 * avoids a nested script invocation that can return success without running
 * its target on some packaged Windows environments. */
export function codexPowerShellInstallerScript(
  installerScript: string,
  env: NodeJS.ProcessEnv,
): string {
  const installDir = env.CODEX_INSTALL_DIR;
  const codexHome = env.CODEX_HOME;
  if (!installDir || !codexHome) {
    throw new Error('Codex installer wrapper requires managed install and home directories.');
  }
  const bootstrap = [
    '$ErrorActionPreference = "Stop"',
    `$env:CODEX_INSTALL_DIR = ${powerShellSingleQuoted(installDir)}`,
    `$env:CODEX_HOME = ${powerShellSingleQuoted(codexHome)}`,
    '$env:CODEX_NON_INTERACTIVE = "true"',
    'Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
    '',
  ].join('\r\n');
  const parameterBlock = installerScript.match(
    /^(?:\uFEFF)?\s*\[CmdletBinding\(\)\]\s*\r?\nparam\([\s\S]*?\r?\n\)\s*\r?\n/,
  )?.[0];
  if (!parameterBlock) return bootstrap + installerScript;
  return parameterBlock + bootstrap + installerScript.slice(parameterBlock.length);
}
