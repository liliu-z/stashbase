import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { requireGreenCi } from './require-green-ci.mjs';
import { advanceStore, STORE_APP, STORE_OVERVIEW, storeStatus } from './packaging/store-submission.mjs';
import { createStoreClient, STORE_CREDENTIALS, uploadStoreArchive } from './packaging/store-client.mjs';
import { github, REPO, resolveRelease, saveReport } from './packaging/release-channel-io.mjs';

const { values } = parseArgs({ options: { tag: { type: 'string' }, 'source-run': { type: 'string' }, 'read-only': { type: 'boolean' } } });
const report = { tag: values.tag || 'latest', checkedAt: new Date().toISOString(), channels: {} };
const readOnly = values['read-only'];
let temporary;
let deployment;
let sha;
try {
  const resolved = resolveRelease(values.tag);
  sha = resolved.sha;
  const { release, version } = resolved;
  report.tag = release.tag_name;
  const records = github(`repos/${REPO}/deployments?environment=microsoft-store&sha=${sha}&per_page=100`);
  deployment = records.find(d => d.payload?.owner === 'stashbase-store-v1' && d.payload?.tag === report.tag);
  let receipt = deployment?.payload;
  const verifyRun = runId => {
    const run = github(`repos/${REPO}/actions/runs/${runId}`);
    if (run.head_sha !== sha || run.head_repository?.full_name !== REPO ||
        !['.github/workflows/release.yml', '.github/workflows/build-msix.yml'].includes(run.path) ||
        !['in_progress', 'completed'].includes(run.status)) {
      throw new Error('MSIX artifact source does not match the tagged commit and approved workflow');
    }
  };
  const saveReceipt = async data => {
    deployment = github(`repos/${REPO}/deployments`, { ref: report.tag, environment: 'microsoft-store',
      auto_merge: false, required_contexts: [], production_environment: true,
      description: `Microsoft Store ${report.tag}`, payload: { ...data, owner: 'stashbase-store-v1', tag: report.tag, sha } });
    receipt = deployment.payload;
  };
  if (values['source-run'] && !/^\d+$/.test(values['source-run'])) throw new Error('Invalid source run ID');
  if (receipt && values['source-run'] && receipt.sourceRun !== values['source-run']) {
    throw new Error('Retry must use the original artifact run recorded for this release');
  }
  if (!readOnly && !receipt && values['source-run']) {
    verifyRun(values['source-run']);
    await saveReceipt({ sourceRun: values['source-run'] });
  }
  const missing = STORE_CREDENTIALS.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Store automation is not configured: ${missing.join(', ')}`);
  const api = await createStoreClient();
  if (readOnly) {
    const app = await api.getApp();
    const publishedId = app.lastPublishedApplicationSubmission?.id;
    const id = app.pendingApplicationSubmission?.id || publishedId;
    report.channels['Microsoft Store'] = id ? storeStatus(await api.getSubmission(id), version, publishedId) :
      { state: 'pending', detail: 'No Store submission exists' };
  } else if (github(`repos/${REPO}/releases/latest`).tag_name !== report.tag) {
    report.channels['Microsoft Store'] = { state: 'pending', detail: 'Superseded by a newer stable release; no Store mutation' };
  } else {
    report.channels['Microsoft Store'] = await advanceStore({ api, version, receipt,
      saveReceipt,
      upload: uploadStoreArchive,
      preparePackage: async () => {
        if (!receipt?.sourceRun) throw new Error('No artifact receipt; dispatch with the original successful Release source-run ID');
        verifyRun(receipt.sourceRun);
        await requireGreenCi(report.tag, { repository: REPO, request: async route => github(route), timeoutMs: 0 });
        const artifacts = github(`repos/${REPO}/actions/runs/${receipt.sourceRun}/artifacts?per_page=100`).artifacts;
        const artifact = artifacts.find(a => a.name === 'store-msix-package' && !a.expired);
        if (!artifact) throw new Error('MSIX artifact is missing or expired; build a new version or use the documented recovery');
        mkdirSync('release.nosync', { recursive: true });
        temporary = mkdtempSync(path.join('release.nosync/', 'store-upload-'));
        execFileSync('gh', ['run', 'download', receipt.sourceRun, '--repo', REPO, '--name', 'store-msix-package', '--dir', temporary], { stdio: 'pipe' });
        const fileName = `StashBase-${version}-store-x64.msix`;
        // Python's standard ZIP/XML implementations validate the actual embedded
        // manifest and produce the upload ZIP without extracting the MSIX payload.
        const result = execFileSync('python3', ['-', temporary, fileName, `${version}.0`], { encoding: 'utf8', input: `
import hashlib, json, pathlib, re, sys, zipfile
from xml.etree import ElementTree
root, name, version = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
file = root / name
if file.is_symlink() or not file.is_file(): raise ValueError('Missing regular MSIX file')
digest = hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
checksum = (root / (name + '.sha256')).read_text().strip()
if not re.fullmatch(r'[a-fA-F0-9]{64}\\s+\\*?' + re.escape(name), checksum) or checksum[:64].lower() != digest:
    raise ValueError('MSIX SHA-256 mismatch')
with zipfile.ZipFile(file) as msix:
    entry = msix.getinfo('AppxManifest.xml')
    if entry.file_size > 1048576: raise ValueError('Oversized manifest')
    manifest = ElementTree.fromstring(msix.read(entry))
identity = manifest.find('{http://schemas.microsoft.com/appx/manifest/foundation/windows10}Identity')
expected = {'Name': 'StashBase.StashBase', 'Publisher': 'CN=7009CBF4-3C51-44A5-943B-4BA69A1EA67B', 'Version': version, 'ProcessorArchitecture': 'x64'}
if identity is None or any(identity.get(k) != v for k, v in expected.items()): raise ValueError('MSIX identity/version mismatch')
archive = root / 'store-upload.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as output: output.write(file, name)
print(json.dumps({'fileName': name, 'sha256': digest, 'zipPath': str(archive)}))
` });
        return JSON.parse(result);
      },
    });
  }
} catch (error) {
  report.channels['Microsoft Store'] = { state: 'failure', detail: error.code ? 'External command failed; inspect the artifact/configuration and retry' : error.message };
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
const status = report.channels['Microsoft Store'];
report.partnerCenter = STORE_OVERVIEW;
report.appId = STORE_APP;
saveReport('release.nosync/channel-status/store.json', report);
if (!readOnly && sha) {
  github(`repos/${REPO}/statuses/${sha}`, { context: 'release/microsoft-store', state: status.state,
    description: status.detail.slice(0, 140), target_url: STORE_OVERVIEW });
  if (deployment) github(`repos/${REPO}/deployments/${deployment.id}/statuses`, {
    state: status.state === 'pending' ? 'in_progress' : status.state,
    description: status.detail.slice(0, 140), environment_url: STORE_OVERVIEW, auto_inactive: false,
  });
}
if (status.state === 'failure') process.exitCode = 1;
