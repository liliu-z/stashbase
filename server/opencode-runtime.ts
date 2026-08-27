/**
 * App-scoped owner of the pinned OpenCode headless server.
 *
 * This is deliberately the only module that knows where the bundled binary
 * lives, which environment isolates its state, or how its native SDK is
 * authenticated. Agent adapters receive a directory-scoped client and keep
 * the renderer on StashBase's stable Agent protocol.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  createOpencodeClient,
  type Config,
  type OpencodeClient,
} from '@opencode-ai/sdk';
import { getHostedAccountSession } from './app-config.ts';
import { ensureMcpLauncher } from './agent-mcp.ts';
import { buildStashbasePreamble } from './agent-preamble.ts';
import { appDataRoot } from './local-data.ts';
import { logger } from './log.ts';
import {
  hostedAgentRuntime,
  beginHostedAgentTurn,
  endHostedAgentTurn,
  releaseHostedAgentChannel,
  startHostedAgentBroker,
  stopHostedAgentBroker,
} from './hosted-agent-broker.ts';
import type { AgentRuntimeDescriptor } from './agent-contract.ts';

const log = logger('opencode-runtime');
export const BUNDLED_OPENCODE_VERSION = '1.18.19';
const START_TIMEOUT_MS = 15_000;
const OPEN_CODE_RUNTIME_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TMP', 'TEMP', 'TMPDIR',
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'SHELL',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
]);

interface RunningOpenCode {
  process: ChildProcessByStdio<null, Readable, Readable>;
  url: string;
  authorization: string;
}

function unpackedPath(file: string): string {
  return file.includes(`${path.sep}app.asar${path.sep}`)
    ? file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    : file;
}

/** Resolve only the package-owned postinstall target. We never fall back to
 * PATH: a user's unrelated OpenCode version must not change this adapter. */
export function bundledOpenCodeExecutable(): string | null {
  const resourcesRoot = process.env.STASHBASE_RESOURCES_PATH?.trim();
  const root = process.env.STASHBASE_APP_ROOT?.trim()
    ? path.resolve(process.env.STASHBASE_APP_ROOT)
    : path.resolve(process.cwd());
  const candidates = [
    ...(resourcesRoot
      ? [path.join(path.resolve(resourcesRoot), 'opencode', 'opencode.exe')]
      : []),
    unpackedPath(path.join(root, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')),
  ];
  try {
    const packageJson = createRequire(import.meta.url).resolve('opencode-ai/package.json');
    candidates.push(unpackedPath(path.join(path.dirname(packageJson), 'bin', 'opencode.exe')));
  } catch {
    // Package verification reports the stable missing-runtime failure below.
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function availablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve an OpenCode port.'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

/** Keep only process plumbing needed to launch the bundled runtime. Provider
 * credentials, user OpenCode settings, proxy credentials, and Electron/Node
 * injection flags must never cross into the private Agent process. */
export function safeOpenCodeInheritedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => {
    const upper = name.toUpperCase();
    return OPEN_CODE_RUNTIME_ENV_KEYS.has(upper) || upper.startsWith('LC_');
  }));
}

function privateRuntimeEnvironment(config: Config, username: string, password: string): NodeJS.ProcessEnv {
  const root = path.join(appDataRoot(), 'opencode');
  for (const name of ['data', 'config', 'cache', 'home']) fs.mkdirSync(path.join(root, name), { recursive: true });
  return {
    ...safeOpenCodeInheritedEnvironment(process.env),
    // OpenCode discovers ecosystem config and skills under the user home even
    // in headless mode. Give the bundled runtime a private home so only the
    // process-injected StashBase config participates.
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
}

export function buildOpenCodeConfig(
  model: { apiKey: string; baseUrl: string; model: string },
  mcp: string,
  mcpEnvironment: Record<string, string> = {},
  preamble?: string,
): Config {
  const permission = {
    edit: 'ask',
    bash: 'ask',
    webfetch: 'ask',
    doom_loop: 'ask',
    external_directory: 'deny',
    stashbase_write_file: 'ask',
    stashbase_edit_file: 'ask',
    stashbase_move_file: 'ask',
    stashbase_delete_file: 'ask',
    stashbase_create_project: 'ask',
  } as NonNullable<Config['permission']> & Record<string, 'ask' | 'allow' | 'deny'>;
  return {
    autoupdate: false,
    share: 'disabled',
    enabled_providers: ['stashbase'],
    model: `stashbase/${model.model}`,
    small_model: `stashbase/${model.model}`,
    provider: {
      stashbase: {
        name: 'StashBase',
        npm: '@ai-sdk/openai-compatible',
        options: {
          apiKey: model.apiKey,
          baseURL: model.baseUrl,
          timeout: false,
        },
        models: {
          [model.model]: {
            name: 'DeepSeek',
            tool_call: true,
            reasoning: true,
          },
        },
      },
    },
    mcp: {
      stashbase: {
        type: 'local',
        command: [mcp],
        ...(Object.keys(mcpEnvironment).length ? { environment: mcpEnvironment } : {}),
        enabled: true,
        timeout: 10_000,
      },
    },
    agent: {
      'stashbase-folder': {
        description: 'StashBase Agent for one authorized library folder.',
        mode: 'primary',
        ...(preamble ? { prompt: preamble } : {}),
      },
      'stashbase-library': {
        description: 'StashBase Agent for the authorized library.',
        mode: 'primary',
        ...(preamble ? { prompt: preamble } : {}),
        // A Library chat spans a non-contiguous set of registered folders.
        // Native cwd tools cannot express that membership boundary, so this
        // mode reaches files only through the scoped StashBase MCP server.
        tools: {
          read: false,
          write: false,
          edit: false,
          patch: false,
          apply_patch: false,
          glob: false,
          grep: false,
          bash: false,
          task: false,
        },
        permission: {
          edit: 'deny',
          bash: 'deny',
          webfetch: 'ask',
          doom_loop: 'ask',
          external_directory: 'deny',
        },
      },
    },
    permission,
  };
}

function openCodeConfig(
  model: { apiKey: string; baseUrl: string; model: string },
  mcpEnvironment: Record<string, string>,
  preamble?: string,
): Config {
  return buildOpenCodeConfig(model, ensureMcpLauncher(), mcpEnvironment, preamble);
}

class OpenCodeRuntime {
  private running: RunningOpenCode | null = null;
  private starting: Promise<RunningOpenCode> | null = null;
  private startingProcess: RunningOpenCode['process'] | null = null;
  private generation = 0;

  constructor(
    private readonly mcpEnvironment: Record<string, string> = {},
    private readonly preamble?: string,
    private readonly requireAccount = true,
    private readonly agentSessionId = 'history',
  ) {
    runtimes.add(this);
  }

  availability(): Omit<AgentRuntimeDescriptor, 'id' | 'label' | 'vendor' | 'endpoint' | 'capabilities'> {
    const executable = bundledOpenCodeExecutable();
    if (!executable) {
      return {
        installHint: '',
        launchCommand: 'Bundled with StashBase',
        installed: false,
        source: 'bundled',
        state: 'failed',
        bootstrap: {
          phase: 'failed',
          failure: {
            stage: 'installation',
            code: 'runtime-unavailable',
            message: 'The bundled OpenCode runtime is missing. Reinstall StashBase to repair it.',
            retryable: false,
          },
        },
        error: 'The bundled OpenCode runtime is missing.',
      };
    }
    if (!getHostedAccountSession()) {
      return {
        installHint: '',
        launchCommand: 'Bundled with StashBase',
        installed: true,
        source: 'bundled',
        state: 'failed',
        bootstrap: {
          phase: 'failed',
          failure: {
            stage: 'authentication',
            code: 'account-required',
            message: 'Sign in to StashBase to use the included weekly Agent allowance.',
            retryable: true,
          },
        },
        error: 'Sign in to StashBase to use StashBase Agent.',
      };
    }
    return {
      installHint: '',
      launchCommand: 'Bundled with StashBase',
      installed: true,
      source: 'bundled',
      state: 'available',
      bootstrap: { phase: 'ready', progress: 1, message: 'StashBase Agent is ready.' },
    };
  }

  async client(directory: string): Promise<OpencodeClient> {
    const running = await this.start();
    return createOpencodeClient({
      baseUrl: running.url,
      directory,
      headers: { authorization: running.authorization },
      throwOnError: true,
    });
  }

  async close(): Promise<void> {
    this.generation += 1;
    const running = this.running;
    const process = running?.process ?? this.startingProcess;
    this.running = null;
    this.startingProcess = null;
    runtimes.delete(this);
    releaseHostedAgentChannel(this.agentSessionId);
    if (process) {
      process.kill('SIGTERM');
      const timeout = setTimeout(() => {
        if (process.exitCode == null) process.kill('SIGKILL');
      }, 1_500);
      timeout.unref?.();
      await new Promise<void>((resolve) => {
        if (process.exitCode != null) resolve();
        else process.once('exit', () => resolve());
      });
      clearTimeout(timeout);
    }
  }

  private async start(): Promise<RunningOpenCode> {
    runtimes.add(this);
    if (this.running && this.running.process.exitCode == null) return this.running;
    if (this.starting) return this.starting;
    const generation = this.generation;
    this.starting = this.spawn(generation).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async spawn(generation: number): Promise<RunningOpenCode> {
    const executable = bundledOpenCodeExecutable();
    if (!executable) throw new Error('The bundled OpenCode runtime is missing.');
    if (this.requireAccount && !getHostedAccountSession()) {
      throw new Error('Sign in to StashBase to use StashBase Agent.');
    }
    await startHostedAgentBroker();
    if (generation !== this.generation) throw new Error('OpenCode startup was cancelled.');
    const port = await availablePort();
    if (generation !== this.generation) throw new Error('OpenCode startup was cancelled.');
    const username = 'stashbase';
    const password = cryptoRandomSecret();
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const model = hostedAgentRuntime(this.agentSessionId);
    if (!model) throw new Error('The StashBase Agent model broker is not running.');
    const child = spawn(executable, [
      'serve',
      '--hostname=127.0.0.1',
      `--port=${port}`,
      '--pure',
      '--log-level=WARN',
    ], {
      env: privateRuntimeEnvironment(openCodeConfig(model, this.mcpEnvironment, this.preamble), username, password),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.startingProcess = child;

    try {
      const url = await waitForServer(child, port);
      if (generation !== this.generation) throw new Error('OpenCode startup was cancelled.');
      this.startingProcess = null;
      const running = { process: child, url, authorization };
      this.running = running;
      child.once('exit', (code, signal) => {
        if (this.running?.process === child) this.running = null;
        if (code !== 0 && signal !== 'SIGTERM') log.warn(`OpenCode exited (${code ?? signal ?? 'unknown'}).`);
      });
      return running;
    } catch (error) {
      if (this.startingProcess === child) this.startingProcess = null;
      child.kill('SIGKILL');
      throw error;
    }
  }
}

function cryptoRandomSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function waitForServer(child: ChildProcessByStdio<null, Readable, Readable>, expectedPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(url!);
    };
    const inspect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-16_384);
      const match = output.match(/opencode server listening on (https?:\/\/[^\s]+)/);
      if (!match) return;
      const url = new URL(match[1]);
      if (url.hostname !== '127.0.0.1' || Number(url.port) !== expectedPort) {
        finish(new Error('OpenCode bound an unexpected address.'));
        return;
      }
      finish(undefined, url.toString().replace(/\/$/, ''));
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`OpenCode exited during startup (${code}). ${output.trim()}`)));
    const timeout = setTimeout(() => {
      finish(new Error(`OpenCode did not start within ${START_TIMEOUT_MS}ms. ${output.trim()}`));
    }, START_TIMEOUT_MS);
  });
}

const runtimes = new Set<OpenCodeRuntime>();
// History is local OpenCode state and remains readable while signed out. The
// loopback model broker is configured so the pinned server can start, but it
// cannot reach the hosted gateway without a later authenticated model call.
const historyRuntime = new OpenCodeRuntime({}, undefined, false);

export interface OpenCodeSessionRuntime {
  client(directory: string): Promise<OpencodeClient>;
  beginTurn(turnId: string, profile?: string): void;
  endTurn(): void;
  close(): Promise<void>;
}

/** A panel session receives its own server so the MCP child inherits the
 * exact window and live-session attribution. This prevents one concurrent
 * chat from borrowing another chat's privileged host-side action. */
export function createOpenCodeSessionRuntime(
  context: {
    windowId: string;
    agentSessionId: string;
    cwd: string;
    scope: 'folder' | 'library';
  },
): OpenCodeSessionRuntime {
  const sessionRuntime = new OpenCodeRuntime({
    STASHBASE_WINDOW_ID: context.windowId,
    STASHBASE_AGENT_SESSION_ID: context.agentSessionId,
  }, buildStashbasePreamble(context.cwd, context.scope), true, context.agentSessionId);
  return {
    client: (directory) => sessionRuntime.client(directory),
    beginTurn: (turnId, profile) => beginHostedAgentTurn(context.agentSessionId, turnId, profile),
    endTurn: () => endHostedAgentTurn(context.agentSessionId),
    close: () => sessionRuntime.close(),
  };
}

export const openCodeClient = (directory: string): Promise<OpencodeClient> => historyRuntime.client(directory);
export const openCodeRuntimeAvailability = () => historyRuntime.availability();
export async function stopOpenCodeRuntime(): Promise<void> {
  await Promise.all([...runtimes].map((runtime) => runtime.close()));
  await stopHostedAgentBroker();
}
