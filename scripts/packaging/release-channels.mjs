import { releaseInstallers, DOWNLOAD_ORIGIN } from './download-mirror.mjs';

export const WEBSITE_PLATFORMS = { macos_arm64: 'mac-arm64.dmg', macos_x64: 'mac-x64.dmg', windows_x64: 'win-x64.exe', linux_amd64: 'linux-amd64.deb' };

export function checkUpdateMetadata(release, documents) {
  releaseInstallers(release);
  const version = release.tag_name.slice(1);
  const targets = { 'latest-mac.yml': ['mac-arm64.zip', 'mac-arm64.dmg', 'mac-x64.zip', 'mac-x64.dmg'],
    'latest.yml': ['win-x64.exe'], 'latest-linux.yml': ['linux-x86_64.AppImage', 'linux-amd64.deb'] };
  for (const [name, suffixes] of Object.entries(targets)) {
    const metadata = documents[name];
    if (metadata?.version !== version) throw new Error(`${name} has the wrong version`);
    for (const suffix of suffixes) {
      const assetName = `StashBase-${version}-${suffix}`;
      const file = metadata.files?.find(f => f.url === assetName);
      const asset = release.assets.find(a => a.name === assetName);
      if (!file || !asset || file.size !== asset.size || !/^[A-Za-z\d+/]{86}==$/.test(file.sha512 ?? '')) {
        throw new Error(`${name} does not match ${assetName}`);
      }
      if (/\.(zip|dmg|exe)$/.test(suffix) && !release.assets.some(a => a.name === `${assetName}.blockmap` && a.size > 0)) {
        throw new Error(`Missing blockmap for ${assetName}`);
      }
      if (suffix.endsWith('.AppImage') && !(file.blockMapSize > 0 && file.blockMapSize < file.size)) throw new Error('Missing embedded AppImage blockmap');
    }
    if (!metadata.files.some(file => file.url === metadata.path && file.sha512 === metadata.sha512)) throw new Error(`${name} legacy path/hash mismatch`);
  }
}

export function checkCdnManifest(release, manifest) {
  if (manifest.tag_name !== release.tag_name) throw new Error(`CDN is ${manifest.tag_name}, expected ${release.tag_name}`);
  const installers = releaseInstallers(release);
  // Only the verified installer destinations may be requested by the caller.
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== installers.length) throw new Error('CDN manifest has an unexpected asset set');
  for (const asset of installers) {
    const mirrored = manifest.assets?.find(a => a.name === asset.name);
    if (!mirrored || mirrored.size !== asset.size || mirrored.digest !== asset.digest ||
        mirrored.browser_download_url !== `${DOWNLOAD_ORIGIN}/${release.tag_name}/${asset.name}`) {
      throw new Error(`CDN manifest mismatch for ${asset.name}`);
    }
  }
}

export function checkCask(release, source) {
  const version = release.tag_name.slice(1);
  if (!source.includes(`version "${version}"`) ||
      !source.includes('url "https://github.com/liliu-z/stashbase/releases/download/v#{version}/StashBase-#{version}-mac-#{arch}.dmg"') ||
      !source.includes('arch arm: "arm64", intel: "x64"')) throw new Error('Homebrew version, architecture or URL mismatch');
  for (const [arch, label] of [['arm64', 'arm'], ['x64', 'intel']]) {
    const asset = releaseInstallers(release).find(a => a.name.endsWith(`mac-${arch}.dmg`));
    if (!source.includes(`${label}: "${asset.sha256}"`)) throw new Error(`Homebrew ${arch} checksum mismatch`);
  }
}

export function checkWebsiteLinks(release, links) {
  const version = release.tag_name.slice(1);
  for (const [platform, suffix] of Object.entries(WEBSITE_PLATFORMS)) {
    const matches = links.filter(link => link.platform === platform);
    const name = `StashBase-${version}-${suffix}`;
    const allowed = [`${DOWNLOAD_ORIGIN}/${release.tag_name}/${name}`, `https://github.com/liliu-z/stashbase/releases/download/${release.tag_name}/${name}`];
    if (!matches.length || matches.some(link => link.version !== release.tag_name || !allowed.includes(link.url))) {
      throw new Error(`Website ${platform} download button has not reached ${release.tag_name}`);
    }
  }
}

export function combinedState(channels) {
  const states = Object.values(channels).map(channel => channel.state);
  if (!states.length || states.includes('failure')) return 'failure';
  return states.every(state => state === 'success') ? 'success' : 'pending';
}
