import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDraftReleaseByTag } from './github-release-api.mjs';
import { assertMacUpdateArtifacts } from './update-artifact-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release.nosync');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const skipBuild = args.has('--skip-build');
const skipSmoke = args.has('--skip-smoke');
const requireDraft = args.has('--require-draft');
const tag = `v${pkg.version}`;
const repo = process.env.GITHUB_REPOSITORY || repositorySlug(pkg.repository?.url);
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

// Distributed builds (GitHub Release / Homebrew cask) MUST ship the optional
// PDF/OCR extractor sidecar — without it the packaged app throws "PDF
// extractor is not bundled" the first time a user opens a PDF. The flag is
// opt-in for dev/local builds (the extractor adds ~450MB), but the release is
// the one place where "complete" beats "lean", so force it on and make it
// mandatory: the package build bundles it, package-desktop asserts it, and
// the smoke test verifies it end-to-end. Both child processes below inherit
// these via process.env.
process.env.STASHBASE_BUILD_EXTRACT = '1';
process.env.STASHBASE_REQUIRE_EXTRACT = '1';
if (process.platform === 'darwin') process.env.STASHBASE_RELEASE_BUILD = '1';

if (!repo) {
  throw new Error('Unable to determine GitHub repository. Set GITHUB_REPOSITORY=owner/repo.');
}

function repositorySlug(value) {
  if (!value) return null;
  return String(value)
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

function run(command, commandArgs) {
  execFileSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
}

function commandExists(command, commandArgs = ['--version']) {
  try {
    execFileSync(command, commandArgs, { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function listArtifacts() {
  if (!fs.existsSync(releaseDir)) return [];

  return fs
    .readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .filter((entry) => entry.name.includes(pkg.version) || /^latest.*\.ya?ml$/.test(entry.name))
    .map((entry) => path.join(releaseDir, entry.name))
    .filter((file) => fs.statSync(file).size > 0)
    .sort();
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.dmg') return 'application/x-apple-diskimage';
  if (ext === '.zip') return 'application/zip';
  if (ext === '.exe') return 'application/vnd.microsoft.portable-executable';
  if (ext === '.yml' || ext === '.yaml') return 'text/yaml';
  return 'application/octet-stream';
}

async function github(pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `https://api.github.com${pathname}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': `${pkg.name}-release-script`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });

  if (response.status === 404) return null;
  if (response.status === 204) return null;
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function getDraftRelease() {
  const existing = await findDraftReleaseByTag({ request: github, repo, tag });
  console.log(`[release] found ${existing.html_url}`);
  return existing;
}

async function uploadArtifact(release, file) {
  const name = path.basename(file);
  const existing = release.assets?.find((asset) => asset.name === name);
  if (existing) {
    throw new Error(
      `Release ${tag} already contains ${name}. Versioned assets are immutable; ` +
        'delete the incomplete draft and restart the coordinated release.',
    );
  }

  const size = fs.statSync(file).size;
  const uploadUrl = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Length': String(size),
      'Content-Type': contentTypeFor(file),
      'User-Agent': `${pkg.name}-release-script`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: fs.createReadStream(file),
    duplex: 'half',
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Failed to upload ${name}: ${response.status} ${response.statusText}: ${text}`);
  }

  console.log(`[release] uploaded ${name}`);
}

function ghReleaseInfo() {
  try {
    const output = execFileSync(
      'gh',
      ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function publishWithGh(artifacts) {
  const existing = ghReleaseInfo();

  if (!existing) {
    throw new Error(`Draft release ${tag} does not exist. Start the coordinated Release workflow.`);
  }
  if (!existing.isDraft) {
    throw new Error(`Release ${tag} must remain a draft while assets are uploaded.`);
  }
  const existingNames = new Set((existing.assets || []).map((asset) => asset.name));
  const duplicate = artifacts.map((file) => path.basename(file)).find((name) => existingNames.has(name));
  if (duplicate) {
    throw new Error(
      `Release ${tag} already contains ${duplicate}. Versioned assets are immutable; ` +
        'delete the incomplete draft and restart the coordinated release.',
    );
  }
  console.log(`[release] found https://github.com/${repo}/releases/tag/${tag}`);

  run('gh', ['release', 'upload', tag, ...artifacts, '--repo', repo]);
  console.log(`[release] done https://github.com/${repo}/releases/tag/${tag}`);
}

if (!skipBuild) {
  run(process.execPath, [path.join(root, 'scripts', 'package-desktop.mjs')]);
}
if (!skipSmoke && process.platform === 'darwin') {
  run(process.execPath, [
    path.join(root, 'scripts', 'smoke-packaged-server.mjs'),
    '--require-transcription',
  ]);
}
if (process.platform === 'darwin') {
  run(process.execPath, [
    path.join(root, 'scripts', 'release-verify-mac.mjs'),
    '--skip-build',
    '--skip-smoke',
  ]);
}

const artifacts = listArtifacts();
if (artifacts.length === 0) {
  throw new Error(`No release artifacts found in ${releaseDir}.`);
}
if (process.platform === 'darwin') assertMacUpdateArtifacts(artifacts);

console.log(`[release] ${repo} ${tag}`);
for (const file of artifacts) {
  console.log(`[release] artifact ${path.relative(root, file)}`);
}

if (dryRun) {
  console.log(`[release] dry run: https://github.com/${repo}/releases/tag/${tag}`);
  process.exit(0);
}

if (!requireDraft) {
  throw new Error('Real uploads must use --require-draft from the coordinated Release workflow.');
}

if (!token) {
  if (!commandExists('gh')) {
    throw new Error(
      'GitHub Release assets cannot be uploaded with SSH keys alone. ' +
        'Install and authenticate GitHub CLI (`brew install gh && gh auth login`) or set GITHUB_TOKEN.',
    );
  }
  publishWithGh(artifacts);
  process.exit(0);
}

const release = await getDraftRelease();
for (const file of artifacts) {
  await uploadArtifact(release, file);
}

console.log(`[release] done ${release.html_url}`);
