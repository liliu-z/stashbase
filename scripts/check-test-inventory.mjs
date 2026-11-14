#!/usr/bin/env node
// Fails when a Node test file exists that no package.json script runs.
//
// Several Electron and release-script suites still name their files
// explicitly, so a new *.test.* file that is not added to a script silently
// never runs anywhere. A file counts as wired when some script names it
// verbatim or matches it through a glob token.
// Server, shared-protocol, and renderer suites run every test under their
// directory through one recursive glob or Vitest include, and Python tests use
// unittest discovery, so only the hand-listed roots are scanned here.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const commands = Object.values(pkg.scripts ?? {});

const SCAN_ROOTS = ['electron', 'scripts'];
const TEST_FILE = /\.test\.(ts|tsx|cjs|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-app', 'runtime']);

const testFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name) || entry.name.endsWith('.nosync')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs);
    else if (TEST_FILE.test(entry.name)) testFiles.push(path.relative(repoRoot, abs).split(path.sep).join('/'));
  }
}
for (const root of SCAN_ROOTS) {
  const abs = path.join(repoRoot, root);
  if (fs.existsSync(abs)) walk(abs);
}

// A glob reaching Node's runner is quoted so the shell forwards it intact.
// Only double quotes do that everywhere: pnpm runs scripts through cmd.exe on
// Windows, which passes single quotes through literally, so the runner matches
// no file and reports a passing run of zero tests.
const singleQuotedGlobs = Object.entries(pkg.scripts ?? {}).flatMap(([name, command]) =>
  [...command.matchAll(/'([^']*[*?{][^']*)'/g)].map((match) => `${name}: '${match[1]}'`));
if (singleQuotedGlobs.length > 0) {
  console.error('Single-quoted test globs match nothing on Windows; use escaped double quotes:');
  for (const entry of singleQuotedGlobs) console.error(`  ${entry}`);
  process.exit(1);
}

function expandBraces(token) {
  const match = token.match(/^(?<before>[^{}]*)\{(?<choices>[^{}]+)\}(?<after>.*)$/);
  if (!match?.groups) return [token];
  return match.groups.choices
    .split(',')
    .flatMap((choice) => expandBraces(`${match.groups.before}${choice}${match.groups.after}`));
}

const tokens = commands
  .flatMap((command) => command.split(/\s+/))
  .map((token) => token.replace(/^['"]|['"]$/g, ''))
  .flatMap(expandBraces);
const verbatim = new Set(tokens.filter((token) => TEST_FILE.test(token)));
const globMatchers = tokens
  .filter((token) => token.includes('*'))
  .map((token) => new RegExp(
    `^${token
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      // `**` spans directories; a single `*` stops at the next separator.
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '(?:[^/]+/)*')}$`,
  ));

const missing = testFiles
  .filter((file) => !verbatim.has(file) && !globMatchers.some((matcher) => matcher.test(file)))
  .sort();

if (missing.length > 0) {
  console.error('Test files not wired into any package.json script:');
  for (const file of missing) console.error(`  ${file}`);
  console.error('Add each file to the test script owned by its review contract.');
  process.exit(1);
}

console.log(`test inventory OK: ${testFiles.length} test files are wired into package.json scripts`);
