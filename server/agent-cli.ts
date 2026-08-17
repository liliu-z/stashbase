import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  agentDiscoveryPolicy,
  managedAgentExecutable,
  type ManagedAgentId,
} from './agent-runtime-paths.ts';

export interface AgentCliSpec {
  name: string;
  envNames: string[];
  logLabel: string;
}

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.com', '.exe', '.cmd', '.bat']);
const LOGIN_SHELL_HIT_CACHE_MS = 5 * 60_000;
const LOGIN_SHELL_MISS_CACHE_MS = 10_000;
const loginShellCache = new Map<string, { checkedAt: number; executable: string | null }>();

export function isWindowsLaunchableAgentCliPath(file: string): boolean {
  return WINDOWS_EXECUTABLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    if (process.platform === 'win32') {
      return fs.statSync(file).isFile() && isWindowsLaunchableAgentCliPath(file);
    }
    return true;
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
    join(home, '.npm-global', 'bin'),
    join(home, '.local', 'bin'),
  ];
  if (platform === 'win32') {
    const appData = environmentValue(env, 'APPDATA');
    const localAppData = environmentValue(env, 'LOCALAPPDATA');
    return unique([
      ...dirs,
      appData ? join(appData, 'npm') : '',
      localAppData ? join(localAppData, 'npm') : '',
      localAppData ? join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin') : '',
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

function managedIdForName(name: string): ManagedAgentId | null {
  if (name === 'claude' || name === 'codex') return name;
  return null;
}

function resolveSystemAgentCli(
  spec: AgentCliSpec,
  warn?: (message: string) => void,
  probeLoginShell = false,
): string | null {
  const explicit = spec.envNames
    .map((name) => process.env[name])
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  for (const candidate of explicit) {
    const resolved = path.resolve(expandHome(candidate));
    if (isExecutable(resolved)) return resolved;
    warn?.(`${spec.logLabel} binary override is not executable: ${candidate}`);
  }

  for (const dir of agentCliPath().split(path.delimiter)) {
    for (const name of agentCliExecutableCandidates(spec.name)) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }

  // GUI apps on macOS/Linux commonly start without the PATH assembled by
  // nvm/fnm/asdf in the user's shell profile. Only an explicit readiness
  // action performs this synchronous probe; ordinary catalog polling reuses
  // its cache and never blocks the server on shell startup.
  if (process.platform !== 'win32' && /^[A-Za-z0-9_-]+$/.test(spec.name)) {
    const cached = loginShellCache.get(spec.name);
    const cacheLifetime = cached?.executable ? LOGIN_SHELL_HIT_CACHE_MS : LOGIN_SHELL_MISS_CACHE_MS;
    if (cached && Date.now() - cached.checkedAt < cacheLifetime) {
      return cached.executable && isExecutable(cached.executable) ? cached.executable : null;
    }
    if (!probeLoginShell) return null;
    let executable: string | null = null;
    try {
      const result = spawnSync(process.env.SHELL || '/bin/zsh', ['-l', '-i', '-c', `command -v ${spec.name}`], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      if (result.status === 0) {
        const candidate = result.stdout.trim().split(/\r?\n/).at(-1);
        if (candidate) {
          const resolved = path.resolve(expandHome(candidate));
          if (isExecutable(resolved)) executable = resolved;
        }
      }
    } catch {
      // A slow or broken profile is not an Agent failure; managed discovery
      // remains the fallback.
    }
    loginShellCache.set(spec.name, { checkedAt: Date.now(), executable });
    if (executable) return executable;
  }

  return null;
}

/** Resolve according to the product policy: an existing user installation
 * wins in normal operation, with the application-scoped runtime as fallback.
 * Development can isolate either source without uninstalling anything. */
function resolveAgentCliWithPolicy(
  spec: AgentCliSpec,
  warn: ((message: string) => void) | undefined,
  probeLoginShell: boolean,
): string | null {
  const managedId = managedIdForName(spec.name);
  if (!managedId) return resolveSystemAgentCli(spec, warn, probeLoginShell);
  const policy = agentDiscoveryPolicy();
  if (policy === 'managed-only') return managedAgentExecutable(managedId);
  const system = resolveSystemAgentCli(spec, warn, probeLoginShell);
  if (system || policy === 'system-only') return system;
  return managedAgentExecutable(managedId);
}

export function resolveAgentCli(spec: AgentCliSpec, warn?: (message: string) => void): string | null {
  return resolveAgentCliWithPolicy(spec, warn, false);
}

/** Explicit New Chat readiness may pay the one-time login-shell probe needed
 * to find version-manager installations hidden from a GUI process PATH. */
export function resolveAgentCliWithLoginShell(
  spec: AgentCliSpec,
  warn?: (message: string) => void,
): string | null {
  return resolveAgentCliWithPolicy(spec, warn, true);
}

export function agentCliNeedsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

export function commandDir(command: string): string {
  return command.includes('/') || command.includes('\\') ? path.dirname(command) : '';
}
