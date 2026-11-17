import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  spawnOptionsForExtractor,
  spawnOptionsForPdfOcr,
  terminateExtractorTree,
  runExtractor,
} from './extractor-process.ts';
import { probeAgentCommand } from './agent-probe.ts';
import { errorDiagnostic } from './error-diagnostics.ts';

test('extractor outcome distinguishes a native signal from an exit code and cancellation', { skip: process.platform === 'win32' }, async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const outcome = await runExtractor({ mode: 'ocr', script: 'ocr_extract.py', args: [], signal: controller.signal }, {
      spawn: ((_command: string, _args: string[], options: ReturnType<typeof spawnOptionsForPdfOcr>) => {
        const child = spawn(process.execPath, ['-e', cancelled
          ? "process.stderr.write('ready'); setInterval(() => {}, 1000)"
          : "require('fs').writeSync(2, ['native failure', 'frame 1', 'frame 2', 'frame 3', 'worker exit'].join(String.fromCharCode(10))); process.kill(process.pid, 'SIGTERM')"], options);
        if (cancelled) child.stderr!.once('data', () => controller.abort());
        return child;
      }) as unknown as typeof spawn,
    });
    assert.equal(outcome.code, null);
    assert.equal(outcome.signal, 'SIGTERM');
    assert.equal(outcome.cancelled, cancelled);
    assert.equal(outcome.stderrTail, cancelled ? 'ready' : 'frame 2\nframe 3\nworker exit');
    assert.equal(outcome.stderr?.split('\n')[0], cancelled ? 'ready' : 'native failure');
  }
});

test('a timed-out CLI probe preserves bounded, redacted output after reaping its process', async () => {
  await assert.rejects(probeAgentCommand(process.execPath, ['-e',
    "require('fs').writeSync(1, 'x'.repeat(5000) + 'probe started'); require('fs').writeSync(2, 'auth check stalled token=private-token'); setInterval(() => {}, 1000)",
  ], { env: process.env, timeoutMs: 1000 }), error => {
    const diagnostic = errorDiagnostic(error);
    assert.match(diagnostic.message, /timed out/);
    assert.match(diagnostic.stdout!, /probe started$/);
    assert.ok(diagnostic.stdout!.length <= 4000);
    assert.match(diagnostic.stderr!, /auth check stalled/);
    if (process.platform !== 'win32') assert.equal(diagnostic.signal, 'SIGTERM');
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-token/);
    return true;
  });
});

const CHILD_SOURCE = 'setInterval(() => undefined, 1000)';
const PARENT_SOURCE = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  // The detached parent has no console, so on Windows an unhidden child would
  // open a terminal window that the test then kills mid-launch.
  `const child = spawn(process.execPath, ['-e', ${JSON.stringify(CHILD_SOURCE)}], { stdio: 'ignore', windowsHide: true });`,
  "fs.writeFileSync(process.argv[1], String(child.pid));",
  'setInterval(() => undefined, 1000);',
].join('\n');

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('PDF/OCR subprocess configuration stays hidden on Windows', () => {
  const windowsOptions = spawnOptionsForPdfOcr('win32');
  assert.equal(windowsOptions.detached, false);
  assert.equal(windowsOptions.windowsHide, true);

  assert.equal(spawnOptionsForPdfOcr('linux').detached, true);
  assert.equal(spawnOptionsForExtractor().detached, true);
});

test('PDF/OCR can start after the host working directory has been removed', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-extractor-cwd-'));
  const removed = path.join(tmp, 'old-resources');
  fs.mkdirSync(removed);
  const harness = path.join(tmp, 'host.mjs');
  fs.writeFileSync(harness, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    import { runExtractor } from ${JSON.stringify(pathToFileURL(path.resolve('server/extractor-process.ts')).href)};
    process.chdir(${JSON.stringify(removed)});
    fs.rmdirSync(${JSON.stringify(removed)});
    assert.throws(() => process.cwd(), { code: 'ENOENT' });
    for (const mode of ['pdf', 'ocr']) {
      const outcome = await runExtractor({ mode, script: mode + '_extract.py', args: [] }, {
        spawn: (_command, _args, options) => spawn(process.execPath,
          ['-e', 'process.stderr.write(process.cwd())'], options),
      });
      assert.equal(outcome.code, 0, outcome.stderr);
      assert.ok(fs.statSync(outcome.stderr).isDirectory());
    }
  `);
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', harness], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, stderr);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const outcome of ['success', 'exit_failure', 'spawn_failure', 'fallback_failure'] as const) {
  test(`Windows tree termination retains ${outcome} evidence and attempts fallback once`, () => {
    let kills = 0;
    const child = { pid: 123, exitCode: null, signalCode: null, kill: () => {
      kills++;
      if (outcome === 'fallback_failure') throw Object.assign(new Error('access denied'), { code: 'EPERM' });
      return true;
    } } as unknown as ChildProcess;
    const killer = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
    const result = terminateExtractorTree(child, { platform: 'win32', spawn: (() => killer) as unknown as typeof spawn });
    assert.equal(result.taskkill_state, 'pending');
    killer.stderr.write('cannot terminate token=private-token');
    if (outcome === 'spawn_failure') {
      killer.emit('error', Object.assign(new Error('taskkill missing'), { code: 'ENOENT' }));
      killer.emit('close', -2, null);
      assert.equal(result.taskkill_state, 'spawn_failed');
      assert.equal(result.taskkill_error?.code, 'ENOENT');
    } else {
      killer.emit('close', outcome === 'success' ? 0 : 1, null);
      assert.equal(result.taskkill_state, 'finished');
      assert.equal(result.taskkill_exit_code, outcome === 'success' ? 0 : 1);
    }
    assert.equal(kills, outcome === 'success' ? 0 : 1);
    assert.equal(result.fallback_attempted, outcome !== 'success');
    if (outcome === 'fallback_failure') assert.equal(result.fallback_error?.code, 'EPERM');
    assert.doesNotMatch(JSON.stringify(result), /private-token/);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test('extractor cancellation terminates the descendant process tree', { timeout: 10_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-extractor-tree-'));
  const pidFile = path.join(tmp, 'child.pid');
  const parent = spawn(process.execPath, ['-e', PARENT_SOURCE, pidFile], spawnOptionsForExtractor());
  let childPid = 0;
  try {
    assert.equal(await waitUntil(() => fs.existsSync(pidFile), 3_000), true);
    childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.equal(processExists(childPid), true);

    const parentClosed = new Promise<void>((resolve) => parent.once('close', () => resolve()));
    terminateExtractorTree(parent);
    await parentClosed;
    assert.equal(await waitUntil(() => !processExists(childPid), 3_000), true);
  } finally {
    if (parent.exitCode == null && parent.signalCode == null) {
      try { parent.kill('SIGKILL'); } catch { /* already gone */ }
    }
    if (childPid > 0 && processExists(childPid)) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const failure of ['sync', 'async', 'persistent', 'denied', 'cancelled'] as const) {
  test(`extractor spawn ${failure} preserves evidence and bounds Windows recovery`, async () => {
    const { runExtractor } = await import('./extractor-process.ts');
    const controller = new AbortController();
    let calls = 0;
    const spawnProcess = (() => {
      calls++;
      if (calls === 1 || failure === 'persistent' || failure === 'denied') {
        const error = Object.assign(new Error('spawn UNKNOWN'), { code: failure === 'denied' ? 'EACCES' : 'UNKNOWN', errno: -4094, syscall: 'spawn' });
        if (failure === 'cancelled') queueMicrotask(() => controller.abort());
        if (failure === 'async') {
          const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
          queueMicrotask(() => { child.emit('error', error); child.emit('close', -4094); });
          return child;
        }
        throw error;
      }
      return spawn(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024)); process.stderr.write("extracted\\n")'], spawnOptionsForPdfOcr());
    }) as unknown as typeof spawn;
    const run = runExtractor({ mode: 'pdf', script: 'pdf_extract.py', args: [], signal: controller.signal }, { spawn: spawnProcess, platform: 'win32' });
    if (failure === 'sync' || failure === 'async') {
      assert.equal((await run).code, 0);
      assert.equal(calls, 2);
    } else if (failure === 'cancelled') {
      await assert.rejects(run, { name: 'AbortError' });
      assert.equal(calls, 1);
    } else {
      await assert.rejects(run, (error: any) => {
        assert.equal(error.code, 'EXTRACTOR_SPAWN_FAILED');
        assert.equal(error.cause.code, failure === 'denied' ? 'EACCES' : 'UNKNOWN');
        assert.equal(error.cause.errno, -4094);
        assert.equal(error.spawn_attempts, failure === 'persistent' ? 2 : 1);
        return true;
      });
    }
  });
}

test('cancelled extraction never creates a process; non-Windows launch failure is not retried', async () => {
  const { runExtractor } = await import('./extractor-process.ts');
  let calls = 0;
  const spawnProcess = (() => { calls++; throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' }); }) as typeof spawn;
  await assert.rejects(runExtractor({ mode: 'ocr', script: 'ocr_extract.py', args: [], signal: AbortSignal.abort() }, { spawn: spawnProcess }), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(runExtractor({ mode: 'ocr', script: 'ocr_extract.py', args: [] }, { spawn: spawnProcess, platform: 'linux' }), { code: 'EXTRACTOR_SPAWN_FAILED' });
  assert.equal(calls, 1);
});
