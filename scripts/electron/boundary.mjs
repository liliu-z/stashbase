import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { electronBoundaryEntries } from './entries.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

await build({
  absWorkingDir: repositoryRoot,
  bundle: true,
  entryPoints: electronBoundaryEntries,
  external: ['electron'],
  format: 'cjs',
  logLevel: 'info',
  outdir: 'dist/electron',
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  sourcemap: false,
  target: 'node22',
});
