import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createFilesystemPath } from './filesystem-path.ts';
import { isMfsDaemonRetiringError, MfsDaemon } from './mfs-daemon.ts';
import { errorDiagnostic } from './error-diagnostics.ts';

test('daemon startup timeout retires descendants before allowing a replacement', { timeout: 10_000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-mfs-start-tree-'));
  const helperPidFile = path.join(scratch, 'helper.pid');
  const fixture = path.join(scratch, 'daemon.cjs');
  fs.writeFileSync(fixture, `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify("require('fs').writeFileSync(process.argv[1], String(process.pid)); process.stdout.write(JSON.stringify({event:'fixture-helper-ready'}) + '\\n'); setInterval(() => {}, 1000)")}, process.argv[2]],
      { stdio: ['ignore', process.stdout, process.stderr] });
    setInterval(() => {}, 1000);
  `);
  // Fire only the production ready watchdog after the real helper has started.
  const timeout = globalThis.setTimeout;
  let expire!: () => void;
  t.mock.method(globalThis, 'setTimeout', (fn: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    { if (ms === 90_000) expire = () => fn(...args); return timeout(fn, ms, ...args); });
  let helperPid: number | undefined;
  let healthy = false;
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const daemon = new MfsDaemon(() => {
    clock += 40; // Command/environment preparation is outside the ready watchdog.
    return { command: process.execPath, cwd: scratch,
      args: healthy ? ['-e', "process.stdout.write('{\"event\":\"ready\"}\\n'); process.stdin.resume()"] : [fixture, helperPidFile] };
  });
  t.after(async () => {
    if (helperPid) { try { process.kill(helperPid, 'SIGKILL'); } catch { /* already retired */ } }
    await daemon.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const helperStarted = new Promise<void>(resolve => daemon.once('daemon:fixture-helper-ready', () => resolve()));
  const waiting = daemon.ensureReady().then(() => null, error => error);
  const concurrent = daemon.ensureReady().then(() => null, error => error);
  await helperStarted;
  helperPid = Number(fs.readFileSync(helperPidFile, 'utf8'));
  clock += 90_060; // Model a watchdog callback delivered 60 ms late.
  expire();
  const result = await waiting;
  assert.equal(await concurrent, result, 'all startup callers share the failure and its retirement barrier');
  let helperAlive = true;
  try { process.kill(helperPid, 0); } catch { helperAlive = false; }
  assert.equal(helperAlive, false, 'a timed-out daemon must not leave its helper holding resources');
  assert.equal(errorDiagnostic(result).code, 'MFS_START_TIMEOUT');
  assert.match(errorDiagnostic(result).message!, /prepare_ms=40, spawn_ms=0, ready_wait_ms=90060, timer_lag_ms=60/);
  healthy = true;
  await daemon.ensureReady();
});

const windowsPath = createFilesystemPath({ platform: 'win32', cwd: 'C:/' });

test('daemon startup failures retain a bounded credential-filtered stderr tail and can restart', async (t) => {
  let failures = true;
  const daemon = new MfsDaemon(() => ({ command: process.execPath, cwd: os.tmpdir(), args: ['-e', failures
    ? "require('fs').writeSync(2, 'x'.repeat(9000) + '\\nTraceback: missing native dependency token=private-secret'); process.exit(1)"
    : "process.stdout.write(JSON.stringify({event:'ready'}) + '\\n'); process.stdin.resume()"] }));
  t.after(() => daemon.close());
  await assert.rejects(daemon.ensureReady(), (error) => {
    const diagnostic = errorDiagnostic(error);
    assert.equal(diagnostic.exit_code, 1);
    assert.match(diagnostic.stderr!, /Traceback: missing native dependency/);
    assert.ok(diagnostic.stderr!.length <= 8_000);
    assert.doesNotMatch(diagnostic.stderr!, /private-secret/);
    return true;
  });
  failures = false;
  await daemon.ensureReady();
});

test('a daemon close deadline fences replacement until the old process actually closes', async (t) => {
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    timeout(fn, ms === 3500 ? 50 : ms, ...args));
  const daemon = new MfsDaemon(() => ({ command: process.execPath, cwd: os.tmpdir(), args: ['-e', `
    process.stdout.write(JSON.stringify({event:'ready'}) + '\\n');
    process.stdin.resume();
    process.stdin.on('end', () => setTimeout(() => process.exit(0), 200));
  `] }));
  t.after(() => daemon.close().catch(() => {}));
  await daemon.ensureReady();
  await assert.rejects(daemon.close(), { code: 'MFS_DAEMON_CLOSE_TIMEOUT' });
  await assert.rejects(daemon.ensureReady(), { code: 'MFS_DAEMON_CLOSE_TIMEOUT' });
  assert.equal(daemon.currentGeneration(), 1);
  await new Promise(resolve => timeout(resolve, 300));
  await daemon.ensureReady();
  assert.equal(daemon.currentGeneration(), 2);
});

test('source daemon startup caps OpenBLAS in the dependency probe and daemon', async () => {
  // Set source mode before importing the launcher. Substitute the Python code
  // at the process boundary so both real children run without a Python venv.
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';

    const checkThreads = "if (process.env.OPENBLAS_NUM_THREADS !== '1') { " +
      "console.error('Expected one OpenBLAS thread, received ' + process.env.OPENBLAS_NUM_THREADS); process.exit(1); }";
    const { execFile, spawn } = childProcess;
    let probed = false;
    childProcess.execFile = (command, args, options, callback) => {
      assert.equal(command, process.execPath);
      assert.equal(args[0], '-c');
      probed = true;
      return execFile(command, ['-e', checkThreads], options, callback);
    };
    childProcess.spawn = (command, args, options) => {
      if (command !== process.execPath) return spawn(command, args, options);
      assert.equal(args[0], '-u');
      return spawn(command, ['-e', checkThreads +
        "console.log(JSON.stringify({ event: 'ready' })); process.stdin.resume();"], options);
    };
    syncBuiltinESMExports();

    const { MfsDaemon } = await import('./server/mfs-daemon.ts');
    const daemon = new MfsDaemon();
    try {
      await daemon.ensureReady();
      assert.ok(probed, 'source startup must exercise the dependency probe');
    } finally {
      await daemon.close();
    }
  `], {
    cwd: path.join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      STASHBASE_DAEMON_BIN: '',
      STASHBASE_DEV_RUNTIME: '1',
      STASHBASE_PYTHON: process.execPath,
      OPENBLAS_NUM_THREADS: '8',
    },
    timeout: 15_000,
  });
});

test('retirement between readiness and dispatch does not write to the closing stdin', async (t) => {
  const daemon = new MfsDaemon(() => ({ command: process.execPath, cwd: os.tmpdir(), args: ['-e',
    "process.stdout.write('{\"event\":\"ready\"}\\n'); process.stdin.resume()"] }));
  t.after(() => daemon.close());
  await daemon.ensureReady();
  const call = daemon.call('status', {});
  const rejected = assert.rejects(call, isMfsDaemonRetiringError);
  await daemon.close();
  await rejected;
});

test('an older Intel Mac rejects native search without starting a daemon', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const arch = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  t.mock.method(os, 'release', () => '21.6.0');
  t.after(() => {
    Object.defineProperty(process, 'platform', platform!);
    Object.defineProperty(process, 'arch', arch!);
  });
  const daemon = new MfsDaemon();
  await assert.rejects(daemon.ensureReady(), /Local search.*macOS 15/);
  assert.equal(daemon.currentGeneration(), 0);
  await daemon.close();
});

test('Unicode identity is evaluated only by Node, including Unicode 16 case pairs', () => {
  const garayUpper = '\u{10D50}';
  const garayLower = '\u{10D70}';
  assert.equal(
    windowsPath.identity(`C:/${garayUpper}`),
    windowsPath.identity(`c:/${garayLower}`),
  );
});

test('daemon readiness replays Folder bindings after every spawn', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-fake-mfs-'));
  const fixture = path.join(scratch, 'fake-daemon.mjs');
  fs.writeFileSync(fixture, `
    import readline from 'node:readline';
    const operations = [];
    process.stdout.write(JSON.stringify({ event: 'ready', db: 'fake' }) + '\\n');
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('line', (line) => {
      const request = JSON.parse(line);
      operations.push(request.op);
      const result = request.op === 'status' ? { operations: [...operations] } : {};
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\\n');
    });
  `, 'utf8');
  const daemon = new MfsDaemon(() => ({ command: process.execPath, args: [fixture], cwd: scratch }));
  t.after(async () => {
    await daemon.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  await daemon.bindFolder('/project/research', { provider: 'openai', dimension: 1536 });
  await daemon.close();
  const status = await daemon.call<{ operations: string[] }>('status', {});
  assert.deepEqual(status.operations, ['bind_folder', 'status']);
});

test('daemon close rejects in-flight work with a typed retirement interruption', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-fake-mfs-retirement-'));
  const fixture = path.join(scratch, 'fake-daemon.mjs');
  fs.writeFileSync(fixture, `
    import readline from 'node:readline';
    process.stdout.write(JSON.stringify({ event: 'ready', db: 'fake' }) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.op === 'block') {
        process.stdout.write(JSON.stringify({ event: 'blocked' }) + '\\n');
        return;
      }
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\\n');
    });
  `, 'utf8');
  const daemon = new MfsDaemon(() => ({ command: process.execPath, args: [fixture], cwd: scratch }));
  t.after(async () => {
    await daemon.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const blockedEvent = new Promise<void>((resolve) => daemon.once('daemon:blocked', () => resolve()));
  const blocked = daemon.call('block', {});
  const rejected = assert.rejects(blocked, isMfsDaemonRetiringError);
  await blockedEvent;
  await daemon.close();

  await rejected;
});

test('concurrent daemon closes share one retirement barrier before respawn', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-fake-mfs-close-'));
  const fixture = path.join(scratch, 'fake-daemon.mjs');
  const lock = path.join(scratch, 'daemon.lock');
  const launches = path.join(scratch, 'launches.log');
  fs.writeFileSync(fixture, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    const [lock, launches] = process.argv.slice(2);
    fs.appendFileSync(launches, 'start\\n');
    let lockFd;
    try {
      lockFd = fs.openSync(lock, 'wx');
    } catch {
      process.stdout.write(JSON.stringify({ event: 'error', phase: 'daemon_lock', error: 'already held' }) + '\\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ event: 'ready', db: 'fake' }) + '\\n');
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('line', (line) => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\\n');
    });
    lines.on('close', () => {
      setTimeout(() => {
        fs.closeSync(lockFd);
        fs.rmSync(lock, { force: true });
        process.exit(0);
      }, 150);
    });
  `, 'utf8');
  const daemon = new MfsDaemon(() => ({
    command: process.execPath,
    args: [fixture, lock, launches],
    cwd: scratch,
  }));
  t.after(async () => {
    await daemon.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  await daemon.call('status', {});
  const firstClose = daemon.close();
  const overlappingClose = daemon.close();
  const duringRetirement = daemon.call('status', {});
  await Promise.all([firstClose, overlappingClose, duringRetirement]);
  await daemon.call('status', {});

  assert.equal(fs.readFileSync(launches, 'utf8').trim().split('\n').length, 2);
});

test('a daemon retired while its command is still resolving does not spawn', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-fake-mfs-resolve-'));
  const fixture = path.join(scratch, 'fake-daemon.mjs');
  const launches = path.join(scratch, 'launches.log');
  fs.writeFileSync(fixture, `
    import fs from 'node:fs';
    fs.appendFileSync(process.argv[2], 'start\\n');
    process.stdout.write(JSON.stringify({ event: 'ready', db: 'fake' }) + '\\n');
    setInterval(() => {}, 1000);
  `, 'utf8');
  // The real resolver probes the Python runtime before any child exists, so
  // a close() can land in that gap. Hold the resolution open by hand.
  let resolveCommand!: (command: { command: string; args: string[]; cwd: string }) => void;
  const daemon = new MfsDaemon(
    () => new Promise((resolve) => { resolveCommand = resolve; }),
  );
  t.after(async () => {
    await daemon.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const ready = daemon.ensureReady();
  const rejected = assert.rejects(ready, isMfsDaemonRetiringError);
  await daemon.close();
  resolveCommand({ command: process.execPath, args: [fixture, launches], cwd: scratch });

  await rejected;
  assert.equal(daemon.currentGeneration(), 0);
  assert.equal(fs.existsSync(launches), false);
});
