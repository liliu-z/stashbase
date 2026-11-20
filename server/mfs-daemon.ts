/**
 * MFS sidecar daemon manager.
 *
 * Spawns `python/stashbase_daemon.py` once per server process, talks to
 * it over stdin/stdout in line-delimited JSON, and matches replies back
 * to requests by an auto-incrementing id. Auto-respawns if the daemon
 * dies (in-flight requests get rejected with the exit info).
 *
 * The daemon owns one MFS store in per-machine app data (see
 * `local-data.ts:globalVectorStoreDir`). Every Folder registers an absolute
 * root and maps to one MFS Internal namespace. The Node side records each
 * binding here so a respawn can replay it.
 *
 * Development runs the script with the interpreter `python-host.ts`
 * resolves (`STASHBASE_PYTHON`, or the `pnpm setup:python` venv). Packaged
 * Electron ships the PyInstaller daemon via `extraResources` instead and
 * passes it as `STASHBASE_DAEMON_BIN` (see `electron/main.cjs`).
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from './log.ts';
import { isFile, PROJECT_ROOT, pythonBin, RESOURCES_ROOT, sidecarExecutable } from './python-host.ts';
import { globalVectorStoreDir } from './local-data.ts';
import { filesystemPath } from './filesystem-path.ts';
import { isDevelopmentRuntime } from './development-runtime.ts';
import { nativeComponentUnavailable } from './native-component-support.ts';
import type { EmbedderProvider } from '../shared/embedding.ts';
import { diagnosticText } from '../shared/protocols/diagnostics.ts';
import { terminateExtractorTree, waitForExtractorTree } from './extractor-process.ts';

const log = logger('mfs');

const DEVELOPMENT_RUNTIME = isDevelopmentRuntime();

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const MFS_DAEMON_RETIRING = 'MFS_DAEMON_RETIRING';

/** Typed interruption emitted only when Node deliberately retires the shared
 * daemon. Callers whose operation is safe to restart can distinguish this
 * lifecycle edge from a real daemon or indexing failure. */
export class MfsDaemonRetiringError extends Error {
  readonly code = MFS_DAEMON_RETIRING;

  constructor() {
    super('MFS daemon closing');
    this.name = 'MfsDaemonRetiringError';
  }
}

export function isMfsDaemonRetiringError(error: unknown): error is MfsDaemonRetiringError {
  return error instanceof MfsDaemonRetiringError
    || (typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === MFS_DAEMON_RETIRING);
}

/** Ceiling for one op's reply. A daemon that is alive but never replies
 *  (for example while blocked in an MFS dependency during a competing-store
 *  failure) used to hang
 *  its caller forever: `pending` entries only settle on reply, process
 *  exit, or close(). And since the daemon serialises ops, one wedged op
 *  wedges everything queued behind it.
 *
 *  One generous global ceiling, deliberately NOT per-op tiers: a cheap
 *  `status` can legitimately sit minutes in the serial queue behind a
 *  big embed, so tight per-op budgets would false-positive exactly when
 *  the daemon is busiest. 10 min only catches the genuinely-dead case.
 *  On timeout we presume the process is wedged for good: reject and run
 *  close() — its SIGTERM→SIGKILL ladder exists for the stuck-in-C-
 *  extension case — so the next call respawns and replays bindings. */
const CALL_TIMEOUT_MS = 10 * 60_000;

/** Ceiling for the `ready` handshake after spawn. A child that starts
 *  but never prints `ready` (for example while another process owns the MFS
 *  store) would leave `readyP` — and therefore every
 *  call() — pending forever. */
const READY_TIMEOUT_MS = 90_000;

export interface BindFolderArgs {
  provider: EmbedderProvider;
  apiKey?: string;
  model?: string;
  dimension?: number;
  baseUrl?: string;
}

export interface DaemonCommand {
  command: string;
  args: string[];
  cwd: string;
}

/** Singleton-ish handle. Use `getDaemon()` to access. */
export class MfsDaemon extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyP: Promise<void> | null = null;
  /** One retirement barrier for every concurrent close/reset caller. A new
   * generation must not spawn until the previous child has actually exited
   * and released the process-wide daemon lock. */
  private closeP: Promise<void> | null = null;
  private processClosed: Promise<void> | null = null;
  private cancelStartup: ((error: Error) => void) | null = null;
  /** Bumps every time we (re)spawn the Python process. Callers that
   *  cache "I already configured this daemon" state can compare against
   *  the value at config time — if it changed, re-issue the config op. */
  private generation = 0;
  /** Bumps on every close() so a spawn still resolving its command when the
   *  daemon is retired does not bring up a child nobody owns. */
  private retirements = 0;

  /** Every folder root the server has asked us to bind. Keyed by comparison
   *  identity while retaining the first source spelling for daemon replay. */
  private bindings = new Map<string, { folder: string; cfg: BindFolderArgs }>();

  constructor(
    private readonly commandResolver: () => DaemonCommand | Promise<DaemonCommand> = resolveDaemonCommand,
  ) {
    super();
  }

  /** Spawn (idempotent) and resolve only after the daemon has accepted every
   * retained Folder binding. Public operations never race the bootstrap
   * handshake. */
  async ensureReady(): Promise<void> {
    // A reset clears readiness before the child releases its store. Wait
    // through every retirement that became current before this resumes.
    while (this.closeP) await this.closeP;
    if (this.readyP) return this.readyP;
    // Every waiter shares cleanup as well as startup; a failed raw handshake
    // must not let another caller retry while the old process still owns pipes.
    const attempt = this.spawnAndConfigure().catch(async (err: unknown) => {
      if (this.readyP === attempt) {
        try { await this.close(); }
        catch (cleanup) {
          throw new AggregateError([err, cleanup], 'MFS startup failed and its process did not finish closing.', { cause: err });
        }
      }
      throw err;
    });
    this.readyP = attempt;
    return attempt;
  }

  private async spawnAndConfigure(): Promise<void> {
    await this.spawnAndWait();
    for (const { folder, cfg } of this.bindings.values()) {
      await this.callReadyProcess('bind_folder', bindFolderPayload(folder, cfg));
    }
  }

  /** Opaque token identifying the current Python process. Increments on
   *  every respawn. Callers should treat as a black-box equality check. */
  currentGeneration(): number {
    return this.generation;
  }

  /** Issue a `bind_folder` op, recording the binding for replay on a
   *  later respawn. Safe to call repeatedly with the same args (the
   *  daemon-side op is idempotent). */
  async bindFolder(folder: string, cfg: BindFolderArgs): Promise<void> {
    const requested = filesystemPath.absolute(folder);
    const key = filesystemPath.identity(requested);
    const source = this.bindings.get(key)?.folder ?? requested;
    this.bindings.set(key, { folder: source, cfg });
    await this.call('bind_folder', {
      folder: source,
      folder_identity: key,
      provider: cfg.provider,
      ...(cfg.apiKey ? { api_key: cfg.apiKey } : {}),
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.dimension ? { dimension: cfg.dimension } : {}),
      ...(cfg.baseUrl ? { base_url: cfg.baseUrl } : {}),
    });
  }

  /** Drop the renderer-side binding entry AND ask the daemon to stop
   *  routing new files for the folder. Existing rows stay searchable
   *  until explicit delete. */
  async unbindFolder(folder: string): Promise<void> {
    const requested = filesystemPath.absolute(folder);
    const key = filesystemPath.identity(requested);
    const source = this.bindings.get(key)?.folder ?? requested;
    this.bindings.delete(key);
    if (this.proc) {
      try { await this.call('unbind_folder', { folder: source, folder_identity: key }); }
      catch (err) { log.warn(`unbind_folder ${source} failed:`, err); }
    }
  }

  /** Snapshot of every folder currently bound on the renderer side. */
  knownBindings(): ReadonlyMap<string, BindFolderArgs> {
    return new Map([...this.bindings.values()].map(({ folder, cfg }) => [folder, cfg]));
  }

  /** Forget every recorded binding. Used when the global embedder
   *  credential changes: replaying bindings captured with the old key
   *  would recreate the Python embedder with stale credentials before
   *  the fresh bind lands. */
  forgetBindings(): void {
    this.bindings.clear();
  }

  private async spawnAndWait(): Promise<void> {
    const started = performance.now();
    // Resolving the command may probe the Python runtime, which is slow on a
    // loaded machine. No child exists yet, so a close() that lands meanwhile
    // finds nothing to retire; the counter lets that close win instead of
    // this attempt spawning an orphan afterwards.
    const retirementsBefore = this.retirements;
    const daemon = await this.commandResolver();
    if (this.retirements !== retirementsBefore) throw new MfsDaemonRetiringError();
    return new Promise<void>((resolve, reject) => {
      log.info(`spawning ${daemon.command} ${daemon.args.join(' ')}`);
      const spawnStarted = performance.now();
      const proc = spawn(daemon.command, daemon.args, {
        cwd: daemon.cwd,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          // JSON-RPC is UTF-8 in both directions, independent of Windows ANSI locale.
          PYTHONIOENCODING: 'utf-8',
          // MFS's pinned backend spins up a gRPC server in-process; its client
          // client's default keepalive ping (every 10s) is too aggressive
          // for that loopback server and trips a `ENHANCE_YOUR_CALM`
          // GOAWAY ~every minute. The reconnect is transparent — only
          // the log is noisy. Drop gRPC's INFO chatter to ERROR.
          GRPC_VERBOSITY: process.env.GRPC_VERBOSITY ?? 'ERROR',
          // OpenBLAS commits a buffer pool per CPU thread at import: ~1.1 GB on
          // 8 threads that the daemon's light vector math never touches, and a
          // failed start when commit is short. With one thread the whole daemon
          // commits ~0.1 GB. Fixed, not inherited, so a global setting cannot
          // bring the pool back.
          OPENBLAS_NUM_THREADS: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      const spawnReturned = performance.now();
      this.proc = proc;
      this.generation += 1;
      const closed = waitForExtractorTree(proc).then(() => {}, error => {
        if (proc.pid) throw error;
        // A failed spawn never acquired a process or store lease.
      });
      this.processClosed = closed;
      void closed.catch(() => {});

      let ready = false;
      let settled = false;
      let phase = 'spawn';
      let stderr = '';
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        if (this.cancelStartup === finish) this.cancelStartup = null;
        if (error) reject(error);
        else { ready = true; resolve(); }
      };
      this.cancelStartup = finish;
      // Reject with the original timeout, then let the shared startup promise
      // retire the entire tree. Killing only the leader can strand MFS helpers.
      const readyStarted = performance.now();
      const readyTimer = setTimeout(() => {
        const waited = performance.now() - readyStarted;
        // Native spawn can itself block on Windows. Keep that time separate
        // from a late watchdog callback; neither proves slow Python initialization.
        const timing = `prepare_ms=${Math.round(spawnStarted - started)}, spawn_ms=${Math.round(spawnReturned - spawnStarted)}, ready_wait_ms=${Math.round(waited)}, timer_lag_ms=${Math.round(Math.max(0, waited - READY_TIMEOUT_MS))}`;
        finish(Object.assign(new Error(`MFS daemon did not report ready within ${READY_TIMEOUT_MS}ms (last phase: ${phase}; ${timing}).`), {
          code: 'MFS_START_TIMEOUT', ...(stderr ? { stderr: diagnosticText(stderr) } : {}),
        }));
      }, READY_TIMEOUT_MS);
      readyTimer.unref();
      const failAll = (err: Error) => {
        // A retiring generation can report its exit after another lifecycle
        // continuation has begun. It must not reject the current child's work.
        if (this.proc !== proc) return;
        for (const slot of this.pending.values()) slot.reject(err);
        this.pending.clear();
      };
      const onReady = () => {
        if (this.retirements !== retirementsBefore) finish(new MfsDaemonRetiringError());
        else finish();
      };

      const lines = readline.createInterface({ input: proc.stdout });
      lines.on('line', (line) => {
        if (this.proc !== proc || this.retirements !== retirementsBefore || (settled && !ready)) return;
        this.onLine(line, onReady, () => { phase = 'starting'; });
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr = (stderr + text).slice(-8_000);
        process.stderr.write(`[mfs/py] ${text}`);
      });

      proc.on('error', (err) => {
        log.warn(`MFS daemon spawn failed:`, err);
        failAll(err);
        finish(err);
      });

      proc.on('exit', (code, signal) => {
        clearTimeout(readyTimer);
        const err = Object.assign(new Error(
          `MFS daemon exited (code=${code}, signal=${signal ?? 'null'})`,
        ), {
          ...(code === null ? {} : { exitCode: code }),
          ...(signal === null ? {} : { signal }),
          ...(stderr ? { stderr: diagnosticText(stderr) } : {}),
        });
        // Retain the child until final pipe/tree closure, even after leader exit.
        if (this.proc === proc && !this.closeP) log.warn(err);
        else log.info(err.message);
        failAll(err);
        // If we never got `ready`, surface the failure to the caller.
        if (!ready) finish(err);
        else if (this.proc === proc && !this.closeP) void this.close().catch(error => log.warn('daemon retirement failed:', error));
      });
    });
  }

  private onLine(line: string, readyResolve: () => void, onStarting: () => void): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch {
      log.warn(`non-JSON line from daemon: ${line}`);
      return;
    }
    if ('event' in msg) {
      // Namespaced event prefix so a daemon-side `{event:"error"}` doesn't
      // collide with EventEmitter's bare 'error' (which is fatal without
      // a listener).
      this.emit(`daemon:${msg.event}`, msg);
      if (msg.event === 'ready') {
        log.info(`daemon ready: store=${msg.db}`);
        readyResolve();
      } else if (msg.event === 'starting') {
        onStarting();
        log.info(`daemon starting, pid=${msg.pid}`);
      } else if (msg.event === 'error') {
        const hint = /No module named/i.test(msg.error ?? '')
          ? '\n  → Looks like the Python sidecar deps aren\'t installed. Run: pnpm setup:python'
          : '';
        log.warn(`daemon error in ${msg.phase}: ${msg.error}${hint}`);
      }
      return;
    }
    const id = msg.id;
    const slot = this.pending.get(id);
    if (!slot) {
      log.warn(`reply with unknown id=${id}`);
      return;
    }
    this.pending.delete(id);
    if (msg.ok) slot.resolve(msg.result);
    else slot.reject(new Error(msg.error ?? 'daemon error'));
  }

  /** Send one op and await the matching reply. Awaits `ensureReady` first. */
  async call<T = unknown>(op: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureReady();
    return this.callReadyProcess<T>(op, args);
  }

  /** Send one op after the raw process-ready event. Bootstrap uses this
   * directly to avoid awaiting its own configured-ready promise. */
  private async callReadyProcess<T = unknown>(op: string, args: Record<string, unknown>): Promise<T> {
    if (this.closeP) throw new MfsDaemonRetiringError();
    if (!this.proc) throw new Error('MFS daemon not running');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // No-reply watchdog — see CALL_TIMEOUT_MS. The timer is cleared on
      // any settle path (reply, daemon exit, close()) via the wrappers.
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        log.warn(
          `daemon op ${op} (id=${id}) got no reply in ${CALL_TIMEOUT_MS / 60_000}min — ` +
            'presuming wedged, restarting daemon',
        );
        reject(new Error(`daemon op ${op} timed out after ${CALL_TIMEOUT_MS / 60_000}min`));
        void this.close().catch(error => log.warn('daemon retirement failed:', error));
      }, CALL_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc!.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    });
  }

  async close(): Promise<void> {
    if (this.closeP) return this.closeP;
    const proc = this.proc;
    const closed = this.processClosed;
    this.readyP = null;
    this.retirements += 1;
    // Reject any in-flight calls so awaiters don't hang forever once
    // the process is gone.
    const inflight = [...this.pending.values()];
    this.pending.clear();
    const closeErr = new MfsDaemonRetiringError();
    this.cancelStartup?.(closeErr);
    for (const slot of inflight) slot.reject(closeErr);
    if (!proc || !closed) return;
    proc.stdin.end();
    // Allow graceful EOF, then retire the full tree using the shared platform
    // primitive (Windows taskkill /T; POSIX group TERM→KILL). A blocked native
    // import may ignore TERM; sending a signal alone never proves closure.
    const retirement = new Promise<void>((resolve, reject) => {
      const termTimer = setTimeout(() => {
        terminateExtractorTree(proc);
      }, 1500);
      const deadline = setTimeout(() => reject(Object.assign(new Error('MFS daemon did not finish closing after termination.'), {
        code: 'MFS_DAEMON_CLOSE_TIMEOUT',
      })), 3500);
      void closed.then(() => {
        clearTimeout(termTimer);
        clearTimeout(deadline);
        if (this.proc === proc) {
          this.proc = null;
          this.processClosed = null;
          this.closeP = null;
        }
        resolve();
      }, error => {
        clearTimeout(termTimer);
        clearTimeout(deadline);
        reject(error);
      });
    });
    this.closeP = retirement;
    // A deadline rejects callers but fences replacement until actual closure.
    return retirement;
  }
}

/** The interpreter `pythonBin()` selects, once it can import the sidecar deps. */
async function resolvePythonBin(): Promise<string> {
  const bin = pythonBin();
  if (bin === 'python3') log.warn('python/.venv.nosync not found, falling back to system `python3`');
  await probePythonDeps(bin);
  return bin;
}

const PYTHON_PROBE_TIMEOUT_MS = 30_000;
const PYTHON_PROBE_IMPORTS = 'import mfs, openai, numpy';

/** Bounded check that the interpreter can import the sidecar deps, run at
 *  daemon spawn. It stays off the event loop: an interpreter whose import
 *  deadlocks (a corrupt venv where `import openai` never returns), or one that
 *  is merely slow on a loaded machine, must not keep the server from answering
 *  `/api/health` or the app from launching. A timeout turns either into a
 *  clear, recoverable error. SIGKILL, because a child stuck in a native import
 *  may not honor SIGTERM. */
function probePythonDeps(bin: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      bin,
      ['-c', PYTHON_PROBE_IMPORTS],
      { encoding: 'utf8', timeout: PYTHON_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        const reason = error.killed
          ? `${PYTHON_PROBE_IMPORTS} did not finish within ${PYTHON_PROBE_TIMEOUT_MS / 1000}s`
          : typeof error.code === 'string'
            ? error.message
            : ((stderr || '').trim().split('\n').pop() || error.message);
        reject(
          new Error(
            `Python sidecar deps missing or unusable at ${bin}\n` +
              `  ${reason}\n` +
              `  → fix: pnpm setup:python`,
          ),
        );
      },
    );
  });
}

async function resolveDaemonCommand(): Promise<DaemonCommand> {
  const unavailable = nativeComponentUnavailable();
  if (!DEVELOPMENT_RUNTIME && unavailable) throw new Error(unavailable);
  const binary = resolveDaemonBinary();
  const storeArgs = ['--store-root', globalVectorStoreDir()];
  if (binary) {
    return { command: binary, args: [...storeArgs], cwd: path.dirname(binary) };
  }
  const python = await resolvePythonBin();
  const script = resolvePythonDaemonScript();
  return { command: python, args: ['-u', script, ...storeArgs], cwd: PROJECT_ROOT };
}

function bindFolderPayload(folder: string, cfg: BindFolderArgs): Record<string, unknown> {
  return {
    folder,
    folder_identity: filesystemPath.identity(folder),
    provider: cfg.provider,
    ...(cfg.apiKey ? { api_key: cfg.apiKey } : {}),
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.dimension ? { dimension: cfg.dimension } : {}),
    ...(cfg.baseUrl ? { base_url: cfg.baseUrl } : {}),
  };
}

function resolveDaemonBinary(): string | null {
  // PyInstaller --onedir output: `python/sidecar.nosync/stashbase-daemon/stashbase-daemon`
  // (the outer name is the directory, the inner name is the executable).
  // Repo build dir carries `.nosync` so iCloud leaves it intact; inside the
  // packaged .app it's plain `sidecar` (Resources isn't synced).
  //
  // In a development runtime skip BOTH project-dir
  // bundled-binary candidates and run `python/stashbase_daemon.py` from
  // source. A leftover `python/sidecar*` build would otherwise silently
  // shadow the source — and in dev RESOURCES_ROOT falls back to
  // PROJECT_ROOT, so even the non-`.nosync` candidate resolves into the
  // repo. The dev server would then spawn a frozen (possibly broken,
  // e.g. a half-written PyInstaller onedir missing `_internal/Python`)
  // daemon instead of the live script. STASHBASE_DAEMON_BIN still wins
  // when set explicitly.
  const candidates = [
    process.env.STASHBASE_DAEMON_BIN,
    ...(DEVELOPMENT_RUNTIME ? [] : [
      sidecarExecutable(path.join(RESOURCES_ROOT, 'python', 'sidecar'), 'stashbase-daemon'),
      sidecarExecutable(path.join(PROJECT_ROOT, 'python', 'sidecar.nosync'), 'stashbase-daemon'),
    ]),
  ].filter(Boolean) as string[];
  return candidates.find(isFile) ?? null;
}

function resolvePythonDaemonScript(): string {
  const candidates = [
    path.join(RESOURCES_ROOT, 'python', 'stashbase_daemon.py'),
    path.join(PROJECT_ROOT, 'python', 'stashbase_daemon.py'),
  ];
  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) {
    throw new Error(`Python sidecar script not found. Looked in: ${candidates.join(', ')}`);
  }
  return script;
}

let singleton: MfsDaemon | null = null;
export function getDaemon(): MfsDaemon {
  if (!singleton) singleton = new MfsDaemon();
  return singleton;
}
