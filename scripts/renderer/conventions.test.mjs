// The conventions gate is grep-shaped, so its own regressions are silent:
// a pattern that stops matching still exits zero. Each case below plants one
// violation of one rule and asserts the exact sentence the gate reports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findRendererConventionViolations,
  findUnreferencedTokens,
  tokenConsumers,
} from './conventions.mjs';

function write(root, relativePath, source) {
  const absolutePath = path.join(root, 'renderer/src', relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, source);
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-renderer-conventions-'));
  context.after(() => fs.rmSync(root, { recursive: true, maxRetries: 10, retryDelay: 100 }));
  fs.mkdirSync(path.join(root, 'renderer/src'), { recursive: true });
  return root;
}

const longBody = `${'export const filler = 1;\n'.repeat(160)}`;

test('a renderer tree that follows the conventions reports nothing', (context) => {
  const root = fixture(context);
  write(root, 'lib/tokens.ts', "export const surface = 'var(--surface)';\n");
  write(root, 'features/workspace/ui/panel.tsx', "export const label = 'Workspace';\n");
  write(
    root,
    'features/workspace/ui/panel.test.tsx',
    "import { screen } from '@/test/render';\nexport const probe = screen;\n",
  );
  write(root, 'components/ui/button.test.tsx', "expect(node).toHaveClass('rounded');\n");
  write(root, 'lib/long.ts', `// Owns the long thing.\n${longBody}`);
  write(root, 'features/workspace/test-support.ts', 'export const build = () => true;\n');
  write(
    root,
    'features/workspace/application/runtime.test.ts',
    "import { build } from '@/features/workspace/test-support';\nexport { build };\n",
  );

  assert.deepEqual(findRendererConventionViolations(root), []);
});

test('the newer conventions report the file, the count, and the rule they keep', (context) => {
  const root = fixture(context);
  write(
    root,
    'features/workspace/ui/tree.test.tsx',
    'expect(container.querySelector("[data-row]")).not.toBeNull();\n' +
      'expect(container.querySelectorAll("[data-row]")).toHaveLength(2);\n',
  );
  write(
    root,
    'features/workspace/ui/notice.tsx',
    'export const text = (error: Error) => error.message;\n',
  );
  write(
    root,
    'app/composition/offer.tsx',
    'export const abort = () => new AbortController();\n' +
      'export const label = (reason: Error) => reason.message;\n',
  );
  write(
    root,
    'features/workspace/hooks/use-reveal.ts',
    'export const run = () => new AbortController().abort();\n',
  );
  write(root, 'features/workspace/ui/save.ts', 'void save().catch(() => undefined);\n');
  write(root, 'features/retrieval/domain/match.ts', 'export const fold = (q: string) => q.toLocaleLowerCase();\n');

  assert.deepEqual(findRendererConventionViolations(root), [
    'app/composition/offer.tsx: 1× — Hooks and composition take a signal from useRequestSignals or a caller, never build a controller',
    'app/composition/offer.tsx: 1× — User-facing text comes from features/*/application/failure-messages.ts, never a raw error message',
    'features/retrieval/domain/match.ts: 1× — Search predicates use toLowerCase; locale casing belongs in a format or label module',
    'features/workspace/hooks/use-reveal.ts: 1× — Hooks and composition take a signal from useRequestSignals or a caller, never build a controller',
    'features/workspace/ui/notice.tsx: 1× — User-facing text comes from features/*/application/failure-messages.ts, never a raw error message',
    'features/workspace/ui/save.ts: 1× — A discarded rejection says why it is safe to discard (// swallowed:)',
    'features/workspace/ui/tree.test.tsx: 2× — Tests query by role, label, or test toolkit; a deliberate selector carries a // dom-contract: note',
  ]);
});

test('the failure-message home is one filename in one layer, and test-support is test-only', (context) => {
  const root = fixture(context);
  // The two older spellings and a copy outside `application` lost their pass.
  write(
    root,
    'features/documents/application/failures.ts',
    'export const say = (error: Error) => error.message;\n',
  );
  write(
    root,
    'features/documents/ui/failure.ts',
    'export const say = (caught: Error) => caught.message;\n',
  );
  write(
    root,
    'features/documents/ui/failure-messages.ts',
    'export const say = (reason: Error) => reason.message;\n',
  );
  // Product code and a story are not tests.
  write(
    root,
    'features/workspace/ui/panel.tsx',
    "import { build } from '@/features/workspace/test-support';\nexport { build };\n",
  );
  write(
    root,
    'features/workspace/ui/panel.stories.tsx',
    "import { build } from './test-support';\nexport { build };\n",
  );

  assert.deepEqual(findRendererConventionViolations(root), [
    'features/documents/application/failures.ts: 1× — User-facing text comes from features/*/application/failure-messages.ts, never a raw error message',
    'features/documents/ui/failure-messages.ts: 1× — User-facing text comes from features/*/application/failure-messages.ts, never a raw error message',
    'features/documents/ui/failure.ts: 1× — User-facing text comes from features/*/application/failure-messages.ts, never a raw error message',
    'features/workspace/ui/panel.stories.tsx: 1× — features/*/test-support.ts is imported only from a *.test.* file',
    'features/workspace/ui/panel.tsx: 1× — features/*/test-support.ts is imported only from a *.test.* file',
  ]);
});

test('the newer conventions exempt the homes and the annotated lines that earn it', (context) => {
  const root = fixture(context);
  // A selector that is the contract says so on its own line.
  write(
    root,
    'features/workspace/ui/tree.test.tsx',
    'expect(host.querySelector(".cm-editor")).not.toBeNull(); // dom-contract: CodeMirror owns this class\n',
  );
  write(root, 'components/ui/menu.test.tsx', 'host.querySelectorAll("[role=menuitem]");\n');
  // The failure-message module is where a kind becomes a sentence, and it has
  // one name in one layer.
  write(
    root,
    'features/workspace/application/failure-messages.ts',
    'export const say = (failure: Error) => failure.message;\n',
  );
  // Layers outside ui/hooks/application, and outside app, keep the pattern.
  write(
    root,
    'features/documents/infrastructure/api.ts',
    'export const map = (error: Error) => error.message;\n',
  );
  // A controller is still built where the request actually lives.
  write(
    root,
    'features/documents/application/runtime.ts',
    'export const run = () => new AbortController().abort();\n',
  );
  write(root, 'lib/use-request-signals.ts', 'export const run = () => new AbortController().abort();\n');
  // A discarded rejection that explains itself, on the line and above it.
  write(
    root,
    'features/workspace/ui/save.ts',
    'void save().catch(() => undefined); // swallowed: the tab is already gone\n' +
      '// swallowed: shutdown races the flush\nvoid flush().catch(() => undefined);\n',
  );
  // Locale casing is what a format or label module is for.
  write(root, 'shared/utils/format-date.ts', 'export const up = (s: string) => s.toLocaleUpperCase();\n');
  write(root, 'features/agent/ui/label-case.ts', 'export const down = (s: string) => s.toLocaleLowerCase();\n');

  assert.deepEqual(findRendererConventionViolations(root), []);
});

test('each convention reports the file, the count, and the rule it keeps', (context) => {
  const root = fixture(context);
  write(root, 'lib/color.ts', "export const brand = '#ff0000';\n");
  write(root, 'lib/theme.tsx', "export const chip = 'dark:bg-slate-900';\n");
  write(root, 'lib/motion.ts', "export const fade = 'duration-200';\n");
  write(root, 'lib/type.tsx', "export const label = 'text-[11px] text-ui-11';\n");
  write(root, 'lib/signal.ts', 'export const signal = new AbortController().signal;\n');
  write(root, 'lib/view-model.ts', 'export type Panel = ReturnType<typeof useWorkspace>;\n');
  write(root, 'lib/failure.ts', 'export class LoadFailure extends Error {}\n');
  write(root, 'lib/cast.ts', "export const value = 1 as unknown as string;\n");
  write(root, 'lib/hatch.ts', 'export const value = 1;\n// @ts-expect-error narrow it later\n');
  write(root, 'lib/long.ts', longBody);
  write(root, 'features/workspace/ui/panel.test.tsx', "expect(node).toHaveClass('rounded');\n");
  write(
    root,
    'features/workspace/ui/wait.test.ts',
    'export const wait = (resolve: () => void) => setTimeout(resolve, 1);\n',
  );
  write(root, 'features/workspace/ui/query.test.ts', 'export const client = new QueryClient();\n');

  assert.deepEqual(findRendererConventionViolations(root), [
    'features/workspace/ui/panel.test.tsx: 1× — Tests assert behaviour, not class names (class assertions live in components/ui tests)',
    'features/workspace/ui/query.test.ts: 1× — Tests build fixtures from src/test, not local QueryClients',
    'features/workspace/ui/wait.test.ts: 1× — Tests await conditions, never wall-clock sleeps',
    'lib/cast.ts: 1× — Double casts are confined to the Milkdown seam',
    'lib/color.ts: 1× — Colors come from tokens in globals.css; the focus-ring fallback lives in lib/focus-ring.ts',
    'lib/failure.ts: 1× — Error classes extend FeatureError from shared/domain/feature-error.ts',
    'lib/hatch.ts: 1× — No lint or type escape hatches',
    'lib/long.ts: 161 lines without a module header comment',
    'lib/motion.ts: 1× — Motion durations are tokens (duration-fast/base/slow, tween.*), not literals',
    'lib/signal.ts: 1× — A request signal comes from useRequestSignals or a caller, never an inline controller',
    'lib/theme.tsx: 1× — Themes use light-dark() tokens, never dark: classes',
    'lib/type.tsx: 1× — Chrome type sizes follow the interface size: text-body/caption roles or text-ui-<px>, not text-[Npx]',
    'lib/view-model.ts: 1× — Panels take a typed view model, not ReturnType<typeof useX>',
  ]);
});

test('the allowed homes for each pattern stay exempt', (context) => {
  const root = fixture(context);
  write(root, 'lib/focus-ring.ts', "export const ring = '#0a84ff';\n");
  write(root, 'shared/brand/logo.tsx', "export const mark = '#111827';\n");
  write(root, 'shared/domain/feature-error.ts', 'export class FeatureError extends Error {}\n');
  write(
    root,
    'features/documents/ui/markdown/find-controller.ts',
    'export const view = editor as unknown as EditorView;\n',
  );
  write(root, 'components/ui/button.test.tsx', "expect(node).toHaveClass('rounded');\n");
  write(root, 'test/render.tsx', 'export const client = new QueryClient();\n');
  write(root, 'features/workspace/ui/panel.stories.tsx', "export const brand = '#ff0000';\n");

  assert.deepEqual(findRendererConventionViolations(root), []);
});

// ── Design tokens ──
// The token gate has two ways to be wrong and both are silent: it can miss a
// dead token, and it can call a live one dead because Tailwind reads it as a
// utility class rather than through var().

const themedGlobals = `@theme inline {
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --shadow-surface-1: var(--shadow-1);
  --font-sans: 'Inter', sans-serif;
}

:root {
  --muted: #f4f4f5;
  --muted-foreground: #737373;
  --shadow-color: rgb(0 0 0 / 0.06);
  --shadow-1: 0 0 0 1px var(--shadow-color);
  --fs-body: 13px;
}

@utility text-body {
  font-size: var(--fs-body);
}

body {
  font-family: var(--font-sans);
}
`;

test('a token is read through var(), another token, an @utility block, or a Tailwind utility', (context) => {
  const root = fixture(context);
  write(root, 'globals.css', themedGlobals);
  // --color-muted and --color-muted-foreground are reached only as classes,
  // through a variant and a modifier; --shadow-surface-1 as a bare utility.
  write(
    root,
    'features/workspace/ui/panel.tsx',
    "export const card = 'hover:bg-muted/50 text-muted-foreground shadow-surface-1 text-body';\n",
  );

  assert.deepEqual(findRendererConventionViolations(root), []);
});

test('a token nothing reads is reported against globals.css', (context) => {
  const root = fixture(context);
  write(
    root,
    'globals.css',
    ':root {\n  --surface-1: #fafafa;\n  --shadow-2-inset: inset 0 0 0 1px #000;\n}\n\nbody {\n  background: var(--surface-1);\n}\n',
  );

  assert.deepEqual(findRendererConventionViolations(root), [
    'globals.css: --shadow-2-inset is defined but nothing reads it — a token with no var(), no @theme utility, and no named third-party consumer is deleted, not kept',
  ]);
});

test('a longer utility does not cover the shorter token it starts with', (context) => {
  const root = fixture(context);
  write(
    root,
    'globals.css',
    '@theme inline {\n  --color-muted: #f4f4f5;\n  --color-muted-foreground: #737373;\n}\n',
  );
  write(root, 'features/workspace/ui/panel.tsx', "export const label = 'text-muted-foreground';\n");

  assert.deepEqual(findRendererConventionViolations(root), [
    'globals.css: --color-muted is defined but nothing reads it — a token with no var(), no @theme utility, and no named third-party consumer is deleted, not kept',
  ]);
});

test('a utility name only counts for a token declared inside @theme', (context) => {
  const root = fixture(context);
  // Outside `@theme` Tailwind generates nothing, so the class name is a
  // coincidence rather than the consumer.
  write(root, 'globals.css', ':root {\n  --color-muted: #f4f4f5;\n}\n');
  write(root, 'features/workspace/ui/panel.tsx', "export const card = 'bg-muted';\n");

  assert.deepEqual(findRendererConventionViolations(root), [
    'globals.css: --color-muted is defined but nothing reads it — a token with no var(), no @theme utility, and no named third-party consumer is deleted, not kept',
  ]);
});

test('a token named as read by third-party CSS passes, and its entry fails once the token is gone', () => {
  const files = [
    { relative: 'globals.css', text: ':root {\n  --milkdown-seam: 8px;\n}\n' },
    { relative: 'app/shell.css', text: 'body { margin: 0; }\n' },
  ];
  const consumers = new Map([['--milkdown-seam', 'the Milkdown editor stylesheet']]);

  assert.deepEqual(findUnreferencedTokens(files, consumers), []);
  assert.deepEqual(findUnreferencedTokens([{ relative: 'globals.css', text: ':root {\n}\n' }], consumers), [
    'globals.css: --milkdown-seam is listed as read by the Milkdown editor stylesheet but is no longer defined',
  ]);
});

test('the shipped third-party token allowlist is empty', () => {
  assert.deepEqual([...tokenConsumers.keys()], []);
});
