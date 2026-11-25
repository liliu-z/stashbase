import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { advanceStore, STORE_APP, STORE_IDENTITY, STORE_PUBLISHER, storeStatus, updateStorePackages } from './store-submission.mjs';
import { createStoreClient, uploadStoreArchive, uploadTarget } from './store-client.mjs';

const packageFor = version => ({ fileName: `StashBase-${version}-store-x64.msix`, fileStatus: 'Uploaded', version: `${version}.0`, architecture: 'X64' });
function fixture() {
  const events = [];
  const app = { id: STORE_APP, packageIdentityName: STORE_IDENTITY, publisherName: STORE_PUBLISHER, lastPublishedApplicationSubmission: { id: '1' } };
  const submissions = { '1': { id: '1', status: 'Published', applicationPackages: [packageFor('2.19.1')],
    pricing: { priceId: 'Free' }, listings: { 'en-us': { baseListing: { description: 'Preserve me' } } }, notesForCertification: 'Existing instructions', hasExternalInAppProducts: true } };
  const api = {
    getApp: async () => structuredClone(app), getSubmission: async id => structuredClone(submissions[id]),
    createSubmission: async () => {
      events.push('create'); app.pendingApplicationSubmission = { id: '2' };
      submissions['2'] = { ...structuredClone(submissions['1']), id: '2', status: 'PendingCommit' };
      return structuredClone(submissions['2']);
    },
    updateSubmission: async (id, body) => { events.push('update'); Object.assign(submissions[id], body); submissions[id].fileUploadUrl = 'private-sas'; },
    commitSubmission: async id => { events.push('commit'); submissions[id].status = 'PreProcessing'; },
  };
  const options = { api, version: '2.19.2', receipt: { sourceRun: '100' },
    saveReceipt: async receipt => { events.push('receipt'); options.receipt = receipt; },
    preparePackage: async () => ({ fileName: packageFor('2.19.2').fileName, sha256: 'hash', zipPath: 'upload.zip' }),
    upload: async () => events.push('upload') };
  return { options, events, app, submissions };
}

test('submission records ownership before upload, preserves declarations, and tracks without recommitting', async () => {
  const f = fixture();
  assert.equal((await advanceStore(f.options)).state, 'pending');
  assert.deepEqual(f.events, ['create', 'receipt', 'update', 'upload', 'commit']);
  assert.equal(f.options.receipt.submissionId, '2');
  assert.equal(f.submissions['2'].listings['en-us'].baseListing.description, 'Preserve me');
  assert.equal(f.submissions['2'].hasExternalInAppProducts, true);
  assert.equal(f.submissions['2'].applicationPackages[0].fileStatus, 'PendingDelete');
  assert.equal(f.submissions['2'].applicationPackages[1].fileStatus, 'PendingUpload');
  f.events.length = 0;
  assert.equal((await advanceStore(f.options)).state, 'pending');
  assert.deepEqual(f.events, []);
  f.submissions['2'].status = 'Published';
  f.submissions['2'].applicationPackages = [packageFor('2.19.2')];
  f.app.lastPublishedApplicationSubmission = { id: '2' };
  delete f.app.pendingApplicationSubmission;
  assert.equal((await advanceStore(f.options)).state, 'success');
  assert.deepEqual(f.events, []);
});

test('lost upload resumes owned submission; changed bytes and unknown drafts are refused', async () => {
  const f = fixture();
  f.options.upload = async () => { throw new Error('network'); };
  await assert.rejects(advanceStore(f.options), /network/);
  f.events.length = 0;
  f.options.upload = async () => f.events.push('upload');
  f.options.receipt.packageSha256 = 'different';
  await assert.rejects(advanceStore(f.options), /differs/);
  assert.deepEqual(f.events, []);
  f.options.receipt.packageSha256 = 'hash';
  assert.equal((await advanceStore(f.options)).state, 'pending');
  assert.deepEqual(f.events, ['update', 'upload', 'commit']);
  f.submissions['2'].status = 'PendingCommit';
  f.options.receipt = { sourceRun: '100' };
  await assert.rejects(advanceStore(f.options), /Unowned Store draft/);
});

test('receipt failure leaves a recoverable draft without updating or committing', async () => {
  const f = fixture();
  f.options.saveReceipt = async () => { throw new Error('receipt unavailable'); };
  await assert.rejects(advanceStore(f.options), /receipt unavailable/);
  assert.deepEqual(f.events, ['create']);
  await assert.rejects(advanceStore(f.options), /Unowned Store draft/);
});

test('new releases wait for older certification, then submit the current version', async () => {
  const f = fixture();
  f.app.pendingApplicationSubmission = { id: '3' };
  f.submissions['3'] = { id: '3', status: 'Certification', applicationPackages: [packageFor('2.19.1')] };
  assert.match((await advanceStore(f.options)).detail, /waiting before submitting 2.19.2/);
  assert.deepEqual(f.events, []);
  delete f.app.pendingApplicationSubmission;
  assert.equal((await advanceStore(f.options)).state, 'pending');
  assert.equal(f.events.filter(e => e === 'create').length, 1);
});

test('first manual submission, rejection, identity mismatch and downgrades never trigger an upload', async () => {
  const f = fixture();
  f.options.version = '2.18.1';
  await assert.rejects(advanceStore(f.options), /not newer/);
  f.app.publisherName = 'unexpected';
  await assert.rejects(advanceStore(f.options), /identity/);
  f.app.publisherName = STORE_PUBLISHER;
  delete f.app.lastPublishedApplicationSubmission;
  assert.equal((await advanceStore(f.options)).state, 'pending');
  f.app.pendingApplicationSubmission = { id: '3' };
  f.submissions['3'] = { id: '3', status: 'CertificationFailed', statusDetails: { errors: [{ code: 'BadPackage' }] } };
  assert.equal((await advanceStore(f.options)).state, 'failure');
  assert.deepEqual(f.events, []);
});

test('only a matching published x64 package is success; new and failed states fail closed', () => {
  const sub = { id: '2', status: 'Published', applicationPackages: [packageFor('2.19.2')] };
  assert.equal(storeStatus(sub, '2.19.2', '1').state, 'failure');
  assert.equal(storeStatus(sub, '2.19.1', '2').state, 'failure');
  sub.applicationPackages[0].version = '2.19.2.7';
  assert.equal(storeStatus(sub, '2.19.2', '2').state, 'success');
  sub.applicationPackages[0].architecture = 'ARM';
  assert.equal(storeStatus(sub, '2.19.2', '2').state, 'failure');
  for (const status of ['MysteryState', 'CommitFailed', 'PreProcessingFailed', 'Canceled', 'ReleaseFailed', 'PublishFailed']) {
    assert.equal(storeStatus({ ...sub, status }, '2.19.2', '2').state, 'failure');
  }
  assert.throws(() => updateStorePackages({ status: 'PendingCommit', pricing: { priceId: 'Unknown' } }, 'file.msix'), /pricing/);
});

test('authentication and block upload never disclose credentials or a SAS in errors', async () => {
  const env = { MS_STORE_TENANT_ID: '1'.repeat(36), MS_STORE_CLIENT_ID: '2'.repeat(36), MS_STORE_CLIENT_SECRET: 'private-secret' };
  await assert.rejects(createStoreClient(env, async () => { throw new Error('private-secret'); }), error => !error.message.includes('private-secret'));
  for (const value of ['http://account.blob.core.windows.net/a?sig=secret', 'https://evil.test/a?sig=secret', 'https://account.blob.core.windows.net.evil.test/a?sig=secret']) {
    assert.throws(() => uploadTarget(value), /Invalid Store upload destination/);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'store-client-'));
  try {
    const file = path.join(root, 'upload.zip');
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 3));
    const calls = [];
    await uploadStoreArchive('https://account.blob.core.windows.net/a?sig=private-sas', file, async (url, options) => {
      calls.push({ comp: url.searchParams.get('comp'), body: options.body });
      return new Response(null, { status: 201 });
    });
    assert.deepEqual(calls.map(c => c.comp), ['block', 'block', 'blocklist']);
    assert.equal(calls[1].body.length, 3);
    assert.match(calls[2].body, /<Latest>MDAwMDAwMDE=<\/Latest>/);
    await assert.rejects(uploadStoreArchive('https://account.blob.core.windows.net/a?sig=private-sas', file, async () => {
      throw new Error('private-sas');
    }), error => !error.message.includes('private-sas'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
