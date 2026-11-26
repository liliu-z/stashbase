import { storeVersion } from './windows-store.mjs';

export const STORE_APP = '9N1Z6TB2H2P5';
export const STORE_IDENTITY = 'StashBase.StashBase';
export const STORE_PUBLISHER = 'CN=7009CBF4-3C51-44A5-943B-4BA69A1EA67B';
export const STORE_OVERVIEW = `https://partner.microsoft.com/dashboard/products/${STORE_APP}/overview`;
const ACTIVE = new Set(['CommitStarted', 'PreProcessing', 'Certification', 'Release', 'PendingPublication', 'Publishing']);
const FAILED = new Set(['Canceled', 'CommitFailed', 'PreProcessingFailed', 'CertificationFailed', 'ReleaseFailed', 'PublishFailed']);

export function verifyStoreRun(run, { repository, tag, sha }) {
  // workflow_run and a dispatch from main describe the workflow ref, while the
  // Windows adapter explicitly checks out the release tag. The artifact records
  // that checkout separately; only trusted main/tag workflow definitions may supply it.
  const trustedRef = run.head_branch === 'main' || (run.head_branch === tag && run.head_sha === sha);
  if (!trustedRef || run.head_repository?.full_name !== repository ||
      !['workflow_run', 'workflow_dispatch'].includes(run.event) ||
      !['.github/workflows/release.yml', '.github/workflows/build-msix.yml'].includes(run.path) ||
      !['in_progress', 'completed'].includes(run.status)) {
    throw new Error('MSIX artifact source does not match the tagged commit and approved workflow');
  }
}

export function verifyStorePackageSource(source, expected) {
  for (const key of ['tag', 'sha', 'sourceRun', 'packageSha256']) {
    if (typeof expected[key] !== 'string' || !expected[key] || source?.[key] !== expected[key]) {
      throw new Error(`MSIX artifact provenance mismatch: ${key}`);
    }
  }
}

function packageVersions(submission) {
  return (submission?.applicationPackages ?? []).filter(p => p.fileStatus !== 'PendingDelete').map(p => p.version).filter(Boolean);
}

function hasStoreVersion(submission, version) {
  storeVersion(version);
  return (submission?.applicationPackages ?? []).some(p => p.fileStatus === 'Uploaded' &&
    String(p.architecture).toLowerCase() === 'x64' && p.version?.split('.').slice(0, 3).join('.') === version);
}

export function storeStatus(submission, version, publishedId) {
  const status = submission.status;
  const codes = (submission.statusDetails?.errors ?? []).map(e => String(e.code ?? '').replace(/[^\w.-]/g, '').slice(0, 100)).filter(Boolean);
  const detail = `Submission ${submission.id}: ${status}${codes.length ? ` (${codes.join(', ')})` : ''}`;
  if (status === 'Published') {
    return { state: hasStoreVersion(submission, version) && submission.id === publishedId ? 'success' : 'failure',
      detail: `${detail}; package versions: ${packageVersions(submission).join(', ') || 'unknown'}` };
  }
  if (FAILED.has(status)) return { state: 'failure', detail };
  if (ACTIVE.has(status) || status === 'PendingCommit') return { state: 'pending', detail };
  return { state: 'failure', detail: `${detail}; unrecognized Store status` };
}

export function updateStorePackages(submission, fileName) {
  if (submission.status !== 'PendingCommit') throw new Error('Only an owned PendingCommit submission can be edited');
  const data = structuredClone(submission);
  // Retain the last published listing, legal declarations, pricing and rollout choices.
  // Pricing Version 2 cannot be round-tripped by this API. Refuse instead of guessing
  // at an omitted field's PUT semantics or changing a price behind the operator's back.
  if (/unknown/i.test(String(data.pricing?.priceId))) throw new Error('Store pricing is not supported by this API; complete this submission in Partner Center');
  data.applicationPackages = (data.applicationPackages ?? []).filter(p => p.fileName !== fileName)
    .map(p => ({ ...p, fileStatus: 'PendingDelete' }));
  data.applicationPackages.push({ fileName, fileStatus: 'PendingUpload', minimumDirectXVersion: 'None', minimumSystemRam: 'None' });
  data.targetPublishMode = 'Immediate';
  delete data.targetPublishDate;
  for (const key of ['id', 'status', 'statusDetails', 'fileUploadUrl', 'friendlyName']) delete data[key];
  return data;
}

// A receipt is persisted BEFORE editing or uploading. A lost create response leaves
// an unowned draft: stop and ask the operator to inspect it, never adopt/delete it.
// This owner never cancels certification and never overwrites another submission.
export async function advanceStore({ api, version, receipt, saveReceipt, preparePackage, upload }) {
  storeVersion(version);
  const app = await api.getApp();
  if (app.id !== STORE_APP || app.packageIdentityName !== STORE_IDENTITY || app.publisherName !== STORE_PUBLISHER) {
    throw new Error('Partner Center application identity does not match StashBase');
  }
  const publishedId = app.lastPublishedApplicationSubmission?.id;
  const published = publishedId ? await api.getSubmission(publishedId) : null;
  if (published && hasStoreVersion(published, version)) return storeStatus(published, version, publishedId);
  const pendingId = app.pendingApplicationSubmission?.id;
  let submission = receipt?.submissionId ? await api.getSubmission(receipt.submissionId) :
    pendingId ? await api.getSubmission(pendingId) : null;
  if (submission && submission.status !== 'PendingCommit') {
    const result = storeStatus(submission, version, publishedId);
    // An older submission holds the only Store slot; the scheduled run retries the
    // latest release when it finishes. Terminal rejection remains a visible failure.
    if (submission.id !== receipt?.submissionId && ACTIVE.has(submission.status)) {
      return { state: 'pending', detail: `${result.detail}; waiting before submitting ${version}` };
    }
    return result;
  }
  if (pendingId && pendingId !== receipt?.submissionId) {
    throw new Error(`Unowned Store draft ${pendingId}; finish it in Partner Center before retrying`);
  }
  if (!published) return { state: 'pending', detail: 'Waiting for the first manual Store publication' };
  const target = version.split('.').map(Number);
  if (packageVersions(published).some(v => {
    const parts = v.split('.').map(Number);
    const different = target.findIndex((n, i) => n !== parts[i]);
    return different < 0 || target[different] < parts[different];
  })) throw new Error('Refusing a Store package version that is not newer than the published version');
  if (submission && submission.id !== pendingId) throw new Error('Owned draft is no longer the pending Store submission');
  const pkg = await preparePackage();
  if (receipt?.packageSha256 && receipt.packageSha256 !== pkg.sha256) throw new Error('Store retry package differs from the recorded immutable package');
  if (!submission) {
    submission = await api.createSubmission();
    if (!/^\d+$/.test(submission.id ?? '')) throw new Error('Store did not return a submission ID');
    await saveReceipt({ ...receipt, submissionId: submission.id, packageSha256: pkg.sha256 });
  }
  await api.updateSubmission(submission.id, updateStorePackages(submission, pkg.fileName));
  // Refresh the SAS on retries. Neither the SAS nor full submission JSON is logged.
  const updated = await api.getSubmission(submission.id);
  await upload(updated.fileUploadUrl, pkg.zipPath);
  await api.commitSubmission(submission.id);
  const result = await api.getSubmission(submission.id);
  const currentPublishedId = result.status === 'Published' ? (await api.getApp()).lastPublishedApplicationSubmission?.id : publishedId;
  return storeStatus(result, version, currentPublishedId);
}
