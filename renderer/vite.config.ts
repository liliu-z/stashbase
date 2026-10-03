import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: [
      {
        find: /^@\/protocols\//u,
        replacement: fileURLToPath(new URL('../shared/protocols/', import.meta.url)),
      },
      {
        find: '@/contracts/github-import',
        replacement: fileURLToPath(new URL('../shared/github-import.ts', import.meta.url)),
      },
      {
        find: '@/contracts/folder-name',
        replacement: fileURLToPath(new URL('../shared/folder-name.ts', import.meta.url)),
      },
      {
        find: '@/contracts/file-formats',
        replacement: fileURLToPath(new URL('../shared/file-formats.ts', import.meta.url)),
      },
      {
        find: '@/contracts/html-sanitization',
        replacement: fileURLToPath(new URL('../shared/html-sanitization.ts', import.meta.url)),
      },
      {
        find: '@/contracts/agent-runtime',
        replacement: fileURLToPath(new URL('../shared/agent-runtime.ts', import.meta.url)),
      },
      {
        find: '@/contracts/agent-protocol',
        replacement: fileURLToPath(new URL('../shared/agent-protocol.ts', import.meta.url)),
      },
      {
        find: '@/contracts/account',
        replacement: fileURLToPath(new URL('../shared/account.ts', import.meta.url)),
      },
      {
        find: '@/contracts/appearance-themes',
        replacement: fileURLToPath(new URL('../shared/appearance-themes.ts', import.meta.url)),
      },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  fmt: {
    arrowParens: 'always',
    bracketSameLine: false,
    bracketSpacing: true,
    endOfLine: 'lf',
    insertFinalNewline: true,
    jsxSingleQuote: false,
    printWidth: 100,
    quoteProps: 'as-needed',
    sortImports: true,
    singleQuote: true,
    semi: true,
    sortPackageJson: false,
    sortTailwindcss: {
      stylesheet: './src/globals.css',
      functions: ['cn', 'cva'],
    },
    tabWidth: 2,
    trailingComma: 'all',
    useTabs: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    manifest: true,
    // Two windows, two pages: the workspace and the bug-report review, each
    // its own HTML entry so main can load either by URL.
    rollupOptions: {
      input: {
        bugReport: fileURLToPath(new URL('./bug-report.html', import.meta.url)),
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
      },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      // Every include names the authored TypeScript, because these layers keep
      // CSS and documentation beside their modules.
      include: [
        'src/features/*/domain/**/*.{ts,tsx}',
        'src/features/*/application/**/*.{ts,tsx}',
        'src/features/*/infrastructure/**/*.{ts,tsx}',
        'src/features/*/hooks/**/*.{ts,tsx}',
        'src/features/*/ui/**/*.{ts,tsx}',
        'src/lib/**/*.{ts,tsx}',
        'src/app/**/*.{ts,tsx}',
        'src/platform/**/*.{ts,tsx}',
        'src/shared/**/*.{ts,tsx}',
      ],
      // Wiring records and worker entries carry no branches a line count
      // can prove: adapters.ts only assembles ports, and a worker cannot
      // run under happy-dom.
      exclude: [
        '**/*.test.*',
        '**/*.stories.*',
        '**/ports.ts',
        '**/*-port.ts',
        '**/infrastructure/adapters.ts',
        '**/*.worker.ts',
      ],
      reporter: ['text-summary'],
      // Floors guard the two pure layers only, where a line is a decision
      // and a unit test is the right proof. Everything else is measured for
      // the report and proven by behaviour, journey, and accessibility
      // evidence rather than by a line count.
      thresholds: {
        'src/features/*/domain/**': {
          lines: 85,
          functions: 85,
          branches: 75,
          statements: 85,
        },
        'src/features/*/application/**': {
          lines: 85,
          functions: 85,
          branches: 75,
          statements: 85,
        },
      },
    },
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
