#!/usr/bin/env node
// Renderer conventions the linter cannot express. Each check names the
// rule it keeps and the one place the pattern is allowed to live, so a
// violation reads as "this belongs elsewhere", not "this is forbidden".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [absolute] : [];
  });
}

const isTest = (file) => /\.test\.tsx?$/.test(file.relative);
const isStory = (file) => /\.stories\.tsx$/.test(file.relative);
const isSource = (file) => !isTest(file) && !isStory(file) && /\.tsx?$/.test(file.relative);
const basename = (file) => file.relative.slice(file.relative.lastIndexOf('/') + 1);
const inFeatureLayers = (file, layers) =>
  new RegExp(`^features/[^/]+/(?:${layers.join('|')})/`).test(file.relative);

export // Files that still spell a radius instead of asking the shape system for one.
// It is empty, and the check asserts that it stays so: every corner in the
// renderer now comes from a `useShape()` role, from the size ladder, or from
// `shapeTokens` where the class string is built outside a component. The
// structural exceptions carry a `shape-literal:` note on their own line
// instead. The list only shrinks; a new file may not be added.
const radiusLiteralsPending = new Set([]);

const checks = [
  {
    rule: 'Colors come from tokens in globals.css; the focus-ring fallback lives in lib/focus-ring.ts',
    applies: (file) =>
      isSource(file) &&
      !['globals.css', 'lib/focus-ring.ts', 'shared/brand/logo.tsx'].includes(file.relative),
    pattern: /#[0-9a-fA-F]{3,8}\b/g,
  },
  {
    // A radius belongs to the size of the box, and the two modules below are
    // where that judgement is written down once. A `rounded-*` spelled at a
    // call site cannot follow them, so enlarging a card leaves its neighbours
    // behind — the drift this rule exists to stop.
    rule: 'Radii come from useShape() roles or the size ladder, not rounded-* literals',
    applies: (file) =>
      isSource(file) &&
      !['lib/shape-context.ts', 'lib/size-context.tsx', 'test/story-canvas.tsx'].includes(
        file.relative,
      ) &&
      !radiusLiteralsPending.has(file.relative),
    pattern: /\brounded-(?:none|sm|md|lg|xl|2xl|3xl|\[)/g,
    // A structural radius is the exception the note names: a corner inherited
    // from a host, a radius being removed rather than chosen, a variant prefix
    // no class variable can carry, or a string built outside React where no
    // hook can run. The note sits on the line so a reader of that line sees
    // why, the way `dom-contract:` does for a selector query.
    exempt: (line, previous) =>
      /shape-literal:/.test(line) || /shape-literal:/.test(previous),
  },
  {
    rule: 'Themes use light-dark() tokens, never dark: classes',
    applies: (file) => isSource(file),
    pattern: /\bdark:[a-z]/g,
  },
  {
    rule: 'Motion durations are tokens (duration-fast/base/slow, tween.*), not literals',
    applies: (file) => isSource(file),
    pattern: /\bduration-\d+\b|duration:\s*0\.\d+/g,
  },
  {
    // Interface size multiplies chrome type through --ui-scale; a literal px
    // size is the one spelling that cannot follow it.
    rule: 'Chrome type sizes follow the interface size: text-body/caption roles or text-ui-<px>, not text-[Npx]',
    applies: (file) => isSource(file),
    pattern: /\btext-\[\d+(?:\.\d+)?px\]/g,
  },
  {
    rule: 'A request signal comes from useRequestSignals or a caller, never an inline controller',
    applies: (file) => isSource(file),
    pattern: /new AbortController\(\)\.signal/g,
  },
  {
    rule: 'Panels take a typed view model, not ReturnType<typeof useX>',
    applies: (file) => isSource(file),
    pattern: /ReturnType<typeof use[A-Z]/g,
  },
  {
    rule: 'Error classes extend FeatureError from shared/domain/feature-error.ts',
    applies: (file) => isSource(file) && file.relative !== 'shared/domain/feature-error.ts',
    pattern: /extends Error\b/g,
  },
  {
    rule: 'Double casts are confined to the Milkdown seam',
    applies: (file) =>
      isSource(file) && file.relative !== 'features/documents/ui/markdown/find-controller.ts',
    pattern: /as unknown as/g,
  },
  {
    rule: 'Tests assert behaviour, not class names (class assertions live in components/ui tests)',
    applies: (file) => isTest(file) && !file.relative.startsWith('components/ui/'),
    pattern: /toHaveClass\(|className\)\.toContain/g,
  },
  {
    rule: 'Tests await conditions, never wall-clock sleeps',
    applies: (file) => isTest(file),
    pattern: /setTimeout\(\s*resolve|new Promise\(\(r(esolve)?\) => setTimeout/g,
  },
  {
    rule: 'Tests build fixtures from src/test, not local QueryClients',
    applies: (file) => isTest(file) && !file.relative.startsWith('test/'),
    pattern: /new QueryClient\(/g,
  },
  {
    rule: 'No lint or type escape hatches',
    applies: (file) => /\.tsx?$/.test(file.relative),
    pattern: /eslint-disable|oxlint-disable|@ts-ignore|@ts-expect-error|as any\b/g,
  },
  {
    // A test that reaches for a selector is asserting markup, not behaviour.
    // Where the selector really is the contract — a third-party editor's own
    // class, a data attribute the app publishes — the line says so.
    rule: 'Tests query by role, label, or test toolkit; a deliberate selector carries a // dom-contract: note',
    applies: (file) => isTest(file) && !file.relative.startsWith('components/ui/'),
    pattern: /querySelector(?:All)?\(/g,
    exempt: (line) => line.includes('// dom-contract:'),
  },
  {
    // A thrown message is written for a developer. Views select recovery by
    // kind and take their wording from the feature's failure-message module.
    rule: 'User-facing text comes from features/*/application/failure-messages.ts, never a raw error message',
    applies: (file) =>
      isSource(file) &&
      (file.relative.startsWith('app/') ||
        inFeatureLayers(file, ['ui', 'hooks', 'application'])) &&
      !/^features\/[^/]+\/application\/failure-messages\.ts$/.test(file.relative),
    pattern: /\b(?:error|caught|reason|failure)\.message\b/g,
  },
  {
    // A feature may keep a test-support module that builds its real runtime
    // over fakes. It is a fixture, not a capability: product code that reaches
    // for it is shipping test scaffolding.
    rule: 'features/*/test-support.ts is imported only from a *.test.* file',
    applies: (file) => /\.tsx?$/.test(file.relative) && !isTest(file),
    pattern: /['"][^'"]*\/test-support['"]/g,
  },
  {
    rule: 'Hooks and composition take a signal from useRequestSignals or a caller, never build a controller',
    applies: (file) =>
      isSource(file) &&
      (inFeatureLayers(file, ['hooks']) || file.relative.startsWith('app/composition/')),
    pattern: /new AbortController\b/g,
  },
  {
    rule: 'A discarded rejection says why it is safe to discard (// swallowed:)',
    applies: (file) => isSource(file),
    pattern: /\.catch\(\(\) => undefined\)/g,
    exempt: (line, previous) =>
      line.includes('// swallowed:') || previous.includes('// swallowed:'),
  },
  {
    // Locale casing is for what a reader sees. A search predicate that folds
    // by locale matches differently per machine.
    rule: 'Search predicates use toLowerCase; locale casing belongs in a format or label module',
    applies: (file) => isSource(file) && !/format|label/.test(basename(file)),
    pattern: /toLocale(?:Lower|Upper)Case\(/g,
  },
];

// A source file over this many lines opens with a doc comment saying what it owns.
export const HEADER_THRESHOLD = 150;

// ── Design tokens ──────────────────────────────────────────────────────────
// A token nothing reads is dead weight a reader still has to account for, and
// `globals.css` is one file where the consumer is never next to the
// declaration. Tailwind hides it entirely: a token declared inside `@theme` is
// reached through a generated utility class (`--color-muted` → `bg-muted`,
// `hover:bg-muted/50`), never through `var()`. So the gate resolves both
// spellings — every `var()` in the renderer's own `.ts`/`.tsx`/`.css`, which
// covers a token read by another token and by an `@utility` block, and the
// utility names Tailwind would generate from an `@theme` alias — before it
// calls a token unreferenced.

/** The utility prefixes Tailwind generates from each `@theme` namespace. */
const themeUtilityPrefixes = new Map([
  [
    '--color-',
    [
      'bg',
      'text',
      'border',
      'border-x',
      'border-y',
      'border-s',
      'border-e',
      'border-t',
      'border-r',
      'border-b',
      'border-l',
      'ring',
      'ring-offset',
      'outline',
      'fill',
      'stroke',
      'from',
      'via',
      'to',
      'caret',
      'accent',
      'decoration',
      'divide',
      'placeholder',
      'selection',
      'shadow',
      'inset-shadow',
      'text-shadow',
    ],
  ],
  ['--shadow-', ['shadow', 'inset-shadow']],
  ['--radius-', ['rounded']],
  ['--font-', ['font']],
  [
    '--spacing-',
    [
      'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'gap',
      'gap-x', 'gap-y', 'space-x', 'space-y', 'w', 'h', 'size', 'min-w', 'min-h', 'max-w',
      'max-h', 'inset', 'top', 'right', 'bottom', 'left', 'translate-x', 'translate-y',
    ],
  ],
]);

// A token whose only reader is CSS this repository does not own — a vendored
// editor or viewer stylesheet — cannot be found by the scan above, so it is
// named here with the consumer that reads it. Empty today: every token in
// `globals.css` has a reader inside `renderer/src`. The list only shrinks; an
// entry naming a token that no longer exists is itself a failure.
export const tokenConsumers = new Map();

/** The `[start, end)` span of every `@<name>` block, braces balanced. */
function atRuleSpans(text, name) {
  const spans = [];
  const opener = new RegExp(`@${name}\\b[^{]*\\{`, 'g');
  let match;
  while ((match = opener.exec(text))) {
    let depth = 1;
    let index = opener.lastIndex;
    while (index < text.length && depth > 0) {
      if (text[index] === '{') depth += 1;
      else if (text[index] === '}') depth -= 1;
      index += 1;
    }
    spans.push([match.index, index]);
  }
  return spans;
}

function utilityNames(token) {
  for (const [namespace, prefixes] of themeUtilityPrefixes) {
    if (!token.startsWith(namespace)) continue;
    const suffix = token.slice(namespace.length);
    return prefixes.map((prefix) => `${prefix}-${suffix}`);
  }
  return [];
}

// A utility is written with variants and modifiers around it — `hover:`,
// `!`, `/50` — so the boundary is "not a word character or a dash", which is
// also what keeps `bg-muted` from matching inside `bg-muted-foreground`.
function mentionsUtility(text, utility) {
  return new RegExp(`(?<![\\w-])${utility}(?![\\w-])`).test(text);
}

export function findUnreferencedTokens(files, consumers = tokenConsumers) {
  const globals = files.find((file) => file.relative === 'globals.css');
  if (!globals) return [];

  const themed = atRuleSpans(globals.text, 'theme');
  const declaration = /^[ \t]*(--[A-Za-z0-9_-]+)[ \t]*:/gm;
  const tokens = new Map();
  let match;
  while ((match = declaration.exec(globals.text))) {
    const inTheme = themed.some(([start, end]) => match.index >= start && match.index < end);
    tokens.set(match[1], (tokens.get(match[1]) ?? false) || inTheme);
  }

  const referenced = new Set();
  for (const file of files) {
    for (const use of file.text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) referenced.add(use[1]);
  }

  const violations = [];
  for (const [token, inTheme] of tokens) {
    if (referenced.has(token)) continue;
    if (consumers.has(token)) continue;
    const utilities = inTheme ? utilityNames(token) : [];
    if (utilities.some((utility) => files.some((file) => mentionsUtility(file.text, utility))))
      continue;
    violations.push(
      `globals.css: ${token} is defined but nothing reads it — a token with no var(), no @theme utility, and no named third-party consumer is deleted, not kept`,
    );
  }
  for (const [token, consumer] of consumers) {
    if (tokens.has(token)) continue;
    violations.push(
      `globals.css: ${token} is listed as read by ${consumer} but is no longer defined`,
    );
  }
  return violations;
}

function countMatches(text, check) {
  return text.match(check.pattern)?.length ?? 0;
}

// A check with an `exempt` predicate is line-scoped: the note that grants the
// exception has to sit where a reader of that line will see it, so counting
// happens line by line rather than over the whole file.
function countUnexempted(file, check) {
  const lines = file.text.split('\n');
  let count = 0;
  for (const [index, line] of lines.entries()) {
    if (check.exempt(line, lines[index - 1] ?? '')) continue;
    count += countMatches(line, check);
  }
  return count;
}

export function findRendererConventionViolations(root = repositoryRoot) {
  const sourceRoot = path.join(root, 'renderer/src');
  const files = walk(sourceRoot).map((absolute) => ({
    absolute,
    relative: path.relative(sourceRoot, absolute).split(path.sep).join('/'),
    text: fs.readFileSync(absolute, 'utf8'),
  }));

  const violations = [];
  for (const check of checks) {
    for (const file of files) {
      if (!check.applies(file)) continue;
      const count = check.exempt ? countUnexempted(file, check) : countMatches(file.text, check);
      if (count > 0) violations.push(`${file.relative}: ${count}× — ${check.rule}`);
    }
  }

  for (const file of files) {
    if (!isSource(file)) continue;
    const lines = file.text.split('\n');
    if (lines.length <= HEADER_THRESHOLD) continue;
    const head = file.text.slice(0, 400);
    if (!/^(\/\*\*|\/\/)/.test(head.trimStart())) {
      violations.push(`${file.relative}: ${lines.length} lines without a module header comment`);
    }
  }

  violations.push(...findUnreferencedTokens(files));

  return violations.sort();
}

export function checkConventions(root = repositoryRoot) {
  const violations = findRendererConventionViolations(root);
  if (violations.length === 0) return;
  throw new Error(`Renderer convention violations:\n${violations.join('\n')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = findRendererConventionViolations();
  if (violations.length) {
    console.error(`[renderer conventions] ${violations.length} violation(s):`);
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log('renderer conventions check passed');
}
