import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { gates } from './renderer/check-web.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const setupAction = 'voidzero-dev/setup-vp@1b32467adbe183473499fd9d5d372c3ed9641754';
const rendererJobs = new Map([
  ['.github/workflows/ci.yml', ['source-build']],
  ['.github/workflows/release-macos.yml', ['macos-dmg']],
  ['.github/workflows/release-linux.yml', ['linux-packages']],
  ['.github/workflows/release-windows.yml', ['windows-installer']],
]);

function readWorkflow(relativePath) {
  return parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

test('source and release renderer builds use the same pinned Vite+ setup', () => {
  for (const [relativePath, jobNames] of rendererJobs) {
    const workflow = readWorkflow(relativePath);
    for (const jobName of jobNames) {
      const steps = workflow.jobs?.[jobName]?.steps ?? [];
      const setupSteps = steps.filter((step) => step.uses?.startsWith('voidzero-dev/setup-vp@'));
      const setupIndex = steps.findIndex((step) => step.uses?.startsWith('voidzero-dev/setup-vp@'));
      const installIndex = steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile');

      assert.equal(setupSteps.length, 1, `${relativePath} ${jobName} must set up Vite+ once`);
      assert.deepEqual(
        setupSteps[0],
        {
          uses: setupAction,
          with: {
            version: '0.3.0',
            'node-manager': false,
            'run-install': false,
            cache: false,
          },
        },
        `${relativePath} ${jobName} must use the reviewed Vite+ setup policy`,
      );
      assert.ok(installIndex > setupIndex, `${relativePath} ${jobName} must set up Vite+ before install`);
    }
  }
});

test('source CI runs the renderer checks before the application matrix', () => {
  const workflow = readWorkflow('.github/workflows/ci.yml');
  const steps = workflow.jobs?.['source-build']?.steps ?? [];
  const runs = steps
    .map((step) => step.run)
    .filter((run) => typeof run === 'string')
    .join('\n');

  // The renderer is one CI step by design, so the local command and the
  // workflow cannot drift. Asserting the eight commands it replaced would put
  // that drift back; the gate list below is what proves they still run.
  for (const command of ['pnpm test:toolchain', 'pnpm check:web', 'pnpm test:package-inputs']) {
    assert.match(runs, new RegExp(command.replaceAll(':', '\\:')), `source CI omits ${command}`);
  }

  const stepIndex = (name) => steps.findIndex((step) => step.name === name);
  assert.ok(
    stepIndex('Install dependencies') < stepIndex('Verify Vite+ inventory') &&
      stepIndex('Verify Vite+ inventory') < stepIndex('Check supported renderer') &&
      stepIndex('Check supported renderer') < stepIndex('Test renderer packaging input') &&
      stepIndex('Test renderer packaging input') < stepIndex('Install Python sidecar dependencies'),
    'source CI must fail replacement gates before entering the broader application matrix',
  );
});

test('the one renderer CI step still covers every replacement check', () => {
  // `pnpm check:web` collapsed eight separate CI steps into one runner. This is
  // what stops the collapse from quietly losing a gate: every command CI used
  // to name has to still be reachable from the runner's own list.
  const named = new Set(gates.flatMap((gate) => gate.args));
  for (const script of [
    'test:renderer-architecture',
    'check:renderer-conventions',
    'check:renderer-unused',
    'check:renderer-dupes',
    'format:web',
    'lint:web',
    'test:renderer:coverage',
    'test:renderer:a11y',
    'typecheck:web',
    'build:web',
    'build:storybook',
  ]) {
    assert.ok(named.has(script), `pnpm check:web no longer runs ${script}`);
  }
});

test('Vite+ task-result caching is disabled repository-wide', () => {
  const config = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
  assert.match(config, /run:\s*{[\s\S]*?cache:\s*false/);
});

// Count root-script invocations, expanding the aggregate renderer runner too.
// This catches hidden rebuilds inside nested scripts, not just repeated CI steps.
const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
const hostCheckCondition = "${{ !cancelled() && steps.python.outcome == 'success' }}";
const smokeConditionPrefix = "${{ !cancelled() && steps.services.outcome == 'success' && steps.electron.outcome == 'success' && ";
function scriptCalls(command) {
  const calls = [];
  for (const match of command.matchAll(/(?:pnpm|npm run) ([\w:-]+)/g)) {
    const name = match[1];
    if (!scripts[name]) continue;
    calls.push(name);
    calls.push(...scriptCalls(scripts[name]));
    if (name === 'check:web') {
      for (const gate of gates) calls.push(...scriptCalls(`pnpm ${gate.args[0]}`));
    }
  }
  return calls;
}

test('source validation builds each target once and reuses it for Electron smoke', () => {
  const steps = readWorkflow('.github/workflows/ci.yml').jobs['source-build'].steps;
  const platforms = ['Linux', 'Windows', 'macOS'];
  const commands = platforms.map((os) => [os, steps.filter((step) => {
    if (!step.if) return true;
    if (step.if === hostCheckCondition) return true;
    if (step.if === `${smokeConditionPrefix}runner.os == 'Linux' }}`) return os === 'Linux';
    if (step.if === `${smokeConditionPrefix}runner.os != 'Linux' }}`) return os !== 'Linux';
    if (step.if === "runner.os == 'Linux'") return os === 'Linux';
    if (step.if === "runner.os != 'Linux'") return os !== 'Linux';
    assert.fail(`Review the CI selection rule: ${step.if}`);
  }).map((step) => step.run ?? '').join('\n')]);
  commands.push(['local', 'pnpm check:all']);
  for (const [platform, command] of commands) {
    const calls = scriptCalls(command);
    for (const name of ['build:web', 'build:electron-boundary', 'build:server', 'build:mcp', 'test:electron:smoke:built']) {
      assert.equal(calls.filter((call) => call === name).length, 1, `${platform}: ${name} must run once`);
    }
    assert.ok(calls.indexOf('build:web') < calls.indexOf('test:electron:smoke:built'));
    assert.ok(calls.indexOf('build:electron-boundary') < calls.indexOf('test:electron:smoke:built'));
    const complete = platform === 'Linux' || platform === 'local';
    for (const name of ['check:renderer-architecture', 'typecheck:web', 'test:renderer:coverage', 'test:renderer:a11y']) {
      assert.equal(calls.filter((call) => call === name).length, complete ? 1 : 0, `${platform}: ${name}`);
    }
    assert.equal(calls.includes('test:renderer'), !complete, `${platform}: renderer behavior remains covered`);
  }
});

test('host failures do not skip later checks or turn the source job green', () => {
  const steps = readWorkflow('.github/workflows/ci.yml').jobs['source-build'].steps;
  const setup = steps.findIndex((step) => step.id === 'python');
  const build = steps.findIndex((step) => step.id === 'services');
  assert.ok(setup >= 0 && build > setup);
  for (const step of steps.slice(setup + 1, build + 1)) {
    assert.equal(step.if, hostCheckCondition, `${step.name} must run after an earlier test failure`);
    assert.notEqual(step['continue-on-error'], true, `${step.name} must still fail the job`);
  }
  for (const step of steps.slice(build + 1)) {
    assert.ok(step.if.startsWith(smokeConditionPrefix), 'smoke needs fresh successful builds');
    assert.notEqual(step['continue-on-error'], true);
  }
});

test('Windows packaging verification stays in the release workflow', () => {
  const source = readWorkflow('.github/workflows/ci.yml').jobs['source-build'].steps;
  assert.ok(source.every((step) => !step.uses?.startsWith('msys2/')));
  assert.doesNotMatch(source.map((step) => step.run ?? '').join('\n'), /dist:win|build:python-extract-sidecar/);
  const release = readWorkflow('.github/workflows/release-windows.yml').jobs['windows-installer'].steps;
  const runs = release.map((step) => step.run ?? '').join('\n');
  assert.match(runs, /pnpm dist:win/);
  assert.match(runs, /smoke-packaged-server\.mjs/);
});
