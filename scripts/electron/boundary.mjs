import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

await build({
  absWorkingDir: repositoryRoot,
  bundle: true,
  entryPoints: {
    'bug-report/review-ipc': 'electron/bug-report/review-ipc.ts',
    'bug-report/review-preload': 'electron/bug-report/review-preload.ts',
    'bug-report/review-window-preload': 'electron/bug-report/review-window-preload.ts',
    'external-navigation/handler': 'electron/external-navigation/handler.ts',
    'external-navigation/preload': 'electron/external-navigation/preload.ts',
    'project/dialog': 'electron/project/dialog.ts',
    'project/filesystem-path': 'server/filesystem-path.ts',
    'project/lifecycle': 'electron/project/lifecycle.ts',
    'project/preload': 'electron/project/preload.ts',
    'renderer/document-marks': 'electron/renderer/document-marks.ts',
    'renderer/preload': 'electron/renderer/preload.ts',
    'renderer/runtime': 'electron/renderer/runtime.ts',
    'updates/ipc': 'electron/updates/ipc.ts',
    'updates/preload': 'electron/updates/preload.ts',
    'workspace/preload': 'electron/workspace/preload.ts',
    'workspace/session': 'electron/workspace/session.ts',
    'window/lifecycle': 'electron/window/lifecycle.ts',
    'window/appearance': 'electron/window/appearance.ts',
    'text-services/context-menu': 'electron/text-services/context-menu.ts',
    'text-services/ipc': 'electron/text-services/ipc.ts',
    'text-services/system-fonts': 'electron/text-services/system-fonts.ts',
    'window/preload': 'electron/window/preload.ts',
  },
  external: ['electron'],
  format: 'cjs',
  logLevel: 'info',
  outdir: 'dist/electron',
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  sourcemap: false,
  target: 'node22',
});
