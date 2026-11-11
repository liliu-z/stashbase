import { electronBoundaryEntries } from './scripts/electron/entries.mjs';

/** @type {import('knip').KnipConfig} */
export default {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  workspaces: {
    '.': {
      entry: [
        // dist/electron modules are required by path, so knip cannot follow them.
        ...Object.values(electronBoundaryEntries),
        'electron/**/*smoke*.cjs',
        'electron/**/*.test.cjs',
        'server/**/*.test.ts',
        'shared/**/*.test.ts',
        'scripts/**/*.{mjs,cjs,ts}',
      ],
      project: [
        'electron/**/*.{ts,cjs}',
        'server/**/*.ts',
        'mcp/**/*.ts',
        'shared/**/*.ts',
        'scripts/**/*.{mjs,cjs,ts}',
      ],
      ignoreDependencies: ['opencode-ai', 'oxlint', 'mammoth', 'pdfjs-dist', 'vite'],
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
