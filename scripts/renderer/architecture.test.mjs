import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findRendererArchitectureViolations } from './architecture.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dependencyCruiserBin = path.join(
  repositoryRoot,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruise.mjs',
);
const oxlintBin = path.join(repositoryRoot, 'node_modules', 'oxlint', 'bin', 'oxlint');
const dependencyCruiserConfig = path.join(repositoryRoot, 'dependency-cruiser.config.cjs');
const oxlintConfig = path.join(repositoryRoot, '.oxlintrc.json');
const architectureDeclaration = {
  features: [
    { name: 'agent', productArea: 'Agent Panel' },
    { name: 'documents', productArea: 'Documents' },
    { name: 'preparation', productArea: 'Preparation' },
    { name: 'retrieval', productArea: 'Search and Retrieval' },
    { name: 'settings', productArea: 'Workspace / Agent Panel' },
    { name: 'workspace', productArea: 'Workspace' },
  ],
  contractModules: [],
  wireSchemaModules: [],
};

function write(root, relativePath, source) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, source);
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-renderer-architecture-'));
  context.after(() => fs.rmSync(root, { recursive: true, maxRetries: 10, retryDelay: 100 }));
  write(
    root,
    'renderer/renderer-architecture.json',
    `${JSON.stringify(architectureDeclaration, null, 2)}\n`,
  );
  write(
    root,
    'renderer/tsconfig.json',
    `${JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@/protocols/*': ['../shared/protocols/*'],
          '@/contracts/account': ['../shared/account.ts'],
          '@/contracts/file-formats': ['../shared/file-formats.ts'],
          '@/*': ['./src/*'],
        },
      },
    })}\n`,
  );
  return root;
}

function runNodeTool(bin, arguments_, cwd) {
  const result = spawnSync(process.execPath, [bin, ...arguments_], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

test('the approved empty renderer architecture passes the repository checker', (context) => {
  const root = fixture(context);
  write(root, 'renderer/src/main.ts', "import './app';\n");
  write(root, 'renderer/src/app.ts', 'export const app = true;\n');
  write(root, 'renderer/src/features/workspace/hooks/use-workspace.ts', 'export const hook = true;\n');
  write(root, 'renderer/src/features/workspace/public.ts', 'export const workspace = true;\n');

  assert.deepEqual(findRendererArchitectureViolations(root), []);
});

test('the repository checker rejects implementation access and undeclared feature structure', (context) => {
  const root = fixture(context);
  write(root, 'renderer/src/main.ts', "import '../../server/index';\n");
  write(root, 'renderer/src/dynamic.ts', "export const load = () => import('../outside');\n");
  write(root, 'renderer/src/required.ts', "export const load = () => require('../outside');\n");
  write(root, 'renderer/src/features/unknown/helpers.ts', 'export const value = true;\n');

  assert.deepEqual(findRendererArchitectureViolations(root), [
    'renderer/src/dynamic.ts uses parent-relative import ../outside; use ./ or @/',
    'renderer/src/features/unknown has no feature ownership declaration',
    'renderer/src/features/unknown/helpers.ts is not an approved feature layer',
    'renderer/src/features/unknown/public.ts is required for an implemented feature',
    'renderer/src/main.ts references forbidden implementation path ../server/',
    'renderer/src/main.ts uses parent-relative import ../../server/index; use ./ or @/',
    'renderer/src/required.ts uses parent-relative import ../outside; use ./ or @/',
  ]);
});

test('the declaration file is the only feature allowlist', (context) => {
  const root = fixture(context);
  write(
    root,
    'renderer/renderer-architecture.json',
    `${JSON.stringify({ features: [{ name: 'timeline', productArea: 'Workspace' }], contractModules: [], wireSchemaModules: [] }, null, 2)}\n`,
  );
  write(root, 'renderer/src/features/timeline/public.ts', 'export const timeline = true;\n');

  // A feature the checker has never heard of is approved by the declaration
  // alone, and every feature the declaration drops is undeclared again.
  assert.deepEqual(findRendererArchitectureViolations(root), []);

  write(root, 'renderer/renderer-architecture.json', `${JSON.stringify({ features: [], contractModules: [], wireSchemaModules: [] }, null, 2)}\n`);
  assert.deepEqual(findRendererArchitectureViolations(root), [
    'renderer/src/features/timeline has no feature ownership declaration',
  ]);
});

test('a duplicated or untyped feature declaration is rejected', (context) => {
  const root = fixture(context);
  write(
    root,
    'renderer/renderer-architecture.json',
    `${JSON.stringify(
      {
        features: [
          { name: 'workspace', productArea: 'Workspace' },
          { name: 'workspace', productArea: 'Workspace' },
          { name: 'documents' },
        ],
        contractModules: [],
        wireSchemaModules: [],
      },
      null,
      2,
    )}\n`,
  );

  assert.deepEqual(findRendererArchitectureViolations(root), [
    'renderer feature declarations require string name and productArea fields',
    'renderer feature workspace is declared more than once',
  ]);
});

test('repository wire imports must use a registered executable-schema module', (context) => {
  const root = fixture(context);
  write(root, 'shared/protocols/workspace.ts', 'export const schema = {};\n');
  write(
    root,
    'renderer/src/app.ts',
    "import { schema } from '@/protocols/workspace';\nexport { schema };\n",
  );

  assert.deepEqual(findRendererArchitectureViolations(root), [
    'renderer/src/app.ts imports an unregistered repository wire schema module @/protocols/workspace',
  ]);

  const registered = structuredClone(architectureDeclaration);
  registered.wireSchemaModules = ['shared/protocols/workspace.ts'];
  write(root, 'renderer/renderer-architecture.json', `${JSON.stringify(registered, null, 2)}\n`);
  assert.deepEqual(findRendererArchitectureViolations(root), []);
});

test('repository contract imports must use a registered contract module', (context) => {
  const root = fixture(context);
  write(root, 'shared/account.ts', 'export type Allowance = { seats: number };\n');
  write(
    root,
    'renderer/src/features/workspace/infrastructure/api.ts',
    "import type { Allowance } from '@/contracts/account';\nexport type { Allowance };\n",
  );

  assert.deepEqual(findRendererArchitectureViolations(root), [
    'renderer/src/features/workspace/infrastructure/api.ts imports an unregistered repository contract module @/contracts/account',
    'renderer/src/features/workspace/public.ts is required for an implemented feature',
  ]);

  const registered = structuredClone(architectureDeclaration);
  registered.contractModules = ['shared/account.ts'];
  write(root, 'renderer/renderer-architecture.json', `${JSON.stringify(registered, null, 2)}\n`);
  write(root, 'renderer/src/features/workspace/public.ts', 'export const workspace = true;\n');
  assert.deepEqual(findRendererArchitectureViolations(root), []);
});

test('a registered contract is imported only at the host boundary', (context) => {
  const root = fixture(context);
  write(root, 'shared/account.ts', 'export type Allowance = { seats: number };\n');
  write(root, 'shared/file-formats.ts', "export const VIEWER = ['md'];\n");
  const registered = structuredClone(architectureDeclaration);
  registered.contractModules = ['shared/account.ts', 'shared/file-formats.ts'];
  write(root, 'renderer/renderer-architecture.json', `${JSON.stringify(registered, null, 2)}\n`);
  write(root, 'renderer/src/features/workspace/public.ts', 'export const workspace = true;\n');
  // The boundary layers map a contract; the shared kernel restates the one
  // registered vocabulary.
  write(
    root,
    'renderer/src/features/workspace/infrastructure/api.ts',
    "import type { Allowance } from '@/contracts/account';\nexport type { Allowance };\n",
  );
  write(root, 'renderer/src/platform/api/client.ts', "import '@/contracts/account';\n");
  write(root, 'renderer/src/app/dependencies.ts', "import '@/contracts/account';\n");
  write(root, 'renderer/src/shared/domain/formats.ts', "import '@/contracts/file-formats';\n");
  // Every inner layer reaches it through the boundary instead, and a type-only
  // import is the same import.
  write(
    root,
    'renderer/src/features/workspace/application/ports.ts',
    "import type { Allowance } from '@/contracts/account';\nexport type { Allowance };\n",
  );
  write(root, 'renderer/src/shared/domain/account.ts', "import '@/contracts/account';\n");

  assert.deepEqual(findRendererArchitectureViolations(root), [
    'renderer/src/features/workspace/application/ports.ts imports contract module @/contracts/account outside the host boundary; map it in features/*/infrastructure, platform, or app/dependencies.ts',
    'renderer/src/shared/domain/account.ts imports contract module @/contracts/account outside the host boundary; map it in features/*/infrastructure, platform, or app/dependencies.ts',
  ]);
});

test('a registered module is reached through the alias that matches its registry', (context) => {
  const root = fixture(context);
  write(root, 'shared/protocols/workspace.ts', 'export const schema = {};\n');
  const registered = structuredClone(architectureDeclaration);
  registered.wireSchemaModules = ['shared/protocols/workspace.ts'];
  write(root, 'renderer/renderer-architecture.json', `${JSON.stringify(registered, null, 2)}\n`);
  write(
    root,
    'renderer/src/app.ts',
    "import { schema } from '@/contracts/protocols/workspace';\nexport { schema };\n",
  );

  assert.deepEqual(findRendererArchitectureViolations(root), [
    'renderer/src/app.ts reaches a registered wire schema module through @/contracts/protocols/workspace; use the wire schema alias',
  ]);
});

test('the declaration must carry both repository module registries', (context) => {
  const root = fixture(context);
  write(root, 'renderer/renderer-architecture.json', `${JSON.stringify({ features: [] }, null, 2)}\n`);

  assert.deepEqual(findRendererArchitectureViolations(root), [
    'renderer/renderer-architecture.json must declare a contractModules array',
    'renderer/renderer-architecture.json must declare a wireSchemaModules array',
  ]);
});

test('a feature may keep a test-support file beside its public entry', (context) => {
  const root = fixture(context);
  write(root, 'renderer/src/features/workspace/public.ts', 'export const workspace = true;\n');
  write(root, 'renderer/src/features/workspace/test-support.ts', 'export const build = () => true;\n');

  assert.deepEqual(findRendererArchitectureViolations(root), []);

  fs.rmSync(path.join(root, 'renderer/src/features/workspace/test-support.ts'));
  fs.mkdirSync(path.join(root, 'renderer/src/features/workspace/test-support.ts'));
  assert.deepEqual(findRendererArchitectureViolations(root), [
    'renderer/src/features/workspace/test-support.ts must be a file',
  ]);
});

test('dependency-cruiser confines repository contracts to the host boundary', (context) => {
  const root = fixture(context);
  write(root, 'shared/account.ts', 'export const SEATS = 1;\n');
  write(root, 'shared/file-formats.ts', "export const VIEWER = ['md'];\n");
  // The cruiser reads the transpiled graph, so only value imports reach it;
  // architecture.mjs is what holds the same boundary for `import type`.
  write(
    root,
    'renderer/src/features/workspace/infrastructure/api.ts',
    "import { SEATS } from '@/contracts/account';\nexport { SEATS };\n",
  );
  // The shared kernel may restate the one registered vocabulary.
  write(
    root,
    'renderer/src/shared/domain/formats.ts',
    "import { VIEWER } from '@/contracts/file-formats';\nexport { VIEWER };\n",
  );
  // An inner layer may not.
  write(
    root,
    'renderer/src/features/workspace/domain/model.ts',
    "import { SEATS } from '@/contracts/account';\nexport { SEATS };\n",
  );
  write(
    root,
    'renderer/src/features/workspace/ui/view.ts',
    "import { VIEWER } from '@/contracts/file-formats';\nexport { VIEWER };\n",
  );
  write(root, 'renderer/src/features/workspace/public.ts', 'export const workspace = true;\n');

  const result = runNodeTool(
    dependencyCruiserBin,
    ['--config', dependencyCruiserConfig, 'renderer/src'],
    root,
  );
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /contracts-are-mapped-at-the-boundary/);
  assert.match(result.output, /contract-vocabulary-scope/);
  assert.doesNotMatch(result.output, /shared\/domain\/formats\.ts/);
  assert.doesNotMatch(result.output, /infrastructure\/api\.ts/);
});

test('dependency-cruiser keeps a feature test-support module test-only', (context) => {
  const root = fixture(context);
  write(root, 'renderer/src/features/workspace/public.ts', 'export const workspace = true;\n');
  write(root, 'renderer/src/features/workspace/test-support.ts', 'export const build = () => true;\n');
  write(
    root,
    'renderer/src/features/workspace/ui/view.test.ts',
    "import { build } from '@/features/workspace/test-support';\nexport { build };\n",
  );
  write(
    root,
    'renderer/src/app/boot.ts',
    "import { build } from '@/features/workspace/test-support';\nexport { build };\n",
  );

  const result = runNodeTool(
    dependencyCruiserBin,
    ['--config', dependencyCruiserConfig, 'renderer/src'],
    root,
  );
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /test-support-is-test-only/);
  assert.match(result.output, /app\/boot\.ts/);
  assert.doesNotMatch(result.output, /feature-public-entry-only/);
});

test('dependency-cruiser accepts inward dependencies inside one feature', (context) => {
  const root = fixture(context);
  write(root, 'renderer/src/features/workspace/domain/model.ts', 'export const model = true;\n');
  write(
    root,
    'renderer/src/features/workspace/application/read-model.ts',
    "import { model } from '@/features/workspace/domain/model';\nexport { model };\n",
  );
  write(
    root,
    'renderer/src/features/workspace/hooks/use-model.ts',
    "import { model } from '@/features/workspace/application/read-model';\nexport { model };\n",
  );
  write(
    root,
    'renderer/src/features/workspace/ui/view.ts',
    "import { model } from '@/features/workspace/hooks/use-model';\nexport { model };\n",
  );
  write(
    root,
    'renderer/src/features/workspace/public.ts',
    "export { model } from './application/read-model';\n",
  );

  const result = runNodeTool(
    dependencyCruiserBin,
    ['--config', dependencyCruiserConfig, 'renderer/src'],
    root,
  );
  assert.equal(result.status, 0, result.output);
});

test('dependency-cruiser rejects cycles, sibling access, deep imports, and layer inversion', (context) => {
  const root = fixture(context);
  write(root, 'renderer/src/shared/utils/first.ts', "import './second';\n");
  write(root, 'renderer/src/shared/utils/second.ts', "import './first';\n");
  write(root, 'renderer/src/features/documents/domain/model.ts', 'export const document = true;\n');
  write(
    root,
    'renderer/src/features/documents/public.ts',
    "export { document } from './domain/model';\n",
  );
  write(
    root,
    'renderer/src/features/workspace/application/runtime.ts',
    "import { document } from '../../documents/public';\nexport { document };\n",
  );
  write(
    root,
    'renderer/src/features/workspace/domain/model.ts',
    "import { document } from '../application/runtime';\nexport { document };\n",
  );
  write(root, 'renderer/src/features/workspace/public.ts', 'export const workspace = true;\n');
  write(
    root,
    'renderer/src/app/composition/compose.ts',
    "import { document } from '../../features/documents/domain/model';\nexport { document };\n",
  );
  write(
    root,
    'renderer/src/main.ts',
    "import { document } from './features/documents/public';\nexport { document };\n",
  );
  write(root, 'renderer/src/platform/api/client.ts', 'export const client = true;\n');
  write(
    root,
    'renderer/src/features/workspace/ui/view.ts',
    "import { client } from '../../../platform/api/client';\nexport { client };\n",
  );
  write(
    root,
    'renderer/src/features/workspace/hooks/use-client.ts',
    "import { client } from '@/features/workspace/infrastructure/client';\nexport { client };\n",
  );
  write(
    root,
    'renderer/src/features/workspace/infrastructure/client.ts',
    'export const client = true;\n',
  );

  const result = runNodeTool(
    dependencyCruiserBin,
    ['--config', dependencyCruiserConfig, 'renderer/src'],
    root,
  );
  assert.notEqual(result.status, 0, result.output);
  for (const rule of [
    'no-circular',
    'no-sibling-feature-imports',
    'feature-public-entry-only',
    'feature-public-only-from-app',
    'domain-is-pure',
    'hooks-have-no-platform-or-view-access',
    'ui-has-no-platform-access',
  ]) {
    assert.match(result.output, new RegExp(rule), `missing ${rule}:\n${result.output}`);
  }
});

test('Oxlint rejects platform APIs in protected feature layers', (context) => {
  const root = fixture(context);
  write(
    root,
    'renderer/src/features/workspace/domain/unsafe-domain.ts',
    "import React from 'react';\nexport const request = fetch('/api');\nexport { React };\n",
  );
  write(
    root,
    'renderer/src/features/workspace/application/unsafe-command.ts',
    "export const socket = new WebSocket('ws://localhost');\n",
  );
  write(
    root,
    'renderer/src/features/workspace/ui/unsafe-view.ts',
    'export const bridge = window.stashbase;\n',
  );
  write(
    root,
    'renderer/src/features/workspace/hooks/use-unsafe.ts',
    'export const bridge = window.stashbase;\n',
  );

  const result = runNodeTool(
    oxlintBin,
    [
      // Pin the reporter: oxlint switches to GitHub annotations when it sees
      // GITHUB_ACTIONS, and that format carries only the primary message, so the
      // custom text these assertions read would vanish in CI.
      '--format=default',
      '--config',
      oxlintConfig,
      'renderer/src/features/workspace/domain/unsafe-domain.ts',
      'renderer/src/features/workspace/application/unsafe-command.ts',
      'renderer/src/features/workspace/hooks/use-unsafe.ts',
      'renderer/src/features/workspace/ui/unsafe-view.ts',
    ],
    root,
  );
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /Domain modules are pure/);
  assert.match(result.output, /Application code consumes injected ports/);
  assert.match(result.output, /Feature hooks coordinate application capabilities/);
  assert.match(result.output, /Use an injected platform adapter/);
});
