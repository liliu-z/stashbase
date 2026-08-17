import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const packageScripts = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
).scripts ?? {};

function repositoryFiles(pathspec) {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', pathspec], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
}

function headingAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[\p{P}\p{S}]/gu, (character) => character === '-' || character === '_' ? character : '')
    .replace(/\s/g, '-');
}

const repoFiles = repositoryFiles('*');
const files = repositoryFiles('*.md').map((file) => path.join(repoRoot, file));
const contents = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]));
const anchors = new Map(files.map((file) => {
  const found = new Set();
  for (const match of contents.get(file).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    found.add(headingAnchor(match[1].replace(/\s+#+\s*$/, '')));
  }
  return [file, found];
}));

for (const [source, markdown] of contents) {
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    if (!rawTarget || /^(?:https?:|mailto:)/i.test(rawTarget)) continue;
    const [rawPath, rawAnchor] = rawTarget.split('#', 2);
    const target = rawPath ? path.resolve(path.dirname(source), decodeURIComponent(rawPath)) : source;
    if (!fs.existsSync(target)) {
      failures.push(`${path.relative(repoRoot, source)}: missing link target ${rawTarget}`);
      continue;
    }
    if (rawAnchor && target.endsWith('.md')) {
      const expected = decodeURIComponent(rawAnchor).toLowerCase();
      if (!anchors.get(target)?.has(expected)) {
        failures.push(`${path.relative(repoRoot, source)}: missing anchor #${rawAnchor} in ${path.relative(repoRoot, target)}`);
      }
    }
  }

  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const referencedPath = match[1].trim();
    if (
      !/\.(?:cjs|css|html|js|json|md|mjs|py|toml|ts|tsx|ya?ml)$/.test(referencedPath)
      || /[*{]|→|\s/.test(referencedPath)
      || referencedPath.startsWith('/')
      || referencedPath.startsWith('~')
    ) continue;
    const exact = path.join(repoRoot, referencedPath);
    const suffix = `/${referencedPath.replaceAll('\\', '/')}`;
    const exists = fs.existsSync(exact)
      || repoFiles.some((candidate) => candidate === referencedPath || candidate.endsWith(suffix));
    const isReviewReference = path.relative(repoRoot, source).startsWith('code-review/');
    const hasRepoPrefix = /^(?:\.github|code-review|design-docs|docs|e2e|electron|mcp|native|python|release-checklists|scripts|server|shared|web-src)\//.test(referencedPath);
    if (!exists && (isReviewReference || hasRepoPrefix)) {
      failures.push(`${path.relative(repoRoot, source)}: missing referenced path ${referencedPath}`);
    }
  }
}

const forbidden = [
  'design-docs/use-cases.md',
  'design-docs/design/library.md',
  'design-docs/design/markdown.md',
  'code-review/data-layer.md',
];
for (const [file, markdown] of contents) {
  for (const legacy of forbidden) {
    if (markdown.includes(legacy)) failures.push(`${path.relative(repoRoot, file)}: references retired path ${legacy}`);
  }
}

const focusedContracts = fs.readdirSync(path.join(repoRoot, 'code-review'))
  .filter((name) => name.endsWith('.md') && !['README.md', 'journey-coverage.md'].includes(name))
  .sort();
const reviewGuide = fs.readFileSync(path.join(repoRoot, 'code-review', 'README.md'), 'utf8');
for (const heading of ['Intent-first Review', 'Diff-first Review', 'Review Output Contract']) {
  if (!reviewGuide.includes(`## ${heading}`)) {
    failures.push(`code-review/README.md: missing ${heading}`);
  }
}
for (const name of focusedContracts) {
  const markdown = fs.readFileSync(path.join(repoRoot, 'code-review', name), 'utf8');
  if (!/^## Implementation Map$/m.test(markdown)) failures.push(`code-review/${name}: missing Implementation Map`);
  if (!/^## (?:.* )?Validation(?: .*)?$/im.test(markdown)) failures.push(`code-review/${name}: missing Validation section`);
  if (!reviewGuide.includes(`(${name})`)) failures.push(`code-review/README.md: missing route to ${name}`);
}

for (const [file, markdown] of contents) {
  if (!path.relative(repoRoot, file).startsWith('code-review/')) continue;
  for (const match of markdown.matchAll(/\bpnpm\s+([a-z][a-z0-9:_-]*)/gi)) {
    if (!packageScripts[match[1]]) {
      failures.push(`${path.relative(repoRoot, file)}: missing package script ${match[1]}`);
    }
  }
}

const requiredAreaHeadings = [
  'User Outcome',
  'Scope and Non-goals',
  'Current Experience',
  'Experience Contract',
  'Cross-area Seams',
  'Contribution Direction',
  'Related Journeys and Contracts',
];
const designGuide = fs.readFileSync(path.join(repoRoot, 'design-docs', 'README.md'), 'utf8');
const areaFiles = fs.readdirSync(path.join(repoRoot, 'design-docs', 'design'))
  .filter((name) => name.endsWith('.md'))
  .sort();
for (const name of areaFiles) {
  const markdown = fs.readFileSync(path.join(repoRoot, 'design-docs', 'design', name), 'utf8');
  for (const heading of requiredAreaHeadings) {
    if (!markdown.includes(`## ${heading}`)) failures.push(`design-docs/design/${name}: missing ${heading}`);
  }
  if (!designGuide.includes(`(design/${name})`)) failures.push(`design-docs/README.md: missing product-area route to ${name}`);
}

const journeyDoc = fs.readFileSync(path.join(repoRoot, 'design-docs/user-journeys.md'), 'utf8');
const coverageDoc = fs.readFileSync(path.join(repoRoot, 'code-review/journey-coverage.md'), 'utf8');
const journeyMatches = [...journeyDoc.matchAll(/^## (J\d{2}):[^\n]*$/gm)];
const journeyIds = journeyMatches.map((match) => match[1]);
const uniqueJourneyIds = [...new Set(journeyIds)];
const requiredJourneyHeadings = [
  'Outcome',
  'Entry State',
  'Primary Flow',
  'Required Observable Results',
  'Degradation and Recovery',
  'Evidence',
];
const traceRows = new Map();
for (const line of coverageDoc.split('\n')) {
  if (!/^\| \[J\d{2} /.test(line)) continue;
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
  const id = /^\[(J\d{2}) /.exec(cells[0])?.[1];
  if (!id) continue;
  traceRows.set(id, { areas: cells[1], contracts: cells[2] });
}
for (const [index, id] of uniqueJourneyIds.entries()) {
  const expected = `J${String(index + 1).padStart(2, '0')}`;
  if (id !== expected) failures.push(`design-docs/user-journeys.md: expected ${expected}, found ${id}`);
  const headingCount = journeyIds.filter((candidate) => candidate === id).length;
  if (headingCount !== 1) failures.push(`design-docs/user-journeys.md: expected one ${id} heading, found ${headingCount}`);
  const coverageCount = [...coverageDoc.matchAll(new RegExp(`^\\| \\[${id} `, 'gm'))].length;
  if (coverageCount !== 1) failures.push(`code-review/journey-coverage.md: expected one ${id} evidence row, found ${coverageCount}`);

  const journeyMatch = journeyMatches[index];
  const nextJourneyMatch = journeyMatches[index + 1];
  const journeySection = journeyDoc.slice(
    journeyMatch.index,
    nextJourneyMatch?.index ?? journeyDoc.length,
  );
  for (const heading of requiredJourneyHeadings) {
    if (!journeySection.includes(`### ${heading}`)) {
      failures.push(`design-docs/user-journeys.md: ${id} missing ${heading}`);
    }
  }

  const coverageHeading = new RegExp(`^## ${id}:[^\\n]*$`, 'm').exec(coverageDoc);
  if (!coverageHeading) {
    failures.push(`code-review/journey-coverage.md: missing ${id} evidence section`);
  } else {
    const followingHeading = /^## J\d{2}:[^\n]*$/gm;
    followingHeading.lastIndex = coverageHeading.index + coverageHeading[0].length;
    const nextCoverageHeading = followingHeading.exec(coverageDoc);
    const coverageSection = coverageDoc.slice(
      coverageHeading.index,
      nextCoverageHeading?.index ?? coverageDoc.indexOf('\n## Maintenance Rule', coverageHeading.index),
    );
    for (const label of ['Status', 'Contract Test', 'Journey E2E', 'AI Eval', 'Release Check']) {
      if (!coverageSection.includes(`**${label}:**`)) {
        failures.push(`code-review/journey-coverage.md: ${id} missing ${label}`);
      }
    }
  }

  const trace = traceRows.get(id);
  if (!trace) continue;
  const areaTargets = [...trace.areas.matchAll(/\]\(\.\.\/design-docs\/design\/([^)]+\.md)\)/g)]
    .map((match) => match[1]);
  const contractTargets = [...trace.contracts.matchAll(/\]\(([^/)]+\.md)\)/g)]
    .map((match) => match[1]);
  if (areaTargets.length === 0) failures.push(`code-review/journey-coverage.md: ${id} has no product area`);
  if (contractTargets.length === 0) failures.push(`code-review/journey-coverage.md: ${id} has no review contract`);

  for (const target of areaTargets) {
    const area = path.join(repoRoot, 'design-docs', 'design', target);
    if (!contents.get(area)?.includes(`[${id}](`)) {
      failures.push(`design-docs/design/${target}: missing reciprocal ${id} route from Journey Coverage`);
    }
  }
  for (const target of contractTargets) {
    const contract = path.join(repoRoot, 'code-review', target);
    if (!contents.get(contract)?.includes(`[${id}](`)) {
      failures.push(`code-review/${target}: missing reciprocal ${id} route from Journey Coverage`);
    }
  }
}
for (const match of coverageDoc.matchAll(/^\| \[(J\d{2}) /gm)) {
  if (!uniqueJourneyIds.includes(match[1])) {
    failures.push(`code-review/journey-coverage.md: ${match[1]} has no journey definition`);
  }
}

if (failures.length > 0) {
  console.error(`[docs] ${failures.length} validation failure(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const journeyRange = uniqueJourneyIds.length > 0
    ? `${uniqueJourneyIds[0]}-${uniqueJourneyIds.at(-1)}`
    : 'no journeys';
  console.log(`[docs] verified ${files.length} repository Markdown files, local links, reciprocal journey routes, implementation references, documented commands, and ${journeyRange} coverage`);
}
