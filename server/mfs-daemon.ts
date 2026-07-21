/**
 * MFS sidecar daemon manager.
 *
 * Spawns `python/stashbase_daemon.py` once per server process, talks to
 * it over stdin/stdout in line-delimited JSON, and matches replies back
 * to requests by an auto-incrementing id. Auto-respawns if the daemon
 * dies (in-flight requests get rejected with the exit info).
 *
 * The daemon owns ONE global Milvus DB in per-machine app data (see
 * `local-data.ts:globalVectorStoreDir`) and is **not** anchored to a default
 * folder home: every opened folder registers an **absolute root** and is indexed
 * into the one collection, keyed by absolute path. The Node side records
 * each bound root here so a respawn can replay them.
 *
 * Python lives in `<project>/python/.venv.nosync/bin/python` after the user
 * runs `pnpm setup:python`. In packaged Electron a portable Python
 * runtime is bundled via `extraResources` and the path is overridden
 * via `STASHBASE_PYTHON` env var (see `electron/main.cjs`).
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { INDEX_EXCLUDED_DIRS, MAX_INDEXABLE_BYTES } from './indexable.ts';
import { NOTE_EXTS } from './format.ts';
import { EventEmitter } from 'node:events';
import { CONVERTIBLE_SOURCE_EXTENSIONS } from '../shared/file-formats.ts';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { logger } from './log.ts';
import { globalVectorStoreDir } from './local-data.ts';
import { filesystemPath } from './filesystem-path.ts';

const log = logger('mfs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.STASHBASE_APP_ROOT
  ? path.resolve(process.env.STASHBASE_APP_ROOT)
  : path.resolve(__dirname, '..');
const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : PROJECT_ROOT;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Ceiling for one op's reply. A daemon that is alive but never replies
 *  (main thread stuck inside a C extension — observed during a Milvus
 *  Lite flock fight with a second StashBase-spawned daemon) used to hang
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
 *  but never prints `ready` (blocked acquiring the Milvus Lite flock
 *  held by another process) would leave `readyP` — and therefore every
 *  call() — pending forever. */
const READY_TIMEOUT_MS = 90_000;

export interface BindFolderArgs {
  provider: 'openai';
  apiKey?: string;
  model?: string;
  dimension?: number;
}

/** Singleton-ish handle. Use `getDaemon()` to access. */
class MfsDaemon extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyP: Promise<void> | null = null;
  /** Bumps every time we (re)spawn the Python process. Callers that
   *  cache "I already configured this daemon" state can compare against
   *  the value at config time — if it changed, re-issue the config op. */
  private generation = 0;

  /** Every folder root the server has asked us to bind. Keyed by comparison
   *  identity while retaining the first source spelling for daemon replay. */
  private bindings = new Map<string, { folder: string; cfg: BindFolderArgs }>();

  /** Spawn (idempotent) and resolve once the daemon emits `ready`. */
  async ensureReady(): Promise<void> {
    if (this.readyP) return this.readyP;
    this.readyP = this.spawnAndWait();
    return this.readyP;
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
      catch (err) { log.warn(`unbind_folder ${source} failed: ${(err as Error).message}`); }
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

  private spawnAndWait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const daemon = resolveDaemonCommand();
      log.info(`spawning ${daemon.command} ${daemon.args.join(' ')}`);
      const proc = spawn(daemon.command, daemon.args, {
        cwd: daemon.cwd,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          // Milvus Lite spins up its own gRPC server in-process; pymilvus
          // client's default keepalive ping (every 10s) is too aggressive
          // for that loopback server and trips a `ENHANCE_YOUR_CALM`
          // GOAWAY ~every minute. The reconnect is transparent — only
          // the log is noisy. Drop gRPC's INFO chatter to ERROR.
          GRPC_VERBOSITY: process.env.GRPC_VERBOSITY ?? 'ERROR',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      this.generation += 1;

      // Ready-handshake watchdog — see READY_TIMEOUT_MS. SIGKILL (not
      // SIGTERM): a child stuck acquiring the Milvus flock is blocked in
      // a C extension and won't run a signal handler. The exit handler
      // below turns the kill into a rejection callers can observe.
      const readyTimer = setTimeout(() => {
        log.warn(`daemon did not report ready within ${READY_TIMEOUT_MS / 1000}s — killing`);
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      }, READY_TIMEOUT_MS);
      readyTimer.unref();
      let ready = false;
      const failAll = (err: Error) => {
        for (const slot of this.pending.values()) slot.reject(err);
        this.pending.clear();
        if (this.proc === proc) this.proc = null;
        this.readyP = null;
      };
      const onReady = () => {
        ready = true;
        clearTimeout(readyTimer);
        resolve();
      };

      const lines = readline.createInterface({ input: proc.stdout });
      lines.on('line', (line) => this.onLine(line, onReady));

      proc.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(`[mfs/py] ${chunk.toString()}`);
      });

      proc.on('error', (err) => {
        clearTimeout(readyTimer);
        log.warn(`MFS daemon spawn failed: ${err.message}`);
        failAll(err);
        reject(err);
      });

      proc.on('exit', (code, signal) => {
        clearTimeout(readyTimer);
        const err = new Error(
          `MFS daemon exited (code=${code}, signal=${signal ?? 'null'})`,
        );
        log.warn(`${err.message}`);
        failAll(err);
        // If we never got `ready`, surface the failure to the caller.
        if (!ready) reject(err);
      });
    });
  }

  private onLine(line: string, readyResolve: () => void): void {
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
        // Push the indexing rules before anything else: Node is the
        // single source of truth for admission knowledge
        // (server/indexable.ts / format.ts) — the daemon's built-in
        // copies are only fallbacks, and silent drift between the two
        // produces permanent pending or delete/re-embed oscillation.
        // An old PyInstaller binary that doesn't
        // know the op gets a loud warning instead of silent drift.
        this.call('set_rules', {
          excluded_dirs: [...INDEX_EXCLUDED_DIRS],
          max_indexable_bytes: MAX_INDEXABLE_BYTES,
          include_extensions: [
            ...NOTE_EXTS.map((e) => `.${e}`),
            // Convertible sources (PDF/image/DOCX/audio) are TRACKED by the disk walk so
            // their index entry — whose content is the app-data derived note,
            // indexed under the source path — isn't orphan-deleted, and so
            // scan_diff detects source changes. The daemon only lists/hashes
            // them; the markdown content is pushed by the conversion path.
            ...CONVERTIBLE_SOURCE_EXTENSIONS.map((extension) => `.${extension}`),
          ],
        }).catch((err) => log.warn(
          `set_rules failed — daemon binary may predate rule push, indexing rules can drift ` +
            `(rebuild with: pnpm build:python-sidecar): ${(err as Error).message}`,
        ));
        // Replay every folder binding the renderer has seen so far so a
        // crash + respawn doesn't strand the daemon empty-handed. Fire-
        // and-forget; if any individual rebind fails, the next user op
        // for that folder surfaces the error.
        if (this.bindings.size > 0) {
          for (const { folder, cfg } of this.bindings.values()) {
            this.call('bind_folder', {
              folder,
              folder_identity: filesystemPath.identity(folder),
              provider: cfg.provider,
              ...(cfg.apiKey ? { api_key: cfg.apiKey } : {}),
              ...(cfg.model ? { model: cfg.model } : {}),
              ...(cfg.dimension ? { dimension: cfg.dimension } : {}),
            }).catch((err) => log.warn(`rebind ${folder} after respawn failed: ${(err as Error).message}`));
          }
        }
        readyResolve();
      } else if (msg.event === 'starting') {
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
        void this.close();
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
    const proc = this.proc;
    this.proc = null;
    this.readyP = null;
    // Reject any in-flight calls so awaiters don't hang forever once
    // the process is gone.
    const inflight = [...this.pending.values()];
    this.pending.clear();
    const closeErr = new Error('MFS daemon closing');
    for (const slot of inflight) slot.reject(closeErr);
    if (!proc) return;
    proc.stdin.end();
    // Escalation ladder: graceful EOF → SIGTERM → SIGKILL. The Python
    // signal handler can't run while the main thread is blocked inside
    // a C extension (Milvus Lite, ONNX), so a stuck daemon won't die
    // on SIGTERM. SIGKILL can't be caught — guarantees the slot frees
    // up so the next bind doesn't trip on a stale flock.
    await new Promise<void>((resolve) => {
      let exited = false;
      proc.once('exit', () => { exited = true; resolve(); });
      setTimeout(() => {
        if (exited) return;
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      }, 1500);
      setTimeout(() => {
        if (exited) return;
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        setTimeout(() => { if (!exited) resolve(); }, 500);
      }, 3000);
    });
  }
}

/** Locate the Python binary. Precedence:
 *   1. ``STASHBASE_PYTHON`` env (used by packaged Electron to point at the
 *      bundled portable runtime under ``process.resourcesPath``).
 *   2. ``python/.venv.nosync/bin/python`` populated by ``pnpm setup:python``.
 *   3. system ``python3`` — last resort, gives a clearer error if mfs-cli
 *      isn't installed than just failing to spawn. */
function resolvePythonBin(): string {
  const bin = (() => {
    if (process.env.STASHBASE_PYTHON) return process.env.STASHBASE_PYTHON;
    // The packaged runtime / venv live under RESOURCES_ROOT; in dev
    // RESOURCES_ROOT falls back to PROJECT_ROOT, so a stray `python/.venv`
    // (e.g. copied in from another checkout) would shadow the dev
    // `python/.venv.nosync`. Skip the packaged candidates in dev — same
    // guard as resolveDaemonBinary. STASHBASE_PYTHON still wins.
    if (!process.env.STASHBASE_DEV_VITE) {
      for (const candidate of pythonCandidates(path.join(RESOURCES_ROOT, 'python', 'runtime'))) {
        if (existsSync(candidate)) return candidate;
      }
      for (const candidate of pythonCandidates(path.join(RESOURCES_ROOT, 'python', '.venv'))) {
        if (existsSync(candidate)) return candidate;
      }
    }
    for (const candidate of pythonCandidates(path.join(PROJECT_ROOT, 'python', '.venv.nosync'))) {
      if (existsSync(candidate)) return candidate;
    }
    log.warn('python/.venv.nosync not found, falling back to system `python3`');
    return 'python3';
  })();

  // Bounded synchronous probe. This runs on the Node main thread at
  // daemon spawn, so an interpreter whose import deadlocks (e.g. a
  // corrupt venv where `import openai` never returns) would otherwise
  // block the event loop forever and wedge the whole server. A timeout
  // turns that into a clear, recoverable error instead.
  const probe = spawnSync(bin, ['-c', 'import mfs, openai, numpy'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (probe.status !== 0) {
    const reason = probe.error
      ? probe.error.message
      : ((probe.stderr || '').trim().split('\n').pop() ?? '');
    throw new Error(
      `Python sidecar deps missing or unusable at ${bin}\n` +
        `  ${reason}\n` +
        `  → fix: pnpm setup:python`,
    );
  }
  return bin;
}

function pythonCandidates(root: string): string[] {
  return process.platform === 'win32'
    ? [
        path.join(root, 'Scripts', 'python.exe'),
        path.join(root, 'bin', 'python'),
      ]
    : [
        path.join(root, 'bin', 'python'),
        path.join(root, 'Scripts', 'python.exe'),
      ];
}

function resolveDaemonCommand(): { command: string; args: string[]; cwd: string } {
  const binary = resolveDaemonBinary();
  const storeArgs = ['--store-root', globalVectorStoreDir()];
  if (binary) {
    return { command: binary, args: [...storeArgs], cwd: path.dirname(binary) };
  }
  const pythonBin = resolvePythonBin();
  const script = resolvePythonDaemonScript();
  return { command: pythonBin, args: ['-u', script, ...storeArgs], cwd: PROJECT_ROOT };
}

function resolveDaemonBinary(): string | null {
  // PyInstaller --onedir output: `python/sidecar.nosync/stashbase-daemon/stashbase-daemon`
  // (the outer name is the directory, the inner name is the executable).
  // Repo build dir carries `.nosync` so iCloud leaves it intact; inside the
  // packaged .app it's plain `sidecar` (Resources isn't synced).
  //
  // In dev (`pnpm dev` sets STASHBASE_DEV_VITE) skip BOTH project-dir
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
    process.env.STASHBASE_DEV_VITE
      ? undefined
      : sidecarExecutable(path.join(RESOURCES_ROOT, 'python', 'sidecar'), 'stashbase-daemon'),
    process.env.STASHBASE_DEV_VITE
      ? undefined
      : sidecarExecutable(path.join(RESOURCES_ROOT, 'python', 'sidecar'), 'stashbase-daemon', { direct: true }),
    process.env.STASHBASE_DEV_VITE
      ? undefined
      : sidecarExecutable(path.join(PROJECT_ROOT, 'python', 'sidecar.nosync'), 'stashbase-daemon'),
    process.env.STASHBASE_DEV_VITE
      ? undefined
      : sidecarExecutable(path.join(PROJECT_ROOT, 'python', 'sidecar.nosync'), 'stashbase-daemon', { direct: true }),
  ].filter(Boolean) as string[];
  return candidates.find(isFile) ?? null;
}

function sidecarExecutable(root: string, name: string, opts: { direct?: boolean } = {}): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return opts.direct
    ? path.join(root, exe)
    : path.join(root, name, exe);
}

function isFile(candidate: string): boolean {
  try { return statSync(candidate).isFile(); } catch { return false; }
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
