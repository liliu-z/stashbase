import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeAgentCommand } from './agent-probe.ts';
export interface AgentCliSpec {
  name: string;
  envNames: string[];
  logLabel: string;
}

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.com', '.exe', '.cmd', '.bat']);
const LOGIN_SHELL_MISS_CACHE_MS = 10_000;
const loginShellCache = new Map<string, { checkedAt: number; executable: string | null }>();

export function isWindowsLaunchableAgentCliPath(file: string): boolean {
  return WINDOWS_EXECUTABLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile()
      && (process.platform !== 'win32' || isWindowsLaunchableAgentCliPath(file));
  } catch {
    return false;
  }
}

function expandHome(candidate: string): string {
  if (candidate === '~') return os.homedir();
  if (candidate.startsWith('~/')) return path.join(os.homedir(), candidate.slice(2));
  return candidate;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? env[key] : undefined;
  return typeof value === 'string' ? value : '';
}

export function agentCliSearchDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
  ];
  if (platform === 'win32') {
    const appData = environmentValue(env, 'APPDATA');
    const localAppData = environmentValue(env, 'LOCALAPPDATA');
    return unique([
      localAppData ? join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin') : '',
      ...dirs,
      appData ? join(appData, 'npm') : '',
      localAppData ? join(localAppData, 'npm') : '',
    ]);
  }
  return unique([...dirs, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']);
}

export function agentCliPath(extraDirs: string[] = [], basePath = process.env.PATH ?? ''): string {
  return unique([
    ...extraDirs,
    ...agentCliSearchDirs(),
    ...basePath.split(path.delimiter),
  ]).join(path.delimiter);
}

export function agentCliEnv(extraEnv: NodeJS.ProcessEnv = {}, extraDirs: string[] = []): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extraEnv,
    PATH: agentCliPath(extraDirs, extraEnv.PATH ?? process.env.PATH ?? ''),
    ELECTRON_RUN_AS_NODE: undefined,
  } as NodeJS.ProcessEnv;
}

export function agentCliExecutableCandidates(name: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [name];
  const ext = path.extname(name);
  if (ext) return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.com`, name];
}

/** Inspect the package target rather than guessing from a global bin directory:
 * Homebrew and npm can both publish commands into /usr/local/bin. Windows npm
 * shims are small scripts rather than symlinks. Never execute a CLI to classify it. */
function isNpmAgentCli(executable: string, name: string): boolean {
  const packageName = name === 'claude' ? '@anthropic-ai/claude-code' : name === 'codex' ? '@openai/codex' : null;
  if (!packageName) return false;
  try {
    const target = fs.realpathSync(executable).replaceAll('\\', '/');
    if (target.includes(`/node_modules/${packageName}/`)) return true;
    if (fs.statSync(executable).size > 8192) return false;
    return fs.readFileSync(executable, 'utf8').replaceAll('\\', '/').includes(`/${packageName}/`);
  } catch {
    return false;
  }
}

/** Official per-user launchers. A leftover npm shim in the same directory must
 * not satisfy post-install verification of a standalone installation. */
export function resolveNativeAgentCli(name: string): string | null {
  const dirs = [path.join(os.homedir(), '.local', 'bin')];
  const localAppData = environmentValue(process.env, 'LOCALAPPDATA');
  if (process.platform === 'win32' && name === 'codex' && localAppData) {
    dirs.unshift(path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'));
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    if (isExecutable(candidate) && !isNpmAgentCli(candidate, name)) return candidate;
  }
  return null;
}

export function agentCliOverride(spec: AgentCliSpec): string | null {
  for (const name of spec.envNames) {
    const candidate = process.env[name];
    if (candidate?.trim()) {
      const resolved = path.resolve(expandHome(candidate));
      if (isExecutable(resolved)) return resolved;
    }
  }
  return null;
}

function resolveSystemAgentCli(
  spec: AgentCliSpec,
  warn?: (message: string) => void,
): string | null {
  const explicit = spec.envNames
    .map((name) => process.env[name])
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  for (const candidate of explicit) {
    const resolved = path.resolve(expandHome(candidate));
    if (isExecutable(resolved)) return resolved;
    warn?.(`${spec.logLabel} binary override is not executable: ${candidate}`);
  }

  const native = resolveNativeAgentCli(spec.name);
  if (native) return native;

  for (const dir of agentCliPath().split(path.delimiter)) {
    for (const name of agentCliExecutableCandidates(spec.name)) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }

  const cached = loginShellCache.get(spec.name);
  if (cached?.executable && isExecutable(cached.executable)) return cached.executable;

  return null;
}

export function resolveAgentCli(spec: AgentCliSpec, warn?: (message: string) => void): string | null {
  return resolveSystemAgentCli(spec, warn);
}

/** Readiness can discover version-manager installations without blocking HTTP. */
export async function resolveAgentCliWithLoginShell(
  spec: AgentCliSpec,
  warn?: (message: string) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  const system = resolveSystemAgentCli(spec, warn);
  const cached = loginShellCache.get(spec.name);
  const recentMiss = cached?.executable === null && Date.now() - cached.checkedAt < LOGIN_SHELL_MISS_CACHE_MS;
  if (!system && !recentMiss
      && process.platform !== 'win32' && /^[A-Za-z0-9_-]+$/.test(spec.name)) {
    let executable: string | null = null;
    try {
      const result = await probeAgentCommand(
        process.env.SHELL || '/bin/zsh', ['-l', '-i', '-c', `command -v ${spec.name}`],
        { env: agentCliEnv(), timeoutMs: 5_000, signal },
      );
      if (result.status === 0) {
        const candidate = result.stdout.trim().split(/\r?\n/).at(-1);
        if (candidate) {
          const resolved = path.resolve(expandHome(candidate));
          if (isExecutable(resolved)) executable = resolved;
        }
      }
    } catch {
      signal?.throwIfAborted();
      // A broken shell profile leaves normal runtime discovery available.
    }
    loginShellCache.set(spec.name, { checkedAt: Date.now(), executable });
  }
  return resolveAgentCli(spec, warn);
}

export function agentCliNeedsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

/** The version a CLI prints for `--version`, as a bare release number:
 * `2.1.220 (Claude Code)` and `codex-cli 0.104.0` both read as their
 * dotted number. Null when the output names none. */
export function parseAgentCliVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output)?.[1] ?? null;
}

const versionCache = new Map<string, { mtimeMs: number; version: Promise<string | null> }>();

/** What the installed executable says its version is, read once per file
 * change: the listing is polled while a runtime prepares, and the binary a
 * provider's updater replaces in place gets a new modification time, so the
 * cache never outlives the install it describes. Any failure to run or read
 * the executable reads as an unknown version, never as a missing runtime. */
export async function agentCliVersion(
  executable: string,
  read: (executable: string) => string | null | Promise<string | null> = readAgentCliVersion,
): Promise<string | null> {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(executable).mtimeMs;
  } catch {
    return null;
  }
  const cached = versionCache.get(executable);
  if (cached && cached.mtimeMs === mtimeMs) return cached.version;
  const version = Promise.resolve().then(() => read(executable));
  versionCache.set(executable, { mtimeMs, version });
  return version;
}

async function readAgentCliVersion(executable: string): Promise<string | null> {
  try {
    const result = await probeAgentCommand(executable, ['--version'], {
      timeoutMs: 10_000,
      shell: agentCliNeedsShell(executable),
      env: agentCliEnv({}, [path.dirname(executable)]),
    });
    if (result.status !== 0) return null;
    return parseAgentCliVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    return null;
  }
}

export function commandDir(command: string): string {
  return command.includes('/') || command.includes('\\') ? path.dirname(command) : '';
}
