import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findDraftReleaseByTag,
  releaseAssetContentType,
  uploadReleaseAssets,
} from './github-release-api.mjs';

// A single asset must not hold the job open once its upload has stalled; the
// attempt is aborted so the retry rules can take over.
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.RELEASE_TAG || `v${pkg.version}`;
const token = resolveToken();

if (files.length === 0) throw new Error('No release assets were given to upload.');
if (!repo) throw new Error('Unable to determine GitHub repository. Set GITHUB_REPOSITORY=owner/repo.');

function resolveToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('gh', ['auth', 'token'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'GitHub Release assets need an API token. Set GITHUB_TOKEN or authenticate GitHub CLI ' +
        '(`gh auth login`).',
    );
  }
}

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': `${pkg.name}-release-upload`,
  'X-GitHub-Api-Version': '2022-11-28',
};

async function request(pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `https://api.github.com${pathname}`;
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (response.status === 404 || response.status === 204) return null;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function assetApi(releaseId) {
  return {
    async listAssets() {
      const stored = [];
      for (let page = 1; ; page += 1) {
        const batch =
          (await request(`/repos/${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`)) ||
          [];
        stored.push(...batch);
        if (batch.length < 100) return stored;
      }
    },
    async deleteAsset(id) {
      await request(`/repos/${repo}/releases/assets/${id}`, { method: 'DELETE' });
    },
    async putAsset(asset) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
      try {
        const response = await fetch(
          `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
          {
            method: 'POST',
            headers: {
              ...headers,
              'Content-Length': String(asset.size),
              'Content-Type': releaseAssetContentType(asset.name),
            },
            body: fs.createReadStream(asset.path),
            duplex: 'half',
            signal: controller.signal,
          },
        );
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          body: await response.text(),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const assets = [];
for (const file of files) {
  const resolved = path.resolve(root, file);
  const size = fs.statSync(resolved).size;
  if (size === 0) throw new Error(`Refusing to upload an empty asset: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(resolved)) hash.update(chunk);
  assets.push({ path: resolved, name: path.basename(resolved), size, digest: `sha256:${hash.digest('hex')}` });
}

const release = await findDraftReleaseByTag({ request, repo, tag });
console.log(`[release] ${repo} ${tag} ${release.html_url}`);

await uploadReleaseAssets({
  api: assetApi(release.id),
  tag,
  assets,
  log: (message) => console.log(message),
});

console.log(`[release] done ${release.html_url}`);
