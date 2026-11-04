#!/usr/bin/env node
// The renderer gate runner. A serial `&&` chain stops at the first failure and
// hides every gate behind it, so one run reports one problem and the next run
// finds the next. This runs every gate to completion as its own child process,
// prints one status line each as it finishes, replays the output of the ones
// that failed, and exits non-zero if any did.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The order a reviewer reads a failure in: structure, then shape, then
// behaviour, then the two builds — the application, then the production-
// equivalent Storybook the stories are reviewed in. Every gate still runs
// whatever the ones before it reported.
export const gates = [
  { name: 'architecture', command: 'pnpm', args: ['test:renderer-architecture'] },
  { name: 'conventions', command: 'pnpm', args: ['check:renderer-conventions'] },
  { name: 'unused', command: 'pnpm', args: ['check:renderer-unused'] },
  { name: 'duplication', command: 'pnpm', args: ['check:renderer-dupes'] },
  { name: 'format', command: 'pnpm', args: ['format:web'] },
  { name: 'lint', command: 'pnpm', args: ['lint:web'] },
  { name: 'coverage', command: 'pnpm', args: ['test:renderer:coverage'] },
  { name: 'accessibility', command: 'pnpm', args: ['test:renderer:a11y'] },
  { name: 'typecheck', command: 'pnpm', args: ['typecheck:web'] },
  { name: 'build', command: 'pnpm', args: ['build:web'] },
  { name: 'storybook', command: 'pnpm', args: ['build:storybook'] },
];

function spawnGate(gate, cwd) {
  // Windows exposes `pnpm` as a `.cmd` shim, and Node refuses to spawn one
  // without a shell. Only the package runner needs that, and its arguments are
  // literal script names. A gate naming a real executable is spawned directly,
  // so its arguments reach it unmangled by cmd.exe.
  const shell = process.platform === 'win32' && gate.command === 'pnpm';
  const result = spawnSync(gate.command, gate.args, { cwd, encoding: 'utf8', shell });
  if (result.error) return { status: 1, output: `${result.error.message}\n` };
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

export function runGates(list = gates, options = {}) {
  const {
    cwd = repositoryRoot,
    run = spawnGate,
    log = (line) => console.log(line),
    now = () => Date.now(),
  } = options;

  log(`running ${list.length} renderer gates: ${list.map((gate) => gate.name).join(', ')}`);

  const results = [];
  for (const gate of list) {
    const started = now();
    const outcome = run(gate, cwd);
    const passed = outcome.status === 0;
    results.push({ name: gate.name, passed, output: outcome.output ?? '' });
    log(`${passed ? 'pass' : 'FAIL'}  ${gate.name} (${Math.round((now() - started) / 1000)}s)`);
  }

  const failed = results.filter((result) => !result.passed);
  for (const result of failed) {
    log(`\n----- ${result.name} -----\n${result.output.trimEnd()}`);
  }
  log(
    failed.length === 0
      ? `\nAll ${results.length} renderer gates passed.`
      : `\n${failed.length} of ${results.length} renderer gates failed: ${failed
          .map((result) => result.name)
          .join(', ')}`,
  );

  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = runGates();
  // Failure diagnostics can exceed a pipe buffer. Let Node flush them before
  // exiting; process.exit() truncates the error tail in hosted CI logs.
  process.exitCode = results.every((result) => result.passed) ? 0 : 1;
}
