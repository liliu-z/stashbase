#!/usr/bin/env node
// Fails when a Node test file exists that no package.json script runs.
//
// Server-side suites enumerate their files explicitly, so a new *.test.*
// file that is not added to a script silently never runs anywhere — six
// files drifted that way before this check existed. A file counts as wired
// when some script names it verbatim or matches it through a glob token
// (e.g. `web-src/src/__tests__/*.test.ts`). Playwright specs (*.spec.ts)
// are collected by playwright.config.ts and Python tests by unittest
// discovery, so neither needs this check.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const commands = Object.values(pkg.scripts ?? {});

const SCAN_ROOTS = ['server', 'electron', 'shared', 'mcp', 'scripts', 'web-src', 'e2e'];
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

const tokens = commands.flatMap((command) => command.split(/\s+/));
const verbatim = new Set(tokens.filter((token) => TEST_FILE.test(token)));
const globMatchers = tokens
  .filter((token) => token.includes('*'))
  .map((token) => new RegExp(
    `^${token.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
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
