import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release.nosync');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const skipBuild = args.has('--skip-build');
const skipSmoke = args.has('--skip-smoke');
const draft = args.has('--draft');
const prerelease = args.has('--prerelease');
const tag = `v${pkg.version}`;
const repo = process.env.GITHUB_REPOSITORY || repositorySlug(pkg.repository?.url);
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

// Distributed builds (GitHub Release / Homebrew cask) MUST ship the optional
// PDF/OCR extractor sidecar — without it the packaged app throws "PDF
// extractor is not bundled" the first time a user opens a PDF. The flag is
// opt-in for dev/local builds (the extractor adds ~450MB), but the release is
// the one place where "complete" beats "lean", so force it on and make it
// mandatory: the package build bundles it, package-unsigned asserts it, and
// the smoke test verifies it end-to-end. Both child processes below inherit
// these via process.env.
process.env.STASHBASE_BUILD_EXTRACT = '1';
process.env.STASHBASE_REQUIRE_EXTRACT = '1';

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

async function getOrCreateRelease() {
  const existing = await github(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (existing) {
    console.log(`[release] found ${existing.html_url}`);
    return existing;
  }

  const created = await github(`/repos/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: `${pkg.build?.productName || pkg.name} ${tag}`,
      draft,
      prerelease,
      generate_release_notes: true,
    }),
  });
  console.log(`[release] created ${created.html_url}`);
  return created;
}

async function uploadArtifact(release, file) {
  const name = path.basename(file);
  const existing = release.assets?.find((asset) => asset.name === name);
  if (existing) {
    await github(`/repos/${repo}/releases/assets/${existing.id}`, { method: 'DELETE' });
    console.log(`[release] replaced ${name}`);
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

function ghReleaseExists() {
  try {
    execFileSync('gh', ['release', 'view', tag, '--repo', repo], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function publishWithGh(artifacts) {
  const title = `${pkg.build?.productName || pkg.name} ${tag}`;

  if (!ghReleaseExists()) {
    const createArgs = ['release', 'create', tag, '--repo', repo, '--title', title, '--generate-notes'];
    if (draft) createArgs.push('--draft');
    if (prerelease) createArgs.push('--prerelease');
    run('gh', createArgs);
  } else {
    console.log(`[release] found https://github.com/${repo}/releases/tag/${tag}`);
  }

  run('gh', ['release', 'upload', tag, ...artifacts, '--repo', repo, '--clobber']);
  console.log(`[release] done https://github.com/${repo}/releases/tag/${tag}`);
}

if (!skipBuild) {
  run(process.execPath, [path.join(root, 'scripts', 'package-unsigned.mjs')]);
}
if (!skipSmoke && process.platform === 'darwin') {
  run(process.execPath, [
    path.join(root, 'scripts', 'smoke-packaged-server.mjs'),
    '--require-transcription',
  ]);
}

const artifacts = listArtifacts();
if (artifacts.length === 0) {
  throw new Error(`No release artifacts found in ${releaseDir}.`);
}

console.log(`[release] ${repo} ${tag}`);
for (const file of artifacts) {
  console.log(`[release] artifact ${path.relative(root, file)}`);
}

if (dryRun) {
  console.log(`[release] dry run: https://github.com/${repo}/releases/tag/${tag}`);
  process.exit(0);
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

const release = await getOrCreateRelease();
for (const file of artifacts) {
  await uploadArtifact(release, file);
}

console.log(`[release] done ${release.html_url}`);
