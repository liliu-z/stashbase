import { open, stat } from 'node:fs/promises';
import { STORE_APP } from './store-submission.mjs';

export const STORE_CREDENTIALS = ['MS_STORE_TENANT_ID', 'MS_STORE_CLIENT_ID', 'MS_STORE_CLIENT_SECRET'];

async function request(fetchImpl, url, options, label) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120_000), ...options });
  } catch {
    throw new Error(`${label}: request failed or timed out`); // URL may contain a SAS.
  }
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return response;
}

export async function createStoreClient(env = process.env, fetchImpl = fetch) {
  for (const name of STORE_CREDENTIALS) if (!env[name]) throw new Error(`Missing ${name}`);
  for (const name of STORE_CREDENTIALS.slice(0, 2)) {
    if (!/^[a-f\d-]{36}$/i.test(env[name])) throw new Error(`Invalid ${name}`);
  }
  const response = await request(fetchImpl, `https://login.microsoftonline.com/${env.MS_STORE_TENANT_ID}/oauth2/token`, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials',
      client_id: env.MS_STORE_CLIENT_ID, client_secret: env.MS_STORE_CLIENT_SECRET,
      resource: 'https://manage.devcenter.microsoft.com' }),
  }, 'Microsoft authentication');
  let credentials;
  try { credentials = await response.json(); } catch { throw new Error('Microsoft authentication returned invalid JSON'); }
  const { access_token: token } = credentials;
  if (!token) throw new Error('Microsoft authentication returned no access token');
  const base = `https://manage.devcenter.microsoft.com/v1.0/my/applications/${STORE_APP}`;
  const call = async (suffix = '', method = 'GET', data) => {
    const result = await request(fetchImpl, `${base}${suffix}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    }, `Store ${method}`);
    const text = await result.text();
    try { return text ? JSON.parse(text) : null; } catch { throw new Error('Store API returned invalid JSON'); }
  };
  const idPath = id => {
    if (!/^\d+$/.test(id)) throw new Error('Invalid Store submission ID');
    return `/submissions/${id}`;
  };
  return {
    getApp: () => call(), getSubmission: id => call(idPath(id)),
    createSubmission: () => call('/submissions', 'POST'),
    updateSubmission: (id, data) => call(idPath(id), 'PUT', data),
    commitSubmission: id => call(`${idPath(id)}/commit`, 'POST'),
  };
}

export function uploadTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Store upload destination'); }
  if (url.protocol !== 'https:' || !/^[a-z\d]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
      url.username || url.password || url.port || !url.searchParams.has('sig')) throw new Error('Invalid Store upload destination');
  return url;
}

// Block uploads work with the older SAS API versions returned by Partner Center;
// a single 400 MB Put Blob exceeds the older API's single-request size limit.
export async function uploadStoreArchive(sas, file, fetchImpl = fetch) {
  const target = uploadTarget(sas);
  const handle = await open(file, 'r');
  const ids = [];
  try {
    const size = (await stat(file)).size;
    for (let offset = 0; offset < size; offset += 4 * 1024 * 1024) {
      const chunk = Buffer.alloc(Math.min(4 * 1024 * 1024, size - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead !== chunk.length) throw new Error('Store archive changed during upload');
      const id = Buffer.from(String(ids.length).padStart(8, '0')).toString('base64');
      const url = new URL(target);
      url.searchParams.set('comp', 'block'); url.searchParams.set('blockid', id);
      await request(fetchImpl, url, { method: 'PUT', body: chunk }, 'Store package block upload');
      ids.push(id);
    }
    if (!ids.length) throw new Error('Empty Store archive');
    const url = new URL(target); url.searchParams.set('comp', 'blocklist');
    await request(fetchImpl, url, { method: 'PUT', headers: { 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map(id => `<Latest>${id}</Latest>`).join('')}</BlockList>` }, 'Store package block commit');
  } finally { await handle.close(); }
}
