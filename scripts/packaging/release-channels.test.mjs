import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import YAML from 'yaml';
import { checkUpdateMetadata, checkCdnManifest, checkCask, checkWebsiteLinks, combinedState, WEBSITE_PLATFORMS } from './release-channels.mjs';
import { macCaskContent } from './macos-cask.mjs';

function fixture() {
  const version = '2.19.2', tag = `v${version}`, sha = 'a'.repeat(64), hash512 = Buffer.alloc(64).toString('base64');
  const groups = { 'latest-mac.yml': ['mac-arm64.zip', 'mac-arm64.dmg', 'mac-x64.zip', 'mac-x64.dmg'], 'latest.yml': ['win-x64.exe'], 'latest-linux.yml': ['linux-x86_64.AppImage', 'linux-amd64.deb'] };
  const release = { tag_name: tag, draft: false, prerelease: false, assets: [] }, documents = {};
  for (const [name, suffixes] of Object.entries(groups)) {
    const files = suffixes.map(suffix => {
      const url = `StashBase-${version}-${suffix}`;
      release.assets.push({ name: url, size: 100, digest: `sha256:${sha}`, browser_download_url: `https://github.com/liliu-z/stashbase/releases/download/${tag}/${url}` });
      if (/\.(dmg|zip|exe)$/.test(suffix)) release.assets.push({ name: `${url}.blockmap`, size: 10 });
      return { url, size: 100, sha512: hash512, ...(suffix.endsWith('.AppImage') ? { blockMapSize: 10 } : {}) };
    });
    documents[name] = { version, files, path: files[0].url, sha512: hash512 };
  }
  const manifest = { tag_name: tag, assets: release.assets.filter(a => /\.(dmg|exe|deb|AppImage)$/.test(a.name)).map(a => ({ ...a, browser_download_url: `https://downloads.stashbase.ai/${tag}/${a.name}` })) };
  const links = Object.entries(WEBSITE_PLATFORMS).map(([platform, suffix]) => ({ platform, version: tag, url: `https://downloads.stashbase.ai/${tag}/StashBase-${version}-${suffix}` }));
  const cask = macCaskContent({ cask: 'stashbase', version, productName: 'StashBase', description: 'Writing', repo: 'liliu-z/stashbase', appId: 'com.stashbase.app', checksums: { arm64: sha, x64: sha } });
  return { release, documents, manifest, links, cask };
}
test('complete channels agree on one immutable version; a pending Store prevents global success', () => {
  const f = fixture();
  checkUpdateMetadata(f.release, f.documents); checkCdnManifest(f.release, f.manifest);
  checkCask(f.release, f.cask); checkWebsiteLinks(f.release, f.links);
  assert.equal(combinedState({ github: { state: 'success' }, store: { state: 'pending' } }), 'pending');
  assert.equal(combinedState({ github: { state: 'success' }, store: { state: 'failure' } }), 'failure');
  assert.equal(combinedState({ github: { state: 'success' }, store: { state: 'success' } }), 'success');
});
test('partial update sets, wrong hashes, stale links and architecture mismatch are rejected', () => {
  const f = fixture();
  f.release.assets = f.release.assets.filter(a => !a.name.endsWith('mac-x64.zip.blockmap'));
  assert.throws(() => checkUpdateMetadata(f.release, f.documents), /blockmap/);
  f.manifest.assets[0].digest = `sha256:${'b'.repeat(64)}`;
  assert.throws(() => checkCdnManifest(f.release, f.manifest), /mismatch/);
  assert.throws(() => checkCask(f.release, f.cask.replace('intel: "x64"', 'intel: "arm64"')), /mismatch/);
  f.links[0].url = f.links[0].url.replace('2.19.2', '2.19.1');
  assert.throws(() => checkWebsiteLinks(f.release, f.links), /download button/);
  const extra = fixture();
  extra.manifest.assets.push({ name: 'unrelated', browser_download_url: 'http://127.0.0.1/private' });
  assert.throws(() => checkCdnManifest(extra.release, extra.manifest), /unexpected asset set/);
});

test('publication and scheduled monitoring keep Store mutations serialized and audit failures visible', () => {
  const read = file => YAML.parse(fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
  const coordinator = read('.github/workflows/release.yml');
  const monitor = read('.github/workflows/release-channels.yml');
  const followup = coordinator.jobs['release-channels'];
  assert.ok(followup.needs.includes('publish-release'));
  assert.ok(followup.needs.includes('publish-downloads'));
  assert.ok(followup.needs.includes('publish-homebrew'));
  assert.match(followup.if, /always\(\).*publish-release.result == 'success'/);
  assert.equal(monitor.concurrency['cancel-in-progress'], false);
  assert.ok(monitor.on.schedule.length);
  assert.equal(monitor.on.pull_request, undefined);
  assert.equal(monitor.on.workflow_dispatch.inputs['check-only'].default, true);
  assert.equal(monitor.on.workflow_call.inputs['check-only'].default, false);
  const storeStep = monitor.jobs.store.steps.find(step => step.env?.CHECK_ONLY);
  assert.match(storeStep.run, /if \[\[ "\$CHECK_ONLY" == "true" \]\]; then\s+node scripts\/store-release\.mjs --tag "\$INPUT_TAG" --read-only\s+else/);
  assert.match(monitor.jobs.audit.if, /always\(\)/);
  assert.equal(monitor.jobs.audit.permissions.deployments, undefined);
  assert.equal(followup.permissions.deployments, 'write');
  assert.equal(followup.permissions.statuses, 'write');
});
