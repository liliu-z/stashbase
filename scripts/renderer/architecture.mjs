#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceExtensions = new Set(['.css', '.html', '.js', '.jsx', '.json', '.mjs', '.ts', '.tsx']);
const moduleExtensions = ['.js', '.jsx', '.mjs', '.ts', '.tsx'];
const skippedDirectories = new Set(['dist', 'node_modules']);
// A feature is exactly these entries. `public.ts` is the one entry other code
// may import; `test-support.ts` is the optional test-only runtime builder,
// reachable only from a `*.test.*` file.
const featureFileEntries = new Set(['public.ts', 'test-support.ts']);
const featureEntries = new Set([
  'application',
  'domain',
  'hooks',
  'infrastructure',
  'public.ts',
  'test-support.ts',
  'ui',
]);
// Where a registered contract module may be imported. A contract crosses the
// process boundary, so it is mapped where the renderer meets the host: a
// feature Adapter, the platform client, or dependency wiring. dependency-cruiser
// states the same rule, but it reads the transpiled graph where `import type`
// has been erased, and a contract is imported for its types more often than
// for its values — so the boundary is enforced here, over the source text.
const contractBoundaries = [
  /^renderer\/src\/features\/[^/]+\/infrastructure\//,
  /^renderer\/src\/platform\//,
  /^renderer\/src\/app\/dependencies\.ts$/,
];
// shared/file-formats is a vocabulary rather than a transport shape: the
// renderer's shared kernel and feature domains name formats with it, so it
// has two extra homes. Views and hooks reach it through their feature's
// domain re-export.
const contractVocabularies = new Map([
  ['shared/file-formats.ts', /^renderer\/src\/(?:shared|features\/[^/]+\/domain)\//],
  // The theme catalog names and colours every theme; the shared runtime
  // stamps its tokens and the Settings domain lists its labels.
  ['shared/appearance-themes.ts', /^renderer\/src\/(?:shared|features\/[^/]+\/domain)\//],
]);

function slash(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function sourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || skippedDirectories.has(entry.name)) return [];
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && sourceExtensions.has(path.extname(entry.name)) ? [absolute] : [];
  });
}

function readDeclaration(root, violations) {
  const relativePath = 'renderer/renderer-architecture.json';
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    violations.push(`${relativePath} is required`);
    return { contractModules: [], features: [], wireSchemaModules: [] };
  }

  let declaration;
  try {
    declaration = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    violations.push(`${relativePath} is not valid JSON: ${error.message}`);
    return { contractModules: [], features: [], wireSchemaModules: [] };
  }

  if (!Array.isArray(declaration.features)) {
    violations.push(`${relativePath} must declare a features array`);
  }
  if (!Array.isArray(declaration.wireSchemaModules)) {
    violations.push(`${relativePath} must declare a wireSchemaModules array`);
  }
  if (!Array.isArray(declaration.contractModules)) {
    violations.push(`${relativePath} must declare a contractModules array`);
  }

  return {
    contractModules: Array.isArray(declaration.contractModules)
      ? declaration.contractModules
      : [],
    features: Array.isArray(declaration.features) ? declaration.features : [],
    wireSchemaModules: Array.isArray(declaration.wireSchemaModules)
      ? declaration.wireSchemaModules
      : [],
  };
}

// renderer/renderer-architecture.json is the only allowlist. A feature exists
// because it is declared there with an owning product area; this checker holds
// no second copy of that list to drift from it.
function checkFeatureDeclaration(root, features, violations) {
  const declared = new Map();
  for (const feature of features) {
    if (
      !feature ||
      typeof feature.name !== 'string' ||
      typeof feature.productArea !== 'string'
    ) {
      violations.push('renderer feature declarations require string name and productArea fields');
      continue;
    }
    if (declared.has(feature.name)) {
      violations.push(`renderer feature ${feature.name} is declared more than once`);
      continue;
    }
    declared.set(feature.name, feature.productArea);
  }

  const featuresRoot = path.join(root, 'renderer', 'src', 'features');
  if (!fs.existsSync(featuresRoot)) return;

  for (const featureDirectory of fs.readdirSync(featuresRoot, { withFileTypes: true })) {
    if (featureDirectory.name.startsWith('.')) continue;
    if (!featureDirectory.isDirectory()) {
      violations.push(`renderer/src/features/${featureDirectory.name} must be an owned feature directory`);
      continue;
    }
    const featureName = featureDirectory.name;
    const relativeFeature = `renderer/src/features/${featureName}`;
    if (!declared.has(featureName)) {
      violations.push(`${relativeFeature} has no feature ownership declaration`);
    }

    const absoluteFeature = path.join(featuresRoot, featureName);
    const entries = fs.readdirSync(absoluteFeature, { withFileTypes: true });
    for (const entry of entries) {
      if (!featureEntries.has(entry.name)) {
        violations.push(`${relativeFeature}/${entry.name} is not an approved feature layer`);
      } else if (featureFileEntries.has(entry.name) && !entry.isFile()) {
        violations.push(`${relativeFeature}/${entry.name} must be a file`);
      } else if (!featureFileEntries.has(entry.name) && !entry.isDirectory()) {
        violations.push(`${relativeFeature}/${entry.name} must be a directory`);
      }
    }
    if (!entries.some((entry) => entry.isFile() && entry.name === 'public.ts')) {
      violations.push(`${relativeFeature}/public.ts is required for an implemented feature`);
    }
  }
}

// Two registries, one allowlist. Executable wire schemas are reached through
// `@/protocols/*`; the repository contract vocabularies the renderer shares
// with the host — file formats, sanitization, agent runtime, agent protocol,
// account — are reached through `@/contracts/*`. Both live under `shared/` at
// the repository root, so both are registered in
// renderer/renderer-architecture.json and neither is reachable by accident.
function registerRepositoryModules(root, modules, kind, registered, violations) {
  for (const modulePath of modules) {
    if (typeof modulePath !== 'string' || !/^shared\/.+\.(?:js|mjs|ts)$/.test(modulePath)) {
      violations.push(`${kind} module ${String(modulePath)} must be a file under shared/`);
      continue;
    }
    if (registered.has(modulePath)) {
      violations.push(`${kind} module ${modulePath} is registered more than once`);
      continue;
    }
    registered.set(modulePath, kind);
    if (!fs.existsSync(path.join(root, modulePath))) {
      violations.push(`registered ${kind} module ${modulePath} does not exist`);
    }
  }
}

function resolveRepositoryImport(specifier, sharedRoot, absolute) {
  if (specifier.startsWith('@/protocols/')) {
    return {
      kind: 'wire schema',
      target: path.join(sharedRoot, 'protocols', specifier.slice('@/protocols/'.length)),
    };
  }
  if (specifier.startsWith('@/contracts/')) {
    return {
      kind: 'contract',
      target: path.join(sharedRoot, specifier.slice('@/contracts/'.length)),
    };
  }
  if (specifier.startsWith('.')) {
    return { kind: null, target: path.resolve(path.dirname(absolute), specifier) };
  }
  return null;
}

function checkRepositoryModuleDeclaration(root, declaration, violations) {
  const registered = new Map();
  registerRepositoryModules(root, declaration.wireSchemaModules, 'wire schema', registered, violations);
  registerRepositoryModules(root, declaration.contractModules, 'contract', registered, violations);

  const rendererRoot = path.join(root, 'renderer');
  const sharedRoot = path.join(root, 'shared');
  for (const absolute of sourceFiles(path.join(rendererRoot, 'src'))) {
    const source = fs.readFileSync(absolute, 'utf8');
    const importPattern =
      /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"](?<specifier>[^'"]+)['"]/g;
    for (const match of source.matchAll(importPattern)) {
      const specifier = match.groups?.specifier;
      if (!specifier) continue;
      const resolution = resolveRepositoryImport(specifier, sharedRoot, absolute);
      if (!resolution) continue;
      const { target } = resolution;
      const isSharedImport = target === sharedRoot || target.startsWith(`${sharedRoot}${path.sep}`);
      if (!isSharedImport) continue;

      const candidates = [
        target,
        ...moduleExtensions.map((extension) => `${target}${extension}`),
        ...moduleExtensions.map((extension) => path.join(target, `index${extension}`)),
      ];
      const registeredKind = candidates
        .map((candidate) => registered.get(slash(path.relative(root, candidate))))
        .find((kind) => kind !== undefined);
      const relative = slash(path.relative(root, absolute));
      if (registeredKind === undefined) {
        violations.push(
          `${relative} imports an unregistered repository ${resolution.kind ?? 'wire schema'} module ${specifier}`,
        );
      } else if (resolution.kind !== null && registeredKind !== resolution.kind) {
        violations.push(
          `${relative} reaches a registered ${registeredKind} module through ${specifier}; use the ${registeredKind} alias`,
        );
      } else if (registeredKind === 'contract') {
        const registeredPath = candidates
          .map((candidate) => slash(path.relative(root, candidate)))
          .find((candidate) => registered.has(candidate));
        const vocabularyHome = contractVocabularies.get(registeredPath);
        const allowed =
          contractBoundaries.some((boundary) => boundary.test(relative)) ||
          (vocabularyHome !== undefined && vocabularyHome.test(relative));
        if (!allowed) {
          violations.push(
            `${relative} imports contract module ${specifier} outside the host boundary; map it in features/*/infrastructure, platform, or app/dependencies.ts`,
          );
        }
      }
    }
  }
}

export function findRendererArchitectureViolations(root = repositoryRoot) {
  const violations = [];
  const declaration = readDeclaration(root, violations);
  checkFeatureDeclaration(root, declaration.features, violations);
  checkRepositoryModuleDeclaration(root, declaration, violations);

  const sharedTypes = path.join(root, 'renderer', 'src', 'shared', 'types');
  if (fs.existsSync(sharedTypes)) {
    violations.push('renderer/src/shared/types is forbidden; use the reviewed shared domain kernel');
  }

  for (const absolute of sourceFiles(path.join(root, 'renderer'))) {
    const source = fs.readFileSync(absolute, 'utf8');
    const relative = slash(path.relative(root, absolute));
    for (const forbidden of ['../server/', '../electron/']) {
      if (source.includes(forbidden)) {
        violations.push(`${relative} references forbidden implementation path ${forbidden}`);
      }
    }
    const importPattern =
      /\b(?:(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)['"](?<specifier>\.\.\/[^'"]+)['"]/g;
    for (const match of source.matchAll(importPattern)) {
      violations.push(
        `${relative} uses parent-relative import ${match.groups.specifier}; use ./ or @/`,
      );
    }
  }

  return violations.sort();
}

export function checkRendererArchitecture(root = repositoryRoot) {
  const violations = findRendererArchitectureViolations(root);
  if (violations.length === 0) return;
  throw new Error(`Renderer architecture violations:\n${violations.join('\n')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkRendererArchitecture();
  console.log('renderer architecture check passed');
}
