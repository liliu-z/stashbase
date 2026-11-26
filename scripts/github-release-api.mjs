/** The owner/name slug from GITHUB_REPOSITORY, else package.json's repository URL. */
export function releaseRepository(pkg) {
  const repo = process.env.GITHUB_REPOSITORY || repositorySlug(pkg.repository?.url);
  if (!repo) {
    throw new Error('Unable to determine GitHub repository. Set GITHUB_REPOSITORY=owner/repo.');
  }
  return repo;
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

export async function findDraftReleaseByTag({ request, repo, tag }) {
  const [owner, name, ...extra] = repo.split('/');
  if (!owner || !name || extra.length > 0) {
    throw new Error(`Invalid GitHub repository slug: ${repo}`);
  }
  const query = 'query RepositoryReleaseByTag($owner:String!,$name:String!,$tagName:String!){repository(owner:$owner,name:$name){release(tagName:$tagName){databaseId,isDraft}}}';
  const lookup = await request('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name, tagName: tag } }),
  });
  if (lookup?.errors?.length) {
    throw new Error(`GitHub GraphQL release lookup failed: ${JSON.stringify(lookup.errors)}`);
  }
  const reference = lookup?.data?.repository?.release;
  const existing = reference?.databaseId
    ? await request(`/repos/${repo}/releases/${reference.databaseId}`)
    : null;
  if (!existing) {
    throw new Error(`Draft release ${tag} does not exist. Start the coordinated Release workflow.`);
  }
  if (!reference.isDraft || !existing.draft) {
    throw new Error(`Release ${tag} must remain a draft while assets are uploaded.`);
  }
  return existing;
}

const RETRYABLE_UPLOAD_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const UPLOAD_ATTEMPTS = 8;
const UPLOAD_BACKOFF_MS = [15_000, 45_000, 90_000, 180_000, 300_000];

export function releaseAssetContentType(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (ext === '.dmg') return 'application/x-apple-diskimage';
  if (ext === '.zip') return 'application/zip';
  if (ext === '.exe') return 'application/vnd.microsoft.portable-executable';
  if (ext === '.deb') return 'application/vnd.debian.binary-package';
  if (ext === '.gz') return 'application/gzip';
  if (ext === '.json') return 'application/json';
  if (ext === '.yml' || ext === '.yaml') return 'text/yaml';
  return 'application/octet-stream';
}

// GitHub's asset endpoint intermittently answers a large upload with
// `500 Error saving asset`, and a save that fails that way can leave a
// placeholder asset record behind. Every platform therefore uploads one asset
// at a time, drops any record that never reached `uploaded`, and retries the
// same asset before failing the release. Reuse requires both size and SHA-256;
// a rebuilt metadata file can have the same size but describe different bytes.
export async function uploadReleaseAssets({
  api,
  tag,
  assets,
  attempts = UPLOAD_ATTEMPTS,
  backoffMs = UPLOAD_BACKOFF_MS,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  for (const asset of assets) {
    await uploadOneAsset({ api, tag, asset, attempts, backoffMs, delay, log });
  }
}

async function uploadOneAsset({ api, tag, asset, attempts, backoffMs, delay, log }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if ((await settleStoredAsset({ api, tag, asset, log })) === 'already-uploaded') return;

    const result = await attemptUpload({ api, asset });
    if (result.ok) {
      log(`[release] uploaded ${asset.name}`);
      return;
    }
    if (!result.retryable || attempt === attempts) {
      throw new Error(
        `Failed to upload ${asset.name} after ${attempt} attempt(s): ${result.detail}`,
      );
    }

    const pause = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
    log(`[release] ${asset.name} ${result.detail}; retrying in ${Math.round(pause / 1000)}s`);
    await delay(pause);
  }
}

async function settleStoredAsset({ api, tag, asset, log }) {
  const stored = (await api.listAssets()).find((candidate) => candidate.name === asset.name);
  if (!stored) return 'absent';

  if (stored.state === 'uploaded') {
    if (stored.size === asset.size && /^sha256:[a-f\d]{64}$/.test(asset.digest ?? '') && stored.digest === asset.digest) {
      log(`[release] kept ${asset.name}, already uploaded`);
      return 'already-uploaded';
    }
    throw new Error(
      `Release ${tag} already contains ${asset.name} at ${stored.size} bytes but this build produced ` +
        `${asset.size} bytes with a different or unverified SHA-256. Versioned assets are immutable; delete the incomplete draft and restart ` +
        'the coordinated release.',
    );
  }

  log(`[release] discarding ${asset.name} left in state ${stored.state}`);
  await api.deleteAsset(stored.id);
  return 'discarded';
}

async function attemptUpload({ api, asset }) {
  try {
    const response = await api.putAsset(asset);
    if (response.ok) return { ok: true };
    return {
      ok: false,
      retryable: RETRYABLE_UPLOAD_STATUS.has(response.status),
      detail: `returned HTTP ${response.status} ${[response.statusText, response.body]
        .filter(Boolean)
        .join(' ')}`.trim(),
    };
  } catch (error) {
    return { ok: false, retryable: true, detail: `failed in transport: ${error.message}` };
  }
}
