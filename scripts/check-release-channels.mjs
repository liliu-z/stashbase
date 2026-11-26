import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { github, REPO, resolveRelease, saveReport } from './packaging/release-channel-io.mjs';
import { checkUpdateMetadata, checkCdnManifest, checkCask, checkWebsiteLinks, combinedState } from './packaging/release-channels.mjs';

const { values } = parseArgs({ options: { tag: { type: 'string' }, 'store-report': { type: 'string' },
  'skip-website': { type: 'boolean' }, 'write-status': { type: 'boolean' } } });
const { release, sha } = resolveRelease(values.tag);
const report = { tag: release.tag_name, checkedAt: new Date().toISOString(), channels: {} };
async function fetchChecked(url, options) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), ...options });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response;
}
async function check(name, operation) {
  try { report.channels[name] = { state: 'success', detail: await operation() }; }
  catch (error) { report.channels[name] = { state: 'failure', detail: error.code ? 'External command failed' : error.message }; }
}
await Promise.all([
  check('GitHub packages and updates', async () => {
    const documents = {};
    for (const name of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml']) {
      documents[name] = parse(await (await fetchChecked(`https://github.com/${REPO}/releases/download/${release.tag_name}/${name}`)).text());
    }
    checkUpdateMetadata(release, documents);
    return `${release.tag_name}; all platforms, update metadata and sidecars present`;
  }),
  check('Download CDN', async () => {
    const manifest = await (await fetchChecked('https://downloads.stashbase.ai/latest.json', { cache: 'no-store' })).json();
    checkCdnManifest(release, manifest);
    for (const asset of manifest.assets) {
      const response = await fetchChecked(asset.browser_download_url, { method: 'HEAD' });
      if (Number(response.headers.get('content-length')) !== asset.size) throw new Error(`CDN size mismatch for ${asset.name}`);
    }
    return `${manifest.tag_name}; installer hashes in manifest match GitHub; five public file sizes checked`;
  }),
  check('Homebrew', async () => {
    const content = github('repos/liliu-z/homebrew-stashbase/contents/Casks/stashbase.rb');
    checkCask(release, Buffer.from(content.content, 'base64').toString('utf8'));
    return `${release.tag_name}; arm64/x64 URLs and checksums match`;
  }),
  check('Website download buttons', async () => {
    if (values['skip-website']) return 'Skipped';
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      // No account, cookies, clipboard, analytics or user profile enters this check.
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        const allowed = ['stashbase.ai', 'downloads.stashbase.ai', 'api.github.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
        return url.protocol === 'https:' && allowed.includes(url.hostname) && route.request().method() === 'GET' ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      await page.goto('https://stashbase.ai/download/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForFunction(tag => ['macos_arm64', 'macos_x64', 'windows_x64', 'linux_amd64'].every(platform => {
        const links = [...document.querySelectorAll(`a[data-download-platform="${platform}"]`)]
          .filter(link => link.getAttribute('data-download-method') !== 'microsoft_store');
        return links.length && links.every(link => link.getAttribute('data-download-release') === tag);
      }), release.tag_name, { timeout: 30_000 });
      const links = await page.locator('a[data-download-platform]').evaluateAll(elements => elements.map(link => ({
        platform: link.getAttribute('data-download-platform'), version: link.getAttribute('data-download-release'),
        method: link.getAttribute('data-download-method'), url: link.href,
      })));
      checkWebsiteLinks(release, links);
      return `${release.tag_name}; all four installer platforms and any Store listing links verified in a fresh browser`;
    } finally { await browser.close(); }
  }),
]);
if (values['skip-website']) report.channels['Website download buttons'] = { state: 'pending', detail: 'Browser verification skipped; not a complete channel pass' };
try {
  const store = JSON.parse(readFileSync(values['store-report'] || 'release.nosync/channel-status/store.json', 'utf8'));
  if (store.tag !== report.tag) throw new Error('Store report belongs to another version');
  if (Date.now() - Date.parse(store.checkedAt) > 60 * 60_000 || !Number.isFinite(Date.parse(store.checkedAt))) throw new Error('Store report is stale');
  report.channels['Microsoft Store'] = store.channels['Microsoft Store'];
  if (!report.channels['Microsoft Store']) throw new Error('Store report is incomplete');
} catch (error) { report.channels['Microsoft Store'] = { state: 'failure', detail: error.code ? 'Store report missing; run the Store tracking job' : error.message }; }
// A newer release may have published while a slow audit was running. Never write
// success onto an old commit based on moving latest endpoints.
if (github(`repos/${REPO}/releases/latest`).tag_name !== report.tag) {
  report.channels['Current stable release'] = { state: 'pending', detail: 'Stable version changed during this check; audit the new release' };
}
report.state = combinedState(report.channels);
saveReport('release.nosync/channel-status/channels.json', report);
if (values['write-status']) github(`repos/${REPO}/statuses/${sha}`, { context: 'release/all-channels', state: report.state,
  description: report.state === 'success' ? 'All release channels verified' : 'Release channels incomplete; see the workflow summary',
  target_url: `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` });
if (report.state === 'failure') process.exitCode = 1;
