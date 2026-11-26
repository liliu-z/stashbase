import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export const DOWNLOAD_ORIGIN = 'https://downloads.stashbase.ai';
export const DOWNLOAD_BUCKET = 'stashbase-downloads';
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export function releaseInstallers(release) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error('Only a public stable release can be mirrored');
  }
  const version = release.tag_name.slice(1);
  const suffixes = ['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64.exe', 'linux-amd64.deb', 'linux-x86_64.AppImage'];
  return suffixes.map((suffix) => {
    const name = `StashBase-${version}-${suffix}`;
    const asset = release.assets?.find((item) => item.name === name);
    const source = `https://github.com/liliu-z/stashbase/releases/download/${release.tag_name}/${name}`;
    if (!asset || asset.browser_download_url !== source || !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
        !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) {
      throw new Error(`Missing or unverifiable official installer: ${name}`);
    }
    return { ...asset, key: `${release.tag_name}/${name}`, sha256: asset.digest.slice(7) };
  });
}

async function fileDigests(file) {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    md5.update(chunk);
  }
  return { sha256: sha256.digest('hex'), md5: md5.digest('hex'), size: (await stat(file)).size };
}

// One serialized workflow owns publication. Immutable files may be reused only
// when their stored digest and size match; the discoverable manifest moves last.
export async function mirrorRelease({ release, store, download, currentLatestTag, log = () => {} }) {
  const installers = releaseInstallers(release);
  for (const asset of installers) {
    const existing = await store.head(asset.key);
    if (existing) {
      if (existing.size !== asset.size || existing.sha256 !== asset.sha256) {
        throw new Error(`Immutable download conflict: ${asset.key}`);
      }
      log(`Kept ${asset.key}`);
      continue;
    }
    const file = await download(asset);
    const digest = await fileDigests(file);
    if (digest.size !== asset.size || digest.sha256 !== asset.sha256) {
      throw new Error(`GitHub download checksum mismatch: ${asset.name}`);
    }
    await store.putFile(asset, file, digest);
    log(`Uploaded ${asset.key}`);
  }
  const manifest = {
    tag_name: release.tag_name,
    published_at: release.published_at,
    assets: installers.map(({ name, key, size, digest }) => ({
      name, size, digest, browser_download_url: `${DOWNLOAD_ORIGIN}/${key}`,
    })),
  };
  // Retrying an old tag must not roll the website back to that release.
  if (await currentLatestTag() === release.tag_name) {
    await store.putManifest(manifest);
    log(`Published latest.json for ${release.tag_name}`);
  } else {
    log(`Mirrored ${release.tag_name} without changing latest.json`);
  }
  return manifest;
}
