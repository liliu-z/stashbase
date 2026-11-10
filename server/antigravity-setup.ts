/**
 * Antigravity sign-in for Settings → Agents.
 *
 * `agy` has no status or login subcommand. A run that answers a read-only
 * slash command (`-p /usage`) needs the cached sign-in but starts no turn, so
 * its outcome is the readiness check. Sign-in itself happens the first time
 * `agy` runs interactively: it opens the browser's OAuth page and stores the
 * credential in the OS keyring. StashBase gives that run a terminal (a
 * pseudo-terminal on macOS/Linux, its own console window on Windows), polls
 * the readiness check, and retires the run once it passes. No credential
 * passes through StashBase.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { probeAgentCommand } from './agent-probe.ts';
import { agentCliEnv, commandDir } from './agent-cli.ts';
import { terminateExtractorTree, waitForExtractorTree } from './extractor-process.ts';
import { AgentAccountRefusedError, AgentConfigurationError } from './agent-setup-diagnostic.ts';

type ProbeResult = { status: number | null; stdout: string; stderr: string };

const SIGNED_OUT = /authentication required|not (?:signed|logged) in|sign[- ]?in (?:is )?required|unauthenticated|no saved (?:session|credentials)|please (?:sign|log) in/i;
/** Google answering a signed-in account with an eligibility rule, such as an
 * unsupported region, rather than a sign-in problem. */
const REFUSED = /PERMISSION_DENIED|not eligible|ineligible|not (?:currently )?available in your (?:location|country|region)/i;
const MISSING_PROVIDER_KEY = /\bmodelProvider\b[^\n]*\benvironment variable is not set\b/i;

export type AntigravityAuthState =
  | { state: 'signed-in' }
  | { state: 'signed-out' }
  | { state: 'refused'; reason: string }
  | { state: 'configuration-error'; reason: string }
  | { state: 'unknown' };

/** Classify one `agy --output-format json -p /usage` run. A refusal that
 * names missing sign-in is signed out; an eligibility refusal means the
 * account signed in but cannot be used; any other failure is not evidence
 * either way and stays a failed check. */
export function antigravityAuthState(result: ProbeResult): AntigravityAuthState {
  const output = `${result.stdout}\n${result.stderr}`;
  const envelope = lastJsonObject(result.stdout);
  const error = typeof envelope?.error === 'string' ? envelope.error : '';
  const status = typeof envelope?.status === 'string' ? envelope.status.toUpperCase() : '';
  if ((result.status !== 0 || status === 'ERROR') && MISSING_PROVIDER_KEY.test(`${error}\n${output}`)) {
    const settings = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    return { state: 'configuration-error', reason: `Antigravity is set to use an API key instead of a Google sign-in. Remove "modelProvider" from ${settings}, then retry to sign in with Google using the default backend.` };
  }
  if (REFUSED.test(output)) return { state: 'refused', reason: providerSentence(error || output) };
  if (SIGNED_OUT.test(output)) return { state: 'signed-out' };
  if (result.status !== 0) return { state: 'unknown' };
  return status && status !== 'SUCCESS' ? { state: 'unknown' } : { state: 'signed-in' };
}

export async function antigravityIsAuthenticated(executable: string, signal?: AbortSignal): Promise<boolean> {
  // `agy` starts its own backend for every run, so this check alone takes
  // 10–20 seconds on an ordinary connection.
  const result = await probeAgentCommand(executable, ['--output-format', 'json', '-p', '/usage'], {
    timeoutMs: 60_000,
    signal,
    env: agentCliEnv({}, [commandDir(executable)]),
  });
  const auth = antigravityAuthState(result);
  if (auth.state === 'signed-in') return true;
  if (auth.state === 'signed-out') return false;
  if (auth.state === 'refused') {
    throw new AgentAccountRefusedError(`Antigravity is signed in, but Google refused this account: ${auth.reason}`);
  }
  if (auth.state === 'configuration-error') {
    throw Object.assign(new AgentConfigurationError(auth.reason), {
      exitCode: result.status, stdout: result.stdout, stderr: result.stderr,
    });
  }
  const output = `${result.stdout}\n${result.stderr}`.replace(/\s+/g, ' ').trim().slice(-800);
  throw new Error(`Could not check Antigravity sign-in using ${executable} (exit ${result.status ?? 'unknown'}${output ? `: ${output}` : ''}).`);
}

/** The provider's own sentence, without the CLI's call chain
 * (`/usage failed: retrieving quota summary: … PERMISSION_DENIED (code 403): `). */
function providerSentence(text: string): string {
  const line = text.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => REFUSED.test(entry)) ?? text.trim();
  const sentence = line.replace(/^.*\(code \d+\):\s*/, '').replace(/^error:\s*/i, '').trim();
  return (sentence || line).slice(0, 600);
}

export interface AntigravityLoginDependencies {
  isAuthenticated(executable: string, signal: AbortSignal): Promise<boolean>;
  spawnSignIn(executable: string): ChildProcess;
  pollMs: number;
  timeoutMs: number;
}

const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** `agy` opens its OAuth page itself from the interactive run and prints no
 * address StashBase could offer again (on Windows its console is not even
 * piped), so the only signal is that the run, and with it the browser, has
 * started. */
export interface AntigravityLoginOptions {
  onBrowserSignIn?(): void;
}

export async function loginToAntigravity(
  executable: string,
  signal: AbortSignal,
  overrides: Partial<AntigravityLoginDependencies> = {},
  options: AntigravityLoginOptions = {},
): Promise<void> {
  const isAuthenticated = overrides.isAuthenticated ?? antigravityIsAuthenticated;
  const pollMs = overrides.pollMs ?? 4_000;
  const deadline = Date.now() + (overrides.timeoutMs ?? LOGIN_TIMEOUT_MS);
  signal.throwIfAborted();
  // Reuse an account signed in outside StashBase. A refused account stays
  // refused, so it opens no sign-in. A check that cannot answer may be a
  // signed-out account in words StashBase does not read, so it opens the
  // sign-in, as Claude's and Codex's do; the loop below polls the same check.
  let lastCheckError: unknown;
  try {
    const authenticated = await isAuthenticated(executable, signal);
    signal.throwIfAborted();
    if (authenticated) return;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AgentAccountRefusedError || error instanceof AgentConfigurationError) throw error;
    lastCheckError = error;
  }
  options.onBrowserSignIn?.();
  const child = (overrides.spawnSignIn ?? spawnAntigravitySignIn)(executable);
  let output = '';
  const append = (chunk: Buffer | string) => { output = (output + chunk.toString()).slice(-4000); };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.stdin?.on('error', () => { /* the terminal closed its input */ });
  let exited = false;
  const completion = waitForExtractorTree(child).catch(() => null).finally(() => { exited = true; });
  const retire = async () => {
    if (!exited) terminateExtractorTree(child);
    await completion;
  };
  try {
    while (true) {
      await delay(pollMs, signal);
      try {
        if (await isAuthenticated(executable, signal)) return;
        lastCheckError = undefined;
      } catch (error) {
        signal.throwIfAborted();
        // A refused account stays refused; waiting longer cannot sign it in.
        if (error instanceof AgentAccountRefusedError || error instanceof AgentConfigurationError) throw error;
        lastCheckError = error;
      }
      if (exited) {
        const detail = terminalText(output) || (lastCheckError instanceof Error ? lastCheckError.message : '');
        throw new Error(`Antigravity closed before sign-in finished.${detail ? ` ${detail}` : ''}`);
      }
      if (Date.now() >= deadline) {
        throw new Error('Antigravity sign-in timed out after 10 minutes.');
      }
    }
  } catch (error) {
    if (signal.aborted) throw new Error('Antigravity sign-in was cancelled.');
    throw error;
  } finally {
    await retire();
  }
}

/** The interactive run needs a terminal to start its browser sign-in. POSIX
 * gets a pseudo-terminal from `script`; Windows gives a detached console
 * process its own visible window. */
function spawnAntigravitySignIn(executable: string): ChildProcess {
  const options = {
    cwd: os.tmpdir(),
    env: agentCliEnv({}, [commandDir(executable)]),
    detached: true,
  };
  if (process.platform === 'win32') {
    return spawn(executable, [], { ...options, stdio: 'ignore', windowsHide: false });
  }
  const args = process.platform === 'darwin'
    ? ['-q', '/dev/null', executable]
    : ['-q', '-e', '-c', shellQuote(executable), '/dev/null'];
  // StashBase does not relay terminal input. Node's piped stdin is a socket,
  // which macOS script rejects during tcgetattr before it starts the CLI.
  // /dev/null lets script create the CLI's own pseudo-terminal normally.
  return spawn('script', args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** The readable tail of a terminal transcript, without escape sequences. */
function terminalText(output: string): string {
  return output
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-600);
}

function lastJsonObject(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const candidate of [text.trim(), ...lines.reverse()]) {
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Not a whole JSON object; try the next line.
    }
  }
  return null;
}
