const path = require('node:path');

const rendererTsConfig = path.resolve(process.cwd(), 'renderer/tsconfig.json');
const electronRuntimePaths = [
  '^electron(?:/|$)',
  '^node_modules/[.]pnpm/[^/]+/node_modules/electron(?:/|$)',
  '^node_modules/electron(?:/|$)',
];
const reactRuntimePaths = [
  '^(?:react|react-dom)(?:/|$)',
  '^node_modules/[.]pnpm/[^/]+/node_modules/(?:react|react-dom)(?:/|$)',
  '^node_modules/(?:react|react-dom)(?:/|$)',
];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Renderer modules must form an acyclic dependency graph.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Every renderer import must resolve through the reviewed workspace configuration.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-sibling-feature-imports',
      severity: 'error',
      comment: 'Features are isolated; app composition coordinates their public capabilities.',
      from: { path: '^renderer/src/features/([^/]+)/' },
      to: {
        path: '^renderer/src/features/',
        pathNot: '^renderer/src/features/$1/',
      },
    },
    {
      name: 'feature-public-entry-only',
      severity: 'error',
      comment: 'Code outside a feature may consume only that feature public.ts entry.',
      from: { pathNot: '^renderer/src/features/' },
      to: {
        path: '^renderer/src/features/[^/]+/(?!public[.]ts$)',
        pathNot: '^renderer/src/features/[^/]+/test-support[.]ts$',
      },
    },
    {
      name: 'test-support-is-test-only',
      severity: 'error',
      comment:
        'A feature test-support module builds runtimes for tests; only a test file imports it.',
      from: { pathNot: '[.]test[.]tsx?$' },
      to: { path: '^renderer/src/features/[^/]+/test-support[.]ts$' },
    },
    {
      name: 'feature-public-only-from-app',
      severity: 'error',
      comment: 'Only the app layer composes public feature capabilities.',
      from: { path: '^renderer/src/(?!app/|features/)' },
      to: { path: '^renderer/src/features/[^/]+/public[.]ts$' },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'Feature domain code cannot depend on app, platform, React, UI, or outer feature layers.',
      from: { path: '^renderer/src/features/[^/]+/domain/' },
      to: {
        path: [
          '^renderer/src/app/',
          '^renderer/src/platform/',
          '^renderer/src/shared/(?:styling|ui)/',
          '^renderer/src/features/[^/]+/(?:application|hooks|infrastructure|ui)/',
          ...reactRuntimePaths,
        ],
      },
    },
    {
      name: 'domain-has-no-node-access',
      severity: 'error',
      comment: 'Feature domain code is independent of Node and Electron runtime APIs.',
      from: { path: '^renderer/src/features/[^/]+/domain/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'application-depends-inward',
      severity: 'error',
      comment: 'Application code owns ports and cannot select concrete adapters or UI.',
      from: { path: '^renderer/src/features/[^/]+/application/' },
      to: {
        path: [
          '^renderer/src/app/',
          '^renderer/src/platform/',
          '^renderer/src/shared/(?:styling|ui)/',
          '^renderer/src/features/[^/]+/(?:hooks|infrastructure|ui)/',
          ...reactRuntimePaths,
        ],
      },
    },
    {
      name: 'hooks-have-no-platform-or-view-access',
      severity: 'error',
      comment: 'Feature hooks adapt application state for UI without selecting adapters or views.',
      from: { path: '^renderer/src/features/[^/]+/hooks/' },
      to: {
        path: [
          '^renderer/src/app/',
          '^renderer/src/platform/',
          '^renderer/src/features/[^/]+/(?:infrastructure|ui)/',
        ],
      },
    },
    {
      name: 'ui-has-no-platform-access',
      severity: 'error',
      comment: 'UI invokes application capabilities and never imports concrete transports.',
      from: { path: '^renderer/src/features/[^/]+/ui/' },
      to: {
        path: [
          '^renderer/src/app/',
          '^renderer/src/platform/',
          '^renderer/src/features/[^/]+/infrastructure/',
        ],
      },
    },
    {
      name: 'infrastructure-has-no-ui-or-app-policy',
      severity: 'error',
      comment: 'Feature adapters implement ports without importing presentation or composition policy.',
      from: { path: '^renderer/src/features/[^/]+/infrastructure/' },
      to: {
        path: [
          '^renderer/src/app/',
          '^renderer/src/shared/(?:styling|ui)/',
          '^renderer/src/features/[^/]+/(?:hooks|ui)/',
          ...reactRuntimePaths,
        ],
      },
    },
    {
      name: 'platform-has-no-product-policy',
      severity: 'error',
      comment: 'Platform mechanisms cannot depend on app or feature-owned product policy.',
      from: { path: '^renderer/src/platform/' },
      to: {
        path: [
          '^renderer/src/(?:app|features)/',
          '^renderer/src/shared/(?:styling|ui)/',
          ...reactRuntimePaths,
        ],
      },
    },
    {
      name: 'shared-is-a-leaf',
      severity: 'error',
      comment: 'Shared domain, UI, styling, and utilities cannot depend on app, features, or platform.',
      from: { path: '^renderer/src/shared/' },
      to: { path: '^renderer/src/(?:app|features|platform)/' },
    },
    {
      name: 'shared-domain-and-utils-are-pure',
      severity: 'error',
      comment: 'The shared domain kernel and utilities cannot depend on React or browser presentation.',
      from: { path: '^renderer/src/shared/(?:domain|utils)/' },
      to: {
        path: [
          '^renderer/src/shared/(?:styling|ui)/',
          ...reactRuntimePaths,
        ],
      },
    },
    {
      name: 'kit-does-not-reach-product-code',
      severity: 'error',
      comment:
        'components/ and lib/ are the installed kit; product code lives under shared/. The kit reaches shared/utils for pure helpers and nothing else — application plumbing (shared/runtime), product styling, product UI, and the product domain kernel all run the other way. That is what keeps the kit installable without the application.',
      from: { path: '^renderer/src/(?:components|lib)/' },
      to: { path: '^renderer/src/shared/(?!utils/)' },
    },
    {
      name: 'contracts-are-mapped-at-the-boundary',
      severity: 'error',
      comment:
        'Repository contract modules (@/contracts/*) are mapped where the renderer meets the host: a feature Adapter, the platform client, or dependency wiring.',
      from: {
        path: '^renderer/src/',
        pathNot: [
          '^renderer/src/features/[^/]+/infrastructure/',
          '^renderer/src/platform/',
          '^renderer/src/app/dependencies[.]ts$',
        ],
      },
      to: {
        path: '^shared/',
        pathNot: ['^shared/protocols/', '^shared/(?:file-formats|appearance-themes)[.]ts$'],
      },
    },
    {
      name: 'contract-vocabulary-scope',
      severity: 'error',
      comment:
        'shared/file-formats and shared/appearance-themes are the registered contract vocabularies the shared kernel and feature domains may restate; every other layer reaches them through the boundary.',
      from: {
        path: '^renderer/src/',
        pathNot: [
          '^renderer/src/features/[^/]+/infrastructure/',
          '^renderer/src/platform/',
          '^renderer/src/app/dependencies[.]ts$',
          '^renderer/src/shared/',
          '^renderer/src/features/[^/]+/domain/',
        ],
      },
      to: { path: '^shared/(?:file-formats|appearance-themes)[.]ts$' },
    },
    {
      name: 'renderer-does-not-import-implementation-trees',
      severity: 'error',
      comment: 'The renderer consumes reviewed protocols, never server or Electron implementation.',
      from: { path: '^renderer/' },
      to: { path: '^(?:server|electron)/' },
    },
    {
      name: 'renderer-does-not-import-electron-runtime',
      severity: 'error',
      comment: 'Sandboxed renderer code uses typed preload capabilities, not the Electron package.',
      from: { path: '^renderer/' },
      to: { path: electronRuntimePaths },
    },
  ],
  options: {
    tsConfig: {
      fileName: rendererTsConfig,
    },
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
    },
  },
};
