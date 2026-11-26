import { electronBoundaryEntries } from './scripts/electron/entries.mjs';
import pkg from './package.json' with { type: 'json' };

/** @type {import('knip').KnipConfig} */
export default {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  workspaces: {
    '.': {
      entry: [
        // dist/electron modules are required by path, so knip cannot follow them.
        ...Object.values(electronBoundaryEntries),
        // Forked by speech/worker-client.ts and bundled separately by build-server.mjs.
        'server/speech/worker.ts',
        // electron-builder hooks and subprocess entries are loaded by filename.
        pkg.build.afterPack,
        pkg.build.afterSign,
        pkg.build.mac.sign,
        'scripts/pnpm-list-for-electron-builder.mjs',
        'scripts/profiling/speech-desktop.cjs',
        'electron/**/*smoke*.cjs',
        'electron/**/*.test.cjs',
        'server/**/*.test.ts',
        'shared/**/*.test.ts',
        'scripts/**/*.test.{mjs,cjs,ts}',
      ],
      project: [
        'electron/**/*.{ts,cjs}',
        'server/**/*.ts',
        'mcp/**/*.ts',
        'shared/**/*.ts',
        'scripts/**/*.{mjs,cjs,ts}',
      ],
      ignoreDependencies: [
        'opencode-ai', 'mammoth', 'pdfjs-dist', 'vite',
        // Loaded only for Windows packaging through createRequire(import.meta.url).
        '@vscode/ripgrep',
        // Smoke fixtures resolve these through the owning package/workspace.
        '@fontsource-variable/inter', 'app-builder-lib',
      ],
      // Host utilities, not npm dependencies.
      ignoreBinaries: ['uv', 'brew', 'pwsh.exe', 'mkfifo'],
    },
    renderer: {
      entry: [
        'src/bug-report.tsx',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.stories.tsx',
        'src/**/*.profile.tsx',
        '.storybook/**/*.{ts,tsx}',
      ],
      project: ['src/**/*.{ts,tsx,css}', '.storybook/**/*.{ts,tsx}'],
      ignoreDependencies: ['@storybook/addon-a11y', '@storybook/addon-docs', 'shadcn'],
      vite: true,
      vitest: false,
      storybook: false,
    },
  },
};
