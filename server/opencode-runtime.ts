import { agentProcessClosed, agentProcessExitDiagnostic, ownAgentProcess, retireAgentProcess, type AgentStopReason } from './agent-process.ts';
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
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  createOpencodeClient,
  type Config,
  type OpencodeClient,
} from '@opencode-ai/sdk';
import type { Config as NativeConfig } from '@opencode-ai/sdk/v2/types';
import { getHostedAccountSession } from './app-config.ts';
import { ensureMcpLauncher } from './agent-mcp.ts';
import { resolveAgentPersona } from './agent-persona.ts';
import { composeAgentRuntimeInstructions } from './agent-runtime-instructions.ts';
import { agentCliPath } from './agent-cli.ts';
import { appDataRoot } from './local-data.ts';
import { logger } from './log.ts';
import {
  hostedAgentRuntime,
  hostedAgentDiagnostic,
  beginHostedAgentTurn,
  completeHostedAgentModel,
  completeHostedAgentTool,
  endHostedAgentTurn,
  releaseHostedAgentChannel,
  startHostedAgentBroker,
  stopHostedAgentBroker,
  HostedAgentToolError,
  type HostedAgentTurnModel,
} from './hosted-agent-broker.ts';
import {
  defaultHostedAgentProfile,
  fetchHostedAgentProfiles,
  type HostedAgentProfile,
} from './hosted-agent-models.ts';
import type { AgentRuntimeDescriptor } from './agent-contract.ts';
import {
  agentToolPrompt,
  agentToolSelection,
  defaultAgentToolInstructions,
  defaultAgentToolViews,
  crewChatChoices,
  enabledAgentTools,
  mcpAgentTools,
  runToolInTurn,
  type AgentToolResult,
  type EnabledAgentTool,
  type TurnToolSnapshot,
} from './default-agent-tools.ts';
import { latestToolCatalog, type ToolCatalog } from './agent-tool-catalog.ts';
import { OpenCodeWarmSlot } from './opencode-warm-slot.ts';
import { filesystemPath } from './filesystem-path.ts';
import { telemetry } from './telemetry.ts';
import { errorDiagnostic, type TelemetryEvent } from '../shared/protocols/http/telemetry.ts';
import { waitForOpenCodeServer, retryOpenCodeHistoryStartup, retireFailedOpenCode } from './opencode-startup.ts';

const log = logger('opencode-runtime');
export const BUNDLED_OPENCODE_VERSION = '1.18.19';
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

/** Native OpenCode skill reads use ripgrep. Keep Windows independent of a
 * user's PATH and of OpenCode's on-demand binary download. */
export function bundledOpenCodeRipgrep(): string | null {
  if (process.platform !== 'win32') return null;
  const resourcesRoot = process.env.STASHBASE_RESOURCES_PATH?.trim();
  if (resourcesRoot) {
    const packaged = path.join(path.resolve(resourcesRoot), 'opencode', 'rg.exe');
    if (fs.existsSync(packaged)) return packaged;
  }
  try {
    const { rgPath } = createRequire(import.meta.url)('@vscode/ripgrep') as { rgPath: string };
    if (fs.existsSync(rgPath)) return rgPath;
  } catch {
    // The stable failure below is preferable to a runtime download or hang.
  }
  return null;
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
  const environment = Object.fromEntries(Object.entries(source).filter(([name]) => {
    const upper = name.toUpperCase();
    return upper === 'STASHBASE_TELEMETRY_DISABLED' || OPEN_CODE_RUNTIME_ENV_KEYS.has(upper) || upper.startsWith('LC_');
  }));
  // Desktop launches omit common CLI directories. Keep the credential filter,
  // but give native shell tools the same executable search path as our other Agents.
  const inheritedPath = Object.entries(environment).find(([name]) => name.toUpperCase() === 'PATH')?.[1];
  for (const name of Object.keys(environment)) if (name.toUpperCase() === 'PATH') delete environment[name];
  return { ...environment, PATH: agentCliPath([], inheritedPath ?? '') };
}

export function openCodeRuntimeEnvironment(
  config: Config,
  username: string,
  password: string,
  root = path.join(appDataRoot(), 'opencode'),
  source = process.env,
): NodeJS.ProcessEnv {
  for (const name of ['data', 'config', 'cache', 'home']) fs.mkdirSync(path.join(root, name), { recursive: true });
  const inherited = safeOpenCodeInheritedEnvironment(source);
  const ripgrep = process.platform === 'win32' ? bundledOpenCodeRipgrep() : null;
  if (process.platform === 'win32' && !ripgrep) {
    throw new Error('Bundled Windows ripgrep is missing from the OpenCode runtime.');
  }
  return {
    ...inherited,
    ...(ripgrep ? { PATH: `${path.dirname(ripgrep)}${path.delimiter}${inherited.PATH ?? ''}` } : {}),
    // A private HOME isolates global configuration. The native discovery flags
    // also prevent walking out of a plain writing folder (whose worktree is /).
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
}

const modelAbilities = () => ({
  attachment: true,
  modalities: { input: ['text', 'image', 'pdf'] as Array<'text' | 'image' | 'pdf'>, output: ['text'] as Array<'text'> },
  tool_call: true,
  reasoning: true,
});

/** One OpenCode model per hosted profile, so each stored message names the
 * profile it ran on and compaction follows that profile's own limits. With no
 * readable list, the broker's unversioned default stands in, as it did before
 * profiles existed. */
function openCodeModels(
  fallback: string,
  profiles: readonly HostedAgentProfile[],
): NonNullable<NonNullable<Config['provider']>[string]['models']> {
  if (profiles.length === 0) return { [fallback]: { name: 'StashBase Agent', ...modelAbilities() } };
  return Object.fromEntries(profiles.map((profile) => [profile.id, {
    name: profile.displayName,
    ...modelAbilities(),
    limit: { context: profile.contextTokenLimit, output: profile.outputTokenLimit },
  }]));
}

export function buildOpenCodeConfig(
  model: { apiKey: string; baseUrl: string; model: string },
  mcp: string,
  mcpEnvironment: Record<string, string> = {},
  persona?: string,
  profiles: readonly HostedAgentProfile[] = [],
  directory?: string,
  tools: readonly EnabledAgentTool[] = [],
): Config & Pick<NativeConfig, 'skills'> {
  // The tools that are on add how to brief them and each one's standing
  // rule to the main agent's instructions; the tools' own models never see
  // them.
  const runtimeInstructions = [
    composeAgentRuntimeInstructions(persona),
    defaultAgentToolInstructions(tools),
  ].filter(Boolean).join('\n\n');
  const toolPermissions = Object.fromEntries(tools.map(({ tool }) => [`stashbase_${tool.agent.toolName}`, 'allow']));
  // Disabling native upward config discovery also disables its instruction-file
  // lookup. Preserve the native filename precedence inside this project, passing
  // the path so OpenCode still owns reading and presenting the instructions.
  const instruction = directory && ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md']
    .map((name) => path.resolve(directory, name)).find((file) => fs.existsSync(file));
  const defaultModel = defaultHostedAgentProfile(profiles)?.id ?? model.model;
  const permission = {
    // Native edit/write/patch tools handle requested files outside the project.
    // Their grants stay separate from automatic project MCP edits.
    edit: 'ask',
    bash: 'ask',
    webfetch: 'ask',
    doom_loop: 'ask',
    external_directory: 'ask',
    stashbase_write_file: 'ask',
    stashbase_edit_file: 'ask',
    stashbase_move_file: 'ask',
    stashbase_delete_file: 'ask',
    stashbase_create_project: 'ask',
    stashbase_create_interactive_note: 'ask',
    // OpenCode's own sub-agents would rerun the main model with the whole
    // runtime context; Default's other models are tools instead.
    task: 'deny',
    ...toolPermissions,
  } as NonNullable<Config['permission']> & Record<string, 'ask' | 'allow' | 'deny'>;
  return {
    autoupdate: false,
    share: 'disabled',
    enabled_providers: ['stashbase'],
    skills: { paths: ['.agents/skills', '.claude/skills', '.opencode/skills', '.opencode/skill'] },
    ...(instruction ? { instructions: [instruction] } : {}),
    model: `stashbase/${defaultModel}`,
    small_model: `stashbase/${defaultModel}`,
    provider: {
      stashbase: {
        name: 'StashBase',
        npm: '@ai-sdk/openai-compatible',
        options: {
          apiKey: model.apiKey,
          baseURL: model.baseUrl,
          timeout: false,
        },
        models: openCodeModels(model.model, profiles),
      },
    },
    mcp: {
      stashbase: {
        type: 'local',
        command: [mcp],
        ...(Object.keys(mcpEnvironment).length || tools.length ? {
          environment: {
            ...mcpEnvironment,
            // The MCP host registers only the tools enabled for this
            // session, by the catalog's names and descriptions.
            ...(tools.length ? { STASHBASE_AGENT_TOOLS: JSON.stringify(mcpAgentTools(tools)) } : {}),
          },
        } : {}),
        enabled: true,
        timeout: 10_000,
      },
    },
    agent: {
      'stashbase-folder': {
        description: 'The StashBase Agent for one authorized project folder.',
        mode: 'primary',
        prompt: runtimeInstructions,
      },
      'stashbase-edit': {
        description: 'Edit project documents; ask before commands and other actions.',
        mode: 'primary',
        prompt: runtimeInstructions,
      },
      'stashbase-plan': {
        description: 'Explore the project without changing files or running commands.',
        mode: 'primary',
        prompt: `${runtimeInstructions}\n\nPlan mode: read, discuss, and show proposed text in chat. Selected crew members may return text. Do not write files or run commands.`,
        permission: {
          '*': 'deny',
          read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
          webfetch: 'ask', websearch: 'allow', external_directory: 'ask', question: 'allow',
          stashbase_list_projects: 'allow', stashbase_list_directory: 'allow',
          stashbase_read_file: 'allow', stashbase_search_project: 'allow',
          // A tool only returns text, which Plan shows in chat.
          ...toolPermissions,
        } as typeof permission,
      },
    },
    permission,
  };
}

function openCodeConfig(
  model: { apiKey: string; baseUrl: string; model: string },
  mcpEnvironment: Record<string, string>,
  persona: string | undefined,
  profiles: readonly HostedAgentProfile[],
  directory: string,
  tools: readonly EnabledAgentTool[],
): Config {
  return buildOpenCodeConfig(model, ensureMcpLauncher(), mcpEnvironment, persona, profiles, directory, tools);
}

class OpenCodeRuntime {
  private running: RunningOpenCode | null = null;
  private starting: Promise<RunningOpenCode> | null = null;
  private startingProcess: RunningOpenCode['process'] | null = null;
  private closing: Promise<void> | null = null;
  private generation = 0;
  private retirementFailure: unknown;
  private readonly exitListeners = new Set<(error: Error) => void>();

  constructor(
    private readonly mcpEnvironment: Record<string, string> = {},
    private readonly persona?: string,
    private readonly requireAccount = true,
    private readonly agentSessionId = 'history',
    private readonly profiles: () => readonly HostedAgentProfile[] = () => [],
    private readonly tools: () => readonly EnabledAgentTool[] = () => [],
    private readonly purpose: 'history' | 'chat' | 'prewarm' = 'chat',
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
            message: 'Sign in to StashBase to use the Default Agent and its free credits.',
            retryable: true,
          },
        },
        error: 'Sign in to StashBase to use the Default Agent.',
      };
    }
    return {
      installHint: '',
      launchCommand: 'Bundled with StashBase',
      installed: true,
      source: 'bundled',
      state: 'available',
      bootstrap: { phase: 'ready', progress: 1, message: 'The Default Agent is ready.' },
    };
  }

  async client(directory: string, retryHistoryStartup = false): Promise<OpencodeClient> {
    const running = await this.start(directory, retryHistoryStartup);
    return createOpencodeClient({
      baseUrl: running.url,
      directory,
      headers: { authorization: running.authorization },
      throwOnError: true,
    });
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  close(reason: AgentStopReason = 'session_closed'): Promise<void> {
    return this.closing ??= this.retire(reason);
  }

  private async retire(reason: AgentStopReason): Promise<void> {
    this.generation += 1;
    const running = this.running;
    const process = running?.process ?? this.startingProcess;
    this.running = null;
    this.startingProcess = null;
    releaseHostedAgentChannel(this.agentSessionId);
    // Keep the original deadline result, but release this owner after actual
    // closure even if that happens later. Preparation cannot resurrect it.
    const starting = this.starting;
    const retirement = process ? retireAgentProcess(process, reason) : Promise.resolve();
    void Promise.all([process ? agentProcessClosed(process) : Promise.resolve(), starting?.catch(() => {})])
      .then(() => { runtimes.delete(this); });
    await retirement;
    await starting?.catch(() => {});
  }

  private async start(directory: string, retryHistoryStartup: boolean): Promise<RunningOpenCode> {
    if (this.closing) throw new Error('OpenCode startup was cancelled.');
    if (this.retirementFailure) throw this.retirementFailure;
    runtimes.add(this);
    if (this.running && this.running.process.exitCode == null && this.running.process.signalCode == null) return this.running;
    if (this.starting) return this.starting;
    const generation = this.generation;
    const firstAttemptId = crypto.randomUUID();
    const attempt = (index: number) => this.spawn(generation, directory,
      index === 0 ? firstAttemptId : crypto.randomUUID(), index === 0 ? undefined : firstAttemptId);
    const starting = retryHistoryStartup && this.purpose === 'history'
      ? retryOpenCodeHistoryStartup(attempt, () => generation !== this.generation)
      : attempt(0);
    this.starting = starting.finally(() => { this.starting = null; });
    return this.starting;
  }

  private async spawn(generation: number, directory: string, attemptId: string, retryOf?: string): Promise<RunningOpenCode> {
    const capture = telemetry.scoped();
    const started = performance.now();
    let stage: Extract<TelemetryEvent, { event: 'agent_runtime_start_result' }>['stage'] = 'prepare';
    const timings: NonNullable<Extract<TelemetryEvent, { event: 'agent_runtime_start_result' }>['timings']> = {};
    let timingPhase: keyof typeof timings | undefined = 'prepare_ms';
    let phaseStarted = started;
    const advanceTiming = (next?: keyof typeof timings) => {
      const now = performance.now();
      if (timingPhase) timings[timingPhase] = Math.round(now - phaseStarted);
      phaseStarted = now;
      timingPhase = next;
    };
    let firstOutputMs: number | undefined;
    let failure: unknown;
    try {
      const executable = bundledOpenCodeExecutable();
      if (!executable) throw new Error('The bundled OpenCode runtime is missing.');
      if (this.requireAccount && !getHostedAccountSession()) {
        throw new Error('Sign in to StashBase to use the Default Agent.');
      }
      await startHostedAgentBroker();
      if (generation !== this.generation) throw new Error('OpenCode startup was cancelled.');
      const port = await availablePort();
      if (generation !== this.generation) throw new Error('OpenCode startup was cancelled.');
      const username = 'stashbase';
      const password = cryptoRandomSecret();
      const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      const model = hostedAgentRuntime(this.agentSessionId);
      if (!model) throw new Error('The agent model broker is not running.');
      // Private-directory/config preparation can be slow independently of the
      // native spawn call. Neither belongs to the ready-announcement deadline.
      const env = openCodeRuntimeEnvironment(openCodeConfig(model, this.mcpEnvironment, this.persona, this.profiles(), directory, this.tools()), username, password);
      stage = 'spawn';
      advanceTiming('spawn_ms');
      const child = ownAgentProcess(spawn(executable, [
        'serve',
        '--hostname=127.0.0.1',
        `--port=${port}`,
        '--pure',
        '--log-level=WARN',
        '--print-logs',
      ], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      }), { runtime: 'stashbase', purpose: this.purpose, processStartId: attemptId, runtimeVersion: BUNDLED_OPENCODE_VERSION });
      advanceTiming('ready_wait_ms');
      const exitDiagnostic = agentProcessExitDiagnostic(child);
      this.startingProcess = child;

      try {
        stage = 'waiting_ready';
        const url = await waitForOpenCodeServer(child, port, exitDiagnostic, {
          onFirstOutput: () => { firstOutputMs = Math.round(performance.now() - started); },
        });
        advanceTiming();
        if (generation !== this.generation) throw new Error('OpenCode startup was cancelled.');
        this.startingProcess = null;
        const running = { process: child, url, authorization };
        this.running = running;
        stage = 'ready';
        child.once('exit', (code, signal) => {
          if (this.running?.process !== child) return;
          this.running = null;
          const reason = code ?? signal ?? 'unknown';
          const error = exitDiagnostic(`The included agent runtime exited unexpectedly (${reason}).`, code, signal);
          log.warn(error.message);
          for (const listener of this.exitListeners) listener(error);
        });
        return running;
      } catch (error) {
        advanceTiming('cleanup_ms');
        try { return await retireFailedOpenCode(child, error); }
        catch (retiredError) {
          if (retiredError !== error) { this.retirementFailure = retiredError; stage = 'cleanup'; }
          throw retiredError;
        } finally {
          advanceTiming();
          if (!this.retirementFailure && this.startingProcess === child) this.startingProcess = null;
        }
      }
    } catch (error) { failure = error; throw error; }
    finally {
      advanceTiming();
      capture({ event: 'agent_runtime_start_result', runtime: 'stashbase', purpose: this.purpose,
        outcome: generation !== this.generation ? 'cancelled' : failure ? 'failed' : 'success',
        stage, attempt_id: attemptId, ...(retryOf ? { retry_of: retryOf } : {}),
        elapsed_ms: Math.round(performance.now() - started),
        timings,
        ...(firstOutputMs === undefined ? {} : { first_output_ms: firstOutputMs }),
        context: { runtime_version: BUNDLED_OPENCODE_VERSION, process_start_id: attemptId },
        ...(failure ? { diagnostic: errorDiagnostic(failure) } : {}),
      });
    }
  }
}

function cryptoRandomSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

const runtimes = new Set<OpenCodeRuntime>();
// History is local OpenCode state and remains readable while signed out. The
// loopback model broker is configured so the pinned server can start, but it
// cannot reach the hosted gateway without a later authenticated model call.
const historyRuntime = new OpenCodeRuntime({}, undefined, false, 'history', undefined, undefined, 'history');

export interface OpenCodeSessionRuntime {
  /** A prewarmed process already has its own private MCP/broker identity. */
  readonly attributionId?: string;
  /** The hosted model profiles this session offers. Read once, before the
   * first `client`, whose runtime is then configured with the same list. */
  models(): Promise<readonly HostedAgentProfile[]>;
  client(directory: string): Promise<OpencodeClient>;
  beginTurn(turnId: string, model?: HostedAgentTurnModel): void;
  /** The tools enabled when the runtime was configured. */
  tools(): readonly EnabledAgentTool[];
  /** One call on the main Agent's own profile inside the running turn (the
   * Auto permission review); answers its text. */
  complete(
    model: HostedAgentTurnModel,
    messages: ReadonlyArray<{ role: 'system' | 'user'; content: string }>,
    signal?: AbortSignal,
  ): Promise<string>;
  /** One tool call inside the running turn, on the turn's catalog snapshot;
   * answers its text, the tool's name, and the model that ran it. */
  runTool(id: string, task: string | (() => Promise<string>), signal?: AbortSignal): Promise<AgentToolResult>;
  endTurn(): void;
  diagnostic?(): unknown;
  onExit(listener: (error: Error) => void): () => void;
  close(reason?: AgentStopReason): Promise<void>;
}

export type { AgentToolResult } from './default-agent-tools.ts';

interface OpenCodeContext {
  windowId: string;
  directory: string;
  /** The library persona this Chat runs under. */
  persona: string | undefined;
  crew?: string;
}

interface PreparedOpenCode {
  key: string;
  windowId: string;
  directory: string;
  attributionId: string;
  profiles: readonly HostedAgentProfile[];
  tools: readonly EnabledAgentTool[];
  runtime: OpenCodeRuntime;
  ready: Promise<void>;
  close(reason?: AgentStopReason): Promise<void>;
}

const warmSlot = new OpenCodeWarmSlot<PreparedOpenCode>();

function startupKey(context: OpenCodeContext, persona: string | undefined): string {
  return JSON.stringify([
    context.windowId, context.directory, persona, getHostedAccountSession()?.userId,
    // Instruction contents are read natively at prompt time. Its selected
    // path is process configuration and must still be the project's first.
    ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'].find((name) => fs.existsSync(path.join(context.directory, name))),
  ]);
}

/** Each chat owns a server and a private MCP/broker identity. A spare has
 * never run a session or a model request; only that unused server can move
 * to the next chat. Read the catalog afresh before accepting its config. */
export function createOpenCodeSessionRuntime(context: OpenCodeContext): OpenCodeSessionRuntime {
  const persona = resolveAgentPersona(context.persona);
  const choices = context.crew ? crewChatChoices(context.crew) : undefined;
  const key = startupKey(context, persona);
  const prepared = warmSlot.take(key);
  const attributionId = prepared?.attributionId ?? crypto.randomUUID();
  let profiles: readonly HostedAgentProfile[] = [];
  let tools: readonly EnabledAgentTool[] = [];
  let catalog: ToolCatalog | null = null;
  let turn: TurnToolSnapshot | null = null;
  let turnAbort = new AbortController();
  let reading: Promise<readonly HostedAgentProfile[]> | null = null;
  let closed = false;
  const listeners = new Set<(error: Error) => void>();
  const makeRuntime = () => new OpenCodeRuntime({
    STASHBASE_WINDOW_ID: context.windowId,
    STASHBASE_AGENT_SESSION_ID: attributionId,
  }, persona, true, attributionId, () => profiles, () => tools);
  let sessionRuntime = prepared?.runtime ?? makeRuntime();
  const relayExit = (error: Error) => { for (const listener of listeners) listener(error); };
  let stopExitListener = () => {};

  const models = () => reading ??= (async () => {
    const started = performance.now();
    let list: readonly HostedAgentProfile[] = [];
    let toolCatalog: ToolCatalog | null = null;
    // The two catalogs are independent: the main Agent's profiles and the
    // tools' own model pool. Without a tool catalog the chat runs without
    // tools rather than on a guessed configuration.
    await Promise.all([
      fetchHostedAgentProfiles().then((read) => { list = read; })
        .catch((error: unknown) => { log.warn('could not read the agent model list', error); }),
      latestToolCatalog().then((read) => { toolCatalog = read; })
        .catch((error: unknown) => { log.warn('could not read the tool catalog', error); }),
    ]);
    const catalogMs = Math.round(performance.now() - started);
    profiles = list;
    catalog = toolCatalog;
    if (!toolCatalog && Object.values(choices ?? {}).some((choice) => choice?.enabled)) {
      throw new Error('Your selected crew could not be loaded. Retry the connection or turn those members off.');
    }
    if (toolCatalog) {
      const unavailable = defaultAgentToolViews(toolCatalog, choices)
        .filter((view) => view.enabled && (view.unavailable || view.modelProblem));
      const missing = Object.entries(choices ?? {}).find(([id, choice]) => choice?.enabled && !toolCatalog!.tools.some((tool) => tool.id === id));
      if (unavailable.length || missing) throw new Error(`Your selected crew cannot run: ${unavailable.map((view) => `${view.label}: ${view.unavailable ?? view.modelProblem}`).join('; ') || missing?.[0]}. Update Crew before sending again.`);
    }
    tools = toolCatalog ? enabledAgentTools(toolCatalog, choices) : [];
    if (closed) throw new Error('OpenCode startup was cancelled.');
    if (prepared && (!isDeepStrictEqual(list, prepared.profiles)
      || !isDeepStrictEqual(tools, prepared.tools))) {
      stopExitListener();
      await sessionRuntime.close('configuration_changed');
      if (closed) throw new Error('OpenCode startup was cancelled.');
      sessionRuntime = makeRuntime();
    } else if (prepared) {
      // A failed spare is disposable: the explicit connection can retry cold.
      await prepared.ready;
    }
    log.debug('startup preparation', { session_id: attributionId, catalog_ms: catalogMs,
      elapsed_ms: Math.round(performance.now() - started), prewarmed: sessionRuntime === prepared?.runtime });
    return list;
  })();

  function warmNext(): void {
    if (closed || !getHostedAccountSession() || warmSlot.refresh(key)) return;
    const nextId = crypto.randomUUID();
    const nextRuntime = new OpenCodeRuntime({
      STASHBASE_WINDOW_ID: context.windowId, STASHBASE_AGENT_SESSION_ID: nextId,
    }, persona, true, nextId, () => profiles, () => tools, 'prewarm');
    const next: PreparedOpenCode = {
      key, windowId: context.windowId, directory: context.directory,
      attributionId: nextId, profiles, tools, runtime: nextRuntime,
      ready: Promise.resolve(), close: (reason) => nextRuntime.close(reason),
    };
    warmSlot.put(next);
    nextRuntime.onExit(() => warmSlot.discard(next));
    const started = performance.now();
    next.ready = nextRuntime.client(context.directory)
      .then(async (client) => {
        await client.mcp.status({ throwOnError: true });
        log.debug('spare ready', { session_id: nextId, elapsed_ms: Math.round(performance.now() - started) });
      })
      .catch((error: unknown) => {
        log.debug('spare startup failed', error);
        warmSlot.discard(next);
      });
  }

  return {
    attributionId,
    models,
    client: async (directory) => {
      if (!filesystemPath.equal(directory, context.directory)) throw new Error('The OpenCode runtime belongs to another project.');
      await models();
      if (closed) throw new Error('OpenCode startup was cancelled.');
      const started = performance.now();
      const client = await sessionRuntime.client(directory);
      if (closed) throw new Error('OpenCode startup was cancelled.');
      stopExitListener();
      stopExitListener = sessionRuntime.onExit(relayExit);
      log.debug('startup native connection', { session_id: attributionId, elapsed_ms: Math.round(performance.now() - started) });
      return client;
    },
    beginTurn: (turnId, model) => {
      turnAbort.abort();
      turnAbort = new AbortController();
      beginHostedAgentTurn(attributionId, turnId, model);
      turn = { catalog, tools: [...tools], bound: false };
    },
    tools: () => tools,
    complete: (model, messages, signal) => completeHostedAgentModel(attributionId, model, messages, signal),
    runTool: async (id, task, signal) => {
      const snapshot = turn;
      const lifetime = AbortSignal.any([turnAbort.signal, ...(signal ? [signal] : [])]);
      lifetime.throwIfAborted();
      if (!snapshot) throw new Error('Crew members work only inside an agent turn.');
      const brief = typeof task === 'string' ? task : await task();
      lifetime.throwIfAborted();
      return runToolInTurn(snapshot, id, (on) => {
        lifetime.throwIfAborted();
        return completeHostedAgentTool(attributionId, agentToolSelection(on), [
          { role: 'system', content: agentToolPrompt(on.tool) },
          { role: 'user', content: brief },
        ], lifetime);
      }, latestToolCatalog,
      (error) => error instanceof HostedAgentToolError && error.code === 'agent_tool_version_changed', lifetime);
    },
    endTurn: () => {
      turnAbort.abort();
      turn = null;
      endHostedAgentTurn(attributionId);
      // Avoid competing with the first reply. Disposal closes the owner in
      // this same stack, so its queued warm-up sees `closed` and does nothing.
      queueMicrotask(warmNext);
    },
    diagnostic: () => hostedAgentDiagnostic(attributionId),
    onExit: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close: (reason) => { closed = true; turnAbort.abort(); stopExitListener(); return sessionRuntime.close(reason); },
  };
}

export const discardWarmOpenCodeForWindow = (windowId?: string): Promise<void> =>
  warmSlot.clear((entry) => !windowId || entry.windowId === windowId, 'window_closed');
export const discardWarmOpenCodeForFolder = (directory: string): Promise<void> =>
  warmSlot.clear((entry) => filesystemPath.equal(entry.directory, directory), 'scope_removed');

export const openCodeClient = (directory: string, retryStartup = false): Promise<OpencodeClient> => historyRuntime.client(directory, retryStartup);
export const openCodeRuntimeAvailability = () => historyRuntime.availability();
export async function stopOpenCodeRuntime(): Promise<void> {
  // Every owner gets a cleanup attempt even if another runtime timed out.
  const results = await Promise.allSettled([
    warmSlot.clear(() => true, 'app_shutdown'),
    ...[...runtimes].map((runtime) => runtime.close('app_shutdown')),
  ]);
  await stopHostedAgentBroker();
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
