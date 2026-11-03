import { randomUUID } from 'node:crypto';
import { telemetry } from './telemetry.ts';
import { errorDiagnostic } from './error-diagnostics.ts';
import type { ErrorDiagnostic } from '../shared/protocols/http/telemetry.ts';
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
import { agentCliLaunch } from './agent-cli-launch.ts';
import { AgentAccountRefusedError, AgentAuthenticationRequiredError, agentSetupDiagnostic } from './agent-setup-diagnostic.ts';
import { classifyAgentTurnFailure } from './agent-turn-failure.ts';
import { ensureAgentMcp } from './agent-mcp.ts';
import {
  agentCliEnv,
  agentCliOverride,
  commandDir,
  resolveAgentCli,
  resolveAgentCliWithLoginShell,
  resolveNativeAgentCli,
} from './agent-cli.ts';
import {
  NATIVE_AGENT_IDS,
  NATIVE_AGENTS,
  nativeAgentCliSpec,
  nativeAgentInstallerUrl,
} from './native-agents.ts';
import { antigravityIsAuthenticated, loginToAntigravity } from './antigravity-setup.ts';
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

export interface AgentLoginOptions {
  /** The provider refused the stored sign-in. The CLI's own status check
   * still reads the stored credential as signed in, so only the login's
   * own completion can show that a new sign-in happened. */
  reauthenticate?: boolean;
  /** No stored sign-in was found and the runtime is opening its provider's
   * page: from here on the wait is the reader's, not StashBase's. */
  onBrowserSignIn?(): void;
  /** The provider page the CLI printed, for a browser that did not open. */
  onSignInUrl?(url: string): void;
}

export interface AgentBootstrapDependencies {
  resolveExecutable(id: NativeAgentId, options?: { probeLoginShell?: boolean; signal?: AbortSignal }): string | null | Promise<string | null>;
  resolveNativeExecutable(id: NativeAgentId): string | null;
  installRuntime(id: NativeAgentId, update: (next: ProgressUpdate) => void, signal: AbortSignal): Promise<void>;
  /** Run the installed executable once; throws when it cannot start. */
  verifyExecutable(id: NativeAgentId, executable: string, signal: AbortSignal): Promise<void>;
  isAuthenticated(id: NativeAgentId, executable: string, signal?: AbortSignal): boolean | Promise<boolean>;
  login(id: NativeAgentId, executable: string, signal: AbortSignal, options: AgentLoginOptions): Promise<void>;
  configureMcp(id: NativeAgentId): void;
  consumeFailure(stage: 'installation' | 'authentication' | 'mcp'): boolean;
}

const IDLE_STATUS: AgentBootstrapStatus = { phase: 'idle' };

class AgentSetupBusyError extends Error { readonly status = 409; }

const INSTALLATION_TIMEOUT_MS = 8 * 60_000;
const ACTION_LABELS = { bootstrap: 'Install / connect', login: 'Sign in', update: 'Update', connect: 'Check' } as const;
const ACTION_PROGRESS = { bootstrap: 'setting up', login: 'signing in', update: 'updating', connect: 'checking its installation' } as const;

export class AgentBootstrapCoordinator {
  private readonly statuses = new Map<NativeAgentId, AgentBootstrapStatus>();
  private readonly controllers = new Map<NativeAgentId, AbortController>();
  private readonly runs = new Map<NativeAgentId, Promise<void>>();
  private readonly actions = new Map<NativeAgentId, AgentBootstrapAction | 'connect'>();
  private readonly attempts = new Map<NativeAgentId, string>();
  private readonly diagnostics = new Map<NativeAgentId, ErrorDiagnostic>();
  /** Runtimes whose provider refused the stored sign-in since it last became ready. */
  private readonly refusedSignIns = new Map<NativeAgentId, string>();
  /** Only a completed status check that found no sign-in is expected at boot.
   * Tie the marker to its exact status so a later failure cannot inherit it. */
  private readonly signedOutStatuses = new WeakSet<AgentBootstrapStatus>();
  /** Runtimes whose running preparation the reader stopped. */
  private readonly stopped = new Set<NativeAgentId>();

  constructor(
    private readonly dependencies: AgentBootstrapDependencies,
    private readonly limits = { installationTimeoutMs: INSTALLATION_TIMEOUT_MS },
  ) {}

  status(id: NativeAgentId): AgentBootstrapStatus {
    return this.statuses.get(id) ?? IDLE_STATUS;
  }

  isExpectedSignOut(id: NativeAgentId, status = this.status(id)): boolean {
    return this.signedOutStatuses.has(status) && !this.refusedSignIns.has(id);
  }

  begin(id: NativeAgentId): AgentBootstrapStatus {
    return this.start(id, 'bootstrap', { probeLoginShell: true });
  }

  login(id: NativeAgentId): AgentBootstrapStatus {
    return this.start(id, 'login', { probeLoginShell: true });
  }

  /** A provider refusal invalidates readiness without deleting its credentials. */
  requireSignIn(id: NativeAgentId, message: string): void {
    this.refusedSignIns.set(id, message);
    // Keep an in-flight preparation visible until it retires; its auth
    // check must honor this refusal. An explicit login owns its recovery.
    if (this.runs.has(id)) return;
    this.fail(id, 'login', 'authentication', 'authentication-required', new Error(message));
  }

  /** Startup and explicit recheck can repair installed runtimes, never download. */
  connectIfInstalled(id: NativeAgentId, options?: { probeLoginShell?: boolean; source?: 'startup' }): AgentBootstrapStatus {
    const { source, ...discovery } = options ?? {};
    return this.start(id, 'connect', discovery, source);
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
    source?: 'startup',
  ): AgentBootstrapStatus {
    if (this.runs.has(id)) {
      if (action !== 'connect' && action !== this.actions.get(id)) {
        const running = this.actions.get(id)!;
        throw new AgentSetupBusyError(`${agentLabel(id)} is already ${ACTION_PROGRESS[running]}.`);
      }
      return this.status(id);
    }
    const retryOf = this.status(id).phase === 'failed' ? this.attempts.get(id) : undefined;
    const attemptId = randomUUID();
    this.attempts.set(id, attemptId);
    const startedAt = Date.now();
    const capture = telemetry.scoped();
    const context = { attempt_id: attemptId, ...(retryOf ? { retry_of: retryOf } : {}), action: source ?? action };
    const reportStage = (stage: AgentBootstrapFailureStage, outcome: 'started' | 'success') => {
      if (action !== 'connect') capture({ event: 'agent_setup_stage', runtime: id, attempt_id: attemptId, stage, outcome, context });
    };
    const controller = new AbortController();
    const { signal } = controller;
    this.controllers.set(id, controller);
    this.diagnostics.delete(id);
    this.actions.set(id, action);
    // `authenticating` is the browser step alone, the one place the reader can
    // stop a wait; every check before it is StashBase's own, and configuring.
    this.statuses.set(id, {
      phase: action === 'update' ? 'installing' : 'configuring',
      message: `Checking ${agentLabel(id)}…`,
    });
    // Register ownership before calling any injected dependency. Discovery,
    // authentication, installation and login share cancellation and deduplication.
    const run = Promise.resolve().then(async () => {
      let stage: AgentBootstrapFailureStage = 'discovery';
      reportStage(stage, 'started');
      try {
        signal.throwIfAborted();
        let executable = await this.dependencies.resolveExecutable(id, { ...options, signal });
        signal.throwIfAborted();
        reportStage(stage, 'success');
        // Discovery can find a leftover launcher with no working runtime.
        // The first explicit Connect verifies it before attempting sign-in;
        // background discovery still never installs or repairs anything.
        const reinstall = action === 'bootstrap' && executable !== null
          && !await this.installationRuns(id, executable, signal);
        if (!executable || action === 'update' || reinstall) {
          if (action === 'connect') {
            this.statuses.set(id, IDLE_STATUS);
            return;
          }
          if (!executable && (action === 'login' || action === 'update')) {
            this.fail(id, action, 'discovery', 'runtime-unavailable', new Error(`${agentLabel(id)} is not installed.`));
            return;
          }
          stage = 'installation';
          reportStage(stage, 'started');
          if (this.dependencies.consumeFailure('installation')) {
            this.fail(id, action, stage, 'simulated', new Error('Simulated agent installation failure.'));
            return;
          }
          this.statuses.set(id, { phase: 'installing', progress: 0, message: `${action === 'update' ? 'Updating' : 'Preparing'} ${agentLabel(id)}…` });
          const timer = setTimeout(() => controller.abort(new Error(
            `${agentLabel(id)} installation timed out after ${Math.ceil(this.limits.installationTimeoutMs / 60_000)} minutes.`,
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
            throw new Error(`${agentLabel(id)} native installation is not the selected executable. Check your executable override.`);
          }
        }
        if (stage === 'installation') reportStage(stage, 'success');
        stage = 'authentication';
        reportStage(stage, 'started');
        this.statuses.set(id, { phase: 'configuring', message: `Checking ${agentLabel(id)} sign-in…` });
        if (action === 'login') {
          const browser = `Finish signing in to ${agentLabel(id)} in your browser.`;
          await this.dependencies.login(id, executable, signal, {
            reauthenticate: this.refusedSignIns.has(id),
            // The login checks for a sign-in already in place first, and that
            // check is still StashBase's own step: the reader is asked for the
            // browser only once the runtime opens it.
            onBrowserSignIn: () => {
              if (!signal.aborted) this.statuses.set(id, { phase: 'authenticating', message: browser });
            },
            onSignInUrl: (signInUrl) => {
              if (!signal.aborted) this.statuses.set(id, { phase: 'authenticating', message: browser, signInUrl });
            },
          });
          signal.throwIfAborted();
        }
        if (!await this.checkAuthentication(id, executable, action, signal)) return;
        signal.throwIfAborted();
        reportStage(stage, 'success');
        stage = 'mcp';
        reportStage(stage, 'started');
        this.statuses.set(id, { phase: 'configuring', progress: 1, message: 'Connecting StashBase MCP…' });
        this.configure(id, action);
        if (this.status(id).phase === 'ready') reportStage(stage, 'success');
      } catch (error) {
        if (this.stopped.has(id)) {
          // Stopping is the reader's answer, not a failed step. A sign-in
          // stopped short leaves the runtime signed out, which offers Sign in
          // again rather than a failed step's Retry.
          const signIn = stage === 'authentication';
          this.fail(id, action, stage, signIn ? 'authentication-required' : 'operation-failed',
            new Error(`${agentLabel(id)} ${signIn ? 'sign-in' : 'setup'} was stopped.`));
          return;
        }
        const code = !signal.aborted && error instanceof AgentAccountRefusedError ? 'account-refused' : 'operation-failed';
        this.fail(id, action, stage, code, signal.aborted ? signal.reason : error, stage === 'installation' ? 'install-command' : undefined);
      }
    }).finally(() => {
      const status = this.status(id);
      const expectedStartupSignOut = source === 'startup' && this.isExpectedSignOut(id, status);
      // Startup discovery is not a failed setup when no sign-in was stored.
      // Do not link a later explicit action to an attempt we never reported.
      if (expectedStartupSignOut) this.attempts.delete(id);
      else if (action !== 'connect' || status.phase === 'failed') capture({ event: 'agent_setup_result', runtime: id,
        context: { ...context, elapsed_ms: Date.now() - startedAt },
        stage: action === 'login' ? 'login' : action === 'update' ? 'update' : action === 'connect' ? 'connect' : 'prepare',
        outcome: signal.aborted && signal.reason?.name === 'AbortError' ? 'cancelled' : status.phase === 'ready' ? 'success' : 'failed',
        ...(status.failure ? { failure_stage: status.failure.stage, diagnostic: this.diagnostics.get(id) } : {}),
      });
      this.diagnostics.delete(id);
      this.controllers.delete(id);
      this.actions.delete(id);
      this.stopped.delete(id);
      this.runs.delete(id);
    });
    this.runs.set(id, run);
    return this.status(id);
  }

  private async installationRuns(id: NativeAgentId, executable: string, signal: AbortSignal): Promise<boolean> {
    this.statuses.set(id, { phase: 'configuring', message: `Checking the ${agentLabel(id)} installation…` });
    try {
      await this.dependencies.verifyExecutable(id, executable, signal);
      return true;
    } catch {
      signal.throwIfAborted();
      return false;
    }
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
      const refusal = this.refusedSignIns.get(id);
      if (authenticated && (refusal === undefined || action === 'login')) return true;
      this.fail(id, action, 'authentication', 'authentication-required',
        new Error(refusal ?? `${agentLabel(id)} is installed, but it is not signed in.`), undefined, 'login');
      if (!authenticated && refusal === undefined) this.signedOutStatuses.add(this.status(id));
    } catch (error) {
      // A stop or timeout is the run's to report, not a failed check.
      if (signal.aborted) throw error;
      if (error instanceof AgentAuthenticationRequiredError) {
        this.refusedSignIns.set(id, error.message);
        this.fail(id, action, 'authentication', 'authentication-required', error, undefined, 'login');
        return false;
      }
      if (error instanceof AgentAccountRefusedError) {
        this.fail(id, action, 'authentication', 'account-refused', error);
        return false;
      }
      // Antigravity's check asks Google. Offer login for an unanswered check
      // only if its CLI actually runs; a broken launcher needs bootstrap just
      // like Claude and Codex, otherwise first-send would keep retrying login.
      let retryAction: AgentBootstrapAction | undefined;
      if (id === 'antigravity') {
        try {
          await this.dependencies.verifyExecutable(id, executable, signal);
          signal.throwIfAborted();
          retryAction = 'login';
        } catch {
          signal.throwIfAborted();
          retryAction = 'bootstrap';
        }
      }
      this.fail(id, action, 'authentication', 'authentication-check-failed', error, undefined,
        retryAction);
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
      this.refusedSignIns.delete(id);
      this.statuses.set(id, { phase: 'ready', progress: 1, message: `${agentLabel(id)} is ready.` });
    } catch (error) {
      this.fail(id, action, 'mcp', 'operation-failed', error, 'mcp-settings');
    }
  }

  async wait(id: NativeAgentId): Promise<AgentBootstrapStatus> {
    await this.runs.get(id);
    return this.status(id);
  }

  /** The reader stopped waiting on a browser sign-in that may never come
   * back. The run's own cancellation retires its processes, and the answer is
   * the status it settles on. Only a sign-in waits on the reader: a stop that
   * arrives once another kind of run has taken its place, such as an update
   * or a background connection, leaves that run alone and answers at once. */
  async stop(id: NativeAgentId): Promise<AgentBootstrapStatus> {
    const controller = this.controllers.get(id);
    if (!controller || this.actions.get(id) !== 'login') return this.status(id);
    this.stopped.add(id);
    controller.abort();
    return this.wait(id);
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
    retryAction: AgentBootstrapAction = action === 'connect' ? 'bootstrap' : action,
  ): void {
    const message = agentSetupDiagnostic(error);
    const diagnostic = errorDiagnostic(error);
    this.diagnostics.set(id, { ...diagnostic, code: diagnostic.code ?? code });
    this.statuses.set(id, {
      phase: 'failed',
      failure: {
        stage,
        code,
        message: `${agentLabel(id)} · ${ACTION_LABELS[action]} · ${stage}\n${message}`,
        retryable: true,
        manualRecovery,
        retryAction,
      },
    });
  }
}

function agentLabel(id: NativeAgentId): string {
  return NATIVE_AGENTS[id].label;
}

function agentCliSpec(id: NativeAgentId) {
  return nativeAgentCliSpec(id);
}

/** The official per-user copy of this runtime's own command. */
function resolveNativeExecutable(id: NativeAgentId): string | null {
  return resolveNativeAgentCli(NATIVE_AGENTS[id].bin);
}

function resolveInstalledExecutable(id: NativeAgentId): string | null {
  return resolveAgentCli(agentCliSpec(id));
}

/** Ask the selected CLI before declaring readiness; this never starts login. */
export async function agentIsAuthenticated(
  id: NativeAgentId, executable: string, signal?: AbortSignal,
): Promise<boolean> {
  if (id === 'antigravity') return antigravityIsAuthenticated(executable, signal);
  const result = await probeAgentCommand(executable, id === 'claude' ? ['auth', 'status'] : ['login', 'status'], {
    timeoutMs: 10_000,
    signal,
    env: agentCliEnv({}, [commandDir(executable)]),
  });
  const output = `${result.stdout}\n${result.stderr}`.replace(/\s+/g, ' ').trim();
  if (result.status === 0) return true;
  const signedOutMarker = id === 'claude' ? /"loggedIn"\s*:\s*false/g : /not logged in/gi;
  const signedOut = result.status === 1 && signedOutMarker.test(output);
  const detail = `using ${executable} (exit ${result.status ?? 'unknown'}${output ? `: ${output.slice(-800)}` : ''}).`;
  // Read only completed probe output, never a launch/timeout error or the
  // executable path. The ordinary signed-out marker is not a refusal, but
  // cannot hide an explicit rejected credential elsewhere in the output.
  if (classifyAgentTurnFailure(signedOut ? output.replace(signedOutMarker, '') : output) === 'auth-expired') {
    throw new AgentAuthenticationRequiredError(`${agentLabel(id)} sign-in was rejected. Sign in again.\nStatus ${detail}`);
  }
  if (signedOut) return false;
  throw new Error(`Could not check ${agentLabel(id)} sign-in ${detail}`);
}

const AGENT_LOGIN_TIMEOUT_MS = 10 * 60_000;
const AGENT_LOGIN_POLL_MS = 3_000;

/** The provider page a CLI prints for a browser that did not open, once the
 * whole address has arrived. Only a page that finishes sign-in by itself is
 * offered: one whose OAuth redirect stays on this machine, as Codex's does.
 * Claude prints a page that redirects to its provider and ends by showing a
 * code to paste into the CLI, and the login runs here without input, so that
 * page could never finish. */
export function agentSignInUrl(output: string): string | undefined {
  for (const [page] of output.matchAll(/https:\/\/[^\s"'<>]+(?=[\s"'<>])/g)) {
    if (redirectsToThisMachine(page)) return page;
  }
  return undefined;
}

function redirectsToThisMachine(page: string): boolean {
  try {
    const redirect = new URL(page).searchParams.get('redirect_uri');
    if (redirect === null) return true;
    const { hostname, protocol } = new URL(redirect);
    return protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

/** Login output kept for a failure: one line, without the query strings that
 * carry a sign-in attempt's own state. */
function loginOutputDetail(output: string): string {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-800);
}

export interface AgentLoginLimits {
  isAuthenticated: (id: NativeAgentId, executable: string, signal: AbortSignal) => Promise<boolean>;
  pollMs: number;
  timeoutMs: number;
}

/** Run the Agent's own browser-based login. The selected CLI opens the provider
 * page and writes credentials to its normal home; no token passes through
 * StashBase.
 *
 * A CLI that is already signed in opens nothing. Otherwise its status check
 * runs beside the login, and the first check that reads signed in finishes
 * sign-in: some CLIs keep waiting after the browser reports success, which
 * left setup waiting out the full timeout although sign-in had worked. A
 * refused credential still reads signed in, so a reauthentication waits for
 * the login itself. */
export async function loginToAgent(
  id: NativeAgentId,
  executable: string,
  signal: AbortSignal,
  options: AgentLoginOptions = {},
  overrides: Partial<AgentLoginLimits> = {},
): Promise<void> {
  signal.throwIfAborted();
  if (id === 'antigravity') {
    return loginToAntigravity(executable, signal, {}, { onBrowserSignIn: options.onBrowserSignIn });
  }
  const label = agentLabel(id);
  const isAuthenticated = overrides.isAuthenticated ?? agentIsAuthenticated;
  const signedIn = async () => {
    try {
      return await isAuthenticated(id, executable, signal);
    } catch {
      signal.throwIfAborted();
      return false;
    }
  };
  const watch = !options.reauthenticate;
  if (watch && await signedIn()) return;
  signal.throwIfAborted();
  options.onBrowserSignIn?.();
  const launch = agentCliLaunch(executable, id === 'claude' ? ['auth', 'login'] : ['login']);
  const child = spawn(launch.command, launch.args, {
    env: agentCliEnv({}, [commandDir(executable)]),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
  let exited = false;
  const completion = waitForExtractorTree(child).finally(() => { exited = true; });
  let output = '';
  let signInUrl: string | undefined;
  const append = (chunk: Buffer | string) => {
    output = (output + chunk.toString()).slice(-4000);
    if (signInUrl) return;
    signInUrl = agentSignInUrl(output);
    if (signInUrl) options.onSignInUrl?.(signInUrl);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const abort = () => terminateInstallerTree(child);
  signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateInstallerTree(child);
  }, overrides.timeoutMs ?? AGENT_LOGIN_TIMEOUT_MS);
  timeout.unref?.();
  let confirmed = false;
  const closed = completion.then(() => {}, () => {});
  const poll = async () => {
    const pollMs = overrides.pollMs ?? AGENT_LOGIN_POLL_MS;
    while (watch && !exited && !signal.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, pollMs); })]);
      clearTimeout(timer);
      if (exited || signal.aborted) return;
      if (await signedIn()) {
        confirmed = true;
        terminateInstallerTree(child);
        return;
      }
    }
  };
  try {
    const [code] = await Promise.all([completion, poll().catch(() => {})]);
    if (signal.aborted) throw new Error(`${label} sign-in was cancelled.`);
    if (confirmed || code === 0) return;
    // The browser step may have finished although the CLI did not exit cleanly.
    if (!timedOut && watch && await signedIn()) return;
    const detail = loginOutputDetail(output);
    const host = signInUrl && /^https:\/\/([^/?#]+)/.exec(signInUrl)?.[1];
    const opened = host ? ` It printed its sign-in page (${host}), but sign-in did not finish.` : '';
    const message = timedOut
      ? `${label} sign-in timed out after ${Math.round((overrides.timeoutMs ?? AGENT_LOGIN_TIMEOUT_MS) / 60_000)} minutes.${opened}`
      : `${label} sign-in exited with code ${code ?? 'unknown'}.`;
    throw Object.assign(new Error(detail ? `${message}\nLast output: ${detail}` : message), {
      exitCode: code,
      stderr: detail,
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

export const agentBootstrapCoordinator = new AgentBootstrapCoordinator({
  resolveExecutable: (id, options) => options?.probeLoginShell
    ? resolveAgentCliWithLoginShell(agentCliSpec(id), undefined, options.signal)
    : resolveInstalledExecutable(id),
  resolveNativeExecutable,
  installRuntime: installNativeRuntime,
  verifyExecutable: (id, executable, signal) =>
    verifyAgentExecutable(executable, agentLabel(id), agentCliEnv({}, [commandDir(executable)]), 20_000, signal),
  isAuthenticated: agentIsAuthenticated,
  login: (id, executable, signal, options) => loginToAgent(id, executable, signal, options),
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

/** Stop waiting on a preparation the reader started, such as a browser
 * sign-in. Authorization already given in the browser is not revoked. */
export function stopAgentBootstrap(id: NativeAgentId): Promise<AgentBootstrapStatus> {
  return agentBootstrapCoordinator.stop(id);
}

/** Updates use each provider's standalone installer. Explicit executable
 * overrides outside that layout cannot be replaced by an in-app update. */
export function agentSupportsInAppUpdate(id: NativeAgentId): boolean {
  const override = agentCliOverride(agentCliSpec(id));
  return !override || override === resolveNativeExecutable(id);
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
export async function connectInstalledAgentMcpOnStartup(): Promise<Array<{ id: NativeAgentId; status: AgentBootstrapStatus; expectedSignOut: boolean }>> {
  return Promise.all(NATIVE_AGENT_IDS.map(async (id) => {
    agentBootstrapCoordinator.connectIfInstalled(id, { probeLoginShell: true, source: 'startup' });
    const status = await agentBootstrapCoordinator.wait(id);
    return { id, status, expectedSignOut: agentBootstrapCoordinator.isExpectedSignOut(id, status) };
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
  if (id === 'antigravity') return installAntigravity(update, signal);
  return installCodex(update, signal);
}

const CLAUDE_INSTALLER = nativeAgentInstallerUrl('claude');

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
    ?? (() => resolveNativeExecutable('claude'));
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
      + 'Check whether security software quarantined Claude.',
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
    update({ message: 'Added %USERPROFILE%\\.local\\bin to your PATH. Open a new terminal to use claude.' });
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

const ANTIGRAVITY_INSTALLER = nativeAgentInstallerUrl('antigravity');

/** Antigravity's official installer downloads a verified `agy` release into
 * `~/.local/bin` (`%LOCALAPPDATA%\agy\bin` on Windows) and owns the user's
 * PATH profile, like the other providers' installers. Its POSIX script is
 * written for bash. */
export async function installAntigravity(
  update: (next: ProgressUpdate) => void,
  signal: AbortSignal,
  dependencies: Partial<AgentInstallDependencies> = {},
): Promise<void> {
  const verifyExecutable = dependencies.verifyExecutable ?? verifyAgentExecutable;
  const resolveInstallerShell = dependencies.resolveInstallerShell ?? resolveClaudeInstallerShell;
  const runScript = dependencies.runInstallerScript ?? antigravityInstallerScriptRunner;
  const resolveInstalled = dependencies.resolveInstalledExecutable
    ?? (() => resolveNativeExecutable('antigravity'));
  update({ message: 'Downloading the official Antigravity installer…' });
  const script = await fetchBoundedText(ANTIGRAVITY_INSTALLER, signal, 2_000_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
  };
  await runScript(resolveInstallerShell(), script, env, signal, (line) => {
    const message = line.trim();
    if (message) update({ message });
  });
  const executable = resolveInstalled();
  if (!executable) {
    throw new Error(
      "The official Antigravity installer exited successfully but no 'agy' executable "
      + 'was found in its standard install locations (such as ~/.local/bin). '
      + 'Check whether security software quarantined Antigravity.',
    );
  }
  await verifyExecutable(executable, 'Antigravity', agentCliEnv(), 20_000, signal);
  update({ progress: 1, message: 'Antigravity installed.' });
}

function antigravityInstallerScriptRunner(
  shell: CodexInstallerShell,
  script: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  return runInstallerScript(shell, script, env, signal, onLine, {
    tempRoot: agentInstallerTempRoot('antigravity'),
    bootstrap: ANTIGRAVITY_PS1_BOOTSTRAP,
  });
}

const CODEX_INSTALLER = nativeAgentInstallerUrl('codex');

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
      + 'Install PowerShell 7 (pwsh.exe).',
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
    ?? (() => resolveNativeExecutable('codex'));
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
      + 'Check whether security software quarantined Codex.',
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

export async function fetchBoundedText(url: string, signal: AbortSignal, maxBytes: number): Promise<string> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  try {
    const response = await fetch(url, { signal: bounded, redirect: 'follow' });
    if (!response.ok || !response.body) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
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
    throw new Error(`Download failed from ${new URL(url).host}: ${agentSetupDiagnostic(bounded.aborted ? bounded.reason : error)}`, { cause: bounded.aborted ? bounded.reason : error });
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
    const result = await probeAgentCommand(executable, ['--version'], { env, timeoutMs, signal });
    if (result.status !== 0) {
      throw Object.assign(new Error(`exited with code ${result.status ?? 'unknown'}: ${[result.stderr, result.stdout].filter(Boolean).join('\n').trim()}`), { exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
    }
  } catch (error) {
    throw new Error(`${label} was downloaded but did not pass its executable check at ${executable}: ${agentSetupDiagnostic(error)}`, { cause: error });
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
        else reject(Object.assign(new Error(`Official agent installer exited with code ${code ?? 'unknown'}.\n${output.trim()}`), { exitCode: code, stderr: output }));
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

export const ANTIGRAVITY_PS1_BOOTSTRAP = CLAUDE_PS1_BOOTSTRAP;

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
