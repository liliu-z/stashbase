import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist', 'server');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: {
    index: path.join(root, 'server', 'index.ts'),
    'speech-worker': path.join(root, 'server', 'speech', 'worker.ts'),
  },
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: [
    // Native module rebuilt by electron-builder and loaded from packaged node_modules.
    'better-sqlite3',
    // The speech child resolves its verified prebuilt libraries beside this package.
    'transcribe-cpp',
    // Ships its own `cli.js` that it locates relative to its own package
    // dir at runtime — bundling it into one file breaks that resolution,
    // so load it from packaged node_modules like the native modules above.
    '@anthropic-ai/claude-agent-sdk',
  ],
  banner: {
    // Provide a CJS `require` in the ESM bundle. Alias the import to a
    // private name: the banner is raw text esbuild can't see, so a bundled
    // dependency that does the same would otherwise hoist a second top-level
    // `createRequire` and collide at boot.
    js: "import { createRequire as __sbCreateRequire } from 'node:module'; const require = __sbCreateRequire(import.meta.url);",
  },
  sourcemap: true,
  logLevel: 'info',
});

console.log('[build:server] done ->', outDir);
