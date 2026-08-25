import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function workflowJob(workflow, name) {
  const match = workflow.match(
    new RegExp(`^  ${name}:\\n(?<body>[\\s\\S]*?)(?=^  [a-z][a-z0-9-]+:|(?![\\s\\S]))`, 'm'),
  );
  assert.ok(match?.groups?.body, `CI must define the ${name} job`);
  return match.groups.body;
}

test('renderer quality CI is pinned, read-only, and publishes its audit', () => {
  const workflow = source('.github/workflows/ci.yml');
  const job = workflowJob(workflow, 'renderer-quality');

  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(
    job,
    /uses: TheOrcDev\/shadscan@1d4415ac799f453fe5ef192cf7f165433aa4e82b\s+# v0\.17\.0/,
  );
  assert.match(job, /version: ['"]0\.17\.0['"]/);
  assert.match(job, /fail-under: ['"]45['"]/);
  assert.match(job, /create-issue: ['"]false['"]/);
  assert.doesNotMatch(job, /continue-on-error:/);
  assert.doesNotMatch(job, /issues:\s*write|pull-requests:\s*write|contents:\s*write/);
  assert.match(job, /uses: actions\/upload-artifact@v6/);
  assert.match(job, /if: \$\{\{ always\(\) && steps\.shadscan\.outputs\.report-path != '' \}\}/);
  assert.match(job, /path: \$\{\{ steps\.shadscan\.outputs\.report-path \}\}/);
});

test('local renderer audit uses the same reviewed ShadScan floor as CI', () => {
  const pkg = JSON.parse(source('package.json'));

  assert.equal(
    pkg.scripts['audit:renderer'],
    'npx --yes @shadscan/cli@0.17.0 . --json --no-interactive --fail-under 45',
  );
  assert.equal(
    pkg.scripts['test:renderer-quality-gates'],
    'node --test scripts/renderer-quality-gates.test.mjs',
  );
});
