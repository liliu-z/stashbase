import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release.nosync');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const productName = pkg.build?.productName || pkg.name;

function argValue(name) {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  return null;
}

function findPackagedApp() {
  const explicit = argValue('--app');
  if (explicit) return path.resolve(explicit);

  const candidates = packagedAppCandidates();
  const hit = candidates.find((candidate) => fs.existsSync(candidate));
  if (hit) return hit;

  throw new Error(
    `No packaged ${productName} app found. Run the matching \`pnpm dist:*\` command or pass --app=/path/to/app.`,
  );
}

function packagedAppCandidates() {
  if (process.platform === 'darwin') {
    return [
      path.join(releaseDir, 'mac-arm64', `${productName}.app`),
      path.join(releaseDir, 'mac', `${productName}.app`),
    ];
  }
  if (process.platform === 'win32') {
    return [
      path.join(releaseDir, 'win-unpacked'),
      path.join(releaseDir, 'win-ia32-unpacked'),
      path.join(releaseDir, 'win-arm64-unpacked'),
    ];
  }
  if (process.platform === 'linux') {
    return [
      path.join(releaseDir, 'linux-unpacked'),
    ];
  }
  throw new Error(`Unsupported packaged smoke platform: ${process.platform}`);
}

function packagedLayout(appPath) {
  if (process.platform === 'darwin') {
    const resourcesPath = path.join(appPath, 'Contents', 'Resources');
    return {
      appRoot: path.join(resourcesPath, 'app.asar'),
      electronBin: path.join(appPath, 'Contents', 'MacOS', productName),
      resourcesPath,
      ripgrepPackage: `ripgrep-darwin-${process.arch}`,
      ripgrepBinary: 'rg',
    };
  }
  if (process.platform === 'win32') {
    const resourcesPath = path.join(appPath, 'resources');
    return {
      appRoot: path.join(resourcesPath, 'app.asar'),
      electronBin: path.join(appPath, `${productName}.exe`),
      resourcesPath,
      ripgrepPackage: `ripgrep-win32-${process.arch}`,
      ripgrepBinary: 'rg.exe',
    };
  }
  const resourcesPath = path.join(appPath, 'resources');
  return {
    appRoot: path.join(resourcesPath, 'app.asar'),
    electronBin: findLinuxElectronBin(appPath),
    resourcesPath,
    ripgrepPackage: `ripgrep-linux-${process.arch}`,
    ripgrepBinary: 'rg',
  };
}

function findLinuxElectronBin(appPath) {
  const candidates = [
    path.join(appPath, productName),
    path.join(appPath, pkg.name),
    path.join(appPath, String(productName).toLowerCase()),
    path.join(appPath, String(pkg.name).toLowerCase()),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function requestJson(port, requestPath, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    const body = options.body == null ? undefined : JSON.stringify(options.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: options.method ?? 'GET',
        timeout: timeoutMs,
        headers: {
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 8192) body += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ ok: true, statusCode: res.statusCode ?? 0, body: JSON.parse(body) });
          } catch {
            resolve({ ok: true, statusCode: res.statusCode ?? 0, body: null });
          }
        });
      },
    );
    req.on('error', () => resolve({ ok: false, statusCode: 0, body: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, body: null });
    });
    if (body) req.write(body);
    req.end();
  });
}

function requestText(port, requestPath, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: options.method ?? 'GET',
        timeout: timeoutMs,
        headers: options.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({
          ok: true,
          statusCode: res.statusCode ?? 0,
          body,
        }));
      },
    );
    req.on('error', () => resolve({ ok: false, statusCode: 0, body: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, body: '' });
    });
    req.end();
  });
}

function requestBytes(port, requestPath, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: options.method ?? 'GET',
        timeout: timeoutMs,
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          ok: true,
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      },
    );
    req.on('error', () => resolve({ ok: false, statusCode: 0, headers: {}, body: Buffer.alloc(0) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, headers: {}, body: Buffer.alloc(0) });
    });
    req.end();
  });
}

async function requestOk(port, timeoutMs) {
  const res = await requestJson(port, '/api/folder', timeoutMs);
  return res.ok && res.statusCode >= 200 && res.statusCode < 500;
}

async function requestApi(port, method, requestPath, body) {
  const res = await requestJson(port, requestPath, 5_000, {
    method,
    body,
    headers: { 'x-stashbase-window-id': 'packaged-smoke' },
  });
  if (!res.ok || res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`${method} ${requestPath} failed: status=${res.statusCode} body=${JSON.stringify(res.body)}`);
  }
  return res.body;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sidecarCandidates(root, name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const base = path.join(root, 'python', 'sidecar');
  return [
    path.join(base, name, exe),
    path.join(base, exe),
  ];
}

function findSidecarExecutable(root, name) {
  return sidecarCandidates(root, name).find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) ?? sidecarCandidates(root, name)[0];
}

async function waitForServer(port, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    if (await requestOk(port, 250)) return;
    await sleep(150);
  }

  const tail = output.join('').slice(-8_000);
  throw new Error(`Packaged server did not respond on :${port} within 10s.\n${tail}`);
}

function assertFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${label}: ${file}`);
}

async function assertPackagedHealth(port, expected) {
  const res = await requestJson(port, '/api/health', 1000);
  if (!res.ok || res.statusCode !== 200 || !res.body || typeof res.body !== 'object') {
    throw new Error(`packaged health probe failed: status=${res.statusCode}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (res.body[key] !== value) {
      throw new Error(
        `packaged health ${key} mismatch:\n` +
          `  expected: ${value}\n` +
          `  actual: ${res.body[key]}`,
      );
    }
  }
}

async function assertPackagedRendererWorkers(port) {
  const page = await requestText(port, '/', 5_000);
  const entryPath = page.body.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  if (!page.ok || page.statusCode !== 200 || !entryPath) {
    throw new Error(`packaged renderer entry is unavailable: status=${page.statusCode}`);
  }
  const entry = await requestText(port, entryPath, 5_000);
  if (!entry.ok || entry.statusCode !== 200) {
    throw new Error(`packaged renderer entry is unavailable: status=${entry.statusCode}`);
  }

  let workerName = entry.body.match(/\bdocxPreview\.worker-[A-Za-z0-9_-]+\.js\b/)?.[0];
  if (!workerName) {
    const docxChunkName = entry.body.match(/\bDocxPreview-[A-Za-z0-9_-]+\.js\b/)?.[0];
    if (!docxChunkName) {
      throw new Error('packaged renderer does not reference the DOCX preview chunk');
    }
    const docxChunk = await requestText(port, `/assets/${docxChunkName}`, 5_000);
    workerName = docxChunk.body.match(/\bdocxPreview\.worker-[A-Za-z0-9_-]+\.js\b/)?.[0];
    if (!docxChunk.ok || docxChunk.statusCode !== 200 || !workerName) {
      throw new Error(`packaged DOCX preview chunk does not reference its worker: status=${docxChunk.statusCode}`);
    }
  }
  const worker = await requestText(port, `/assets/${workerName}`, 5_000);
  if (!worker.ok || worker.statusCode !== 200 || !/convertToHtml/.test(worker.body)) {
    throw new Error(`packaged DOCX renderer worker is unavailable: status=${worker.statusCode}`);
  }
  console.log('[smoke] packaged renderer serves the DOCX worker asset from app.asar');
}

async function assertPackagedUserFlow(port, home, options = {}) {
  const folderRoot = path.join(home, 'User Yuan Li', 'Documents', 'StashBase Demo');
  fs.mkdirSync(path.join(folderRoot, '项目 A', '子目录'), { recursive: true });
  fs.writeFileSync(path.join(folderRoot, 'README Windows.md'), '# Hello Windows\n\nkeyword-one body\n', 'utf8');
  fs.writeFileSync(path.join(folderRoot, '项目 A', '测试 file.md'), '# Nested Note\n\nkeyword-two nested\n', 'utf8');
  fs.writeFileSync(path.join(folderRoot, 'page with space.html'), '<h1>HTML Test</h1> keyword-one', 'utf8');
  fs.writeFileSync(path.join(folderRoot, '项目 A', '子目录', 'deep.md'), '# Deep\n\nkeyword-three\n', 'utf8');
  writeDocxFixture(path.join(folderRoot, 'report smoke.docx'));
  if (options.requireTranscription) writeWavFixture(path.join(folderRoot, 'transcription smoke.wav'));

  const opened = await requestApi(port, 'POST', '/api/folder', { path: folderRoot });
  if (opened?.current?.name !== 'StashBase Demo') {
    throw new Error(`open folder returned unexpected payload: ${JSON.stringify(opened)}`);
  }

  const listing = await requestApi(port, 'GET', '/api/files');
  const files = (listing?.files ?? []).map((file) => file.name).sort();
  const folders = (listing?.folders ?? []).map((folder) => folder.path).sort();
  const expectedFiles = ['README Windows.md', 'page with space.html', 'report smoke.docx', '项目 A/测试 file.md', '项目 A/子目录/deep.md'];
  if (options.requireTranscription) expectedFiles.push('transcription smoke.wav');
  for (const expected of expectedFiles) {
    if (!files.includes(expected)) throw new Error(`file listing missing ${expected}: ${JSON.stringify(listing)}`);
  }
  for (const expected of ['项目 A', '项目 A/子目录']) {
    if (!folders.includes(expected)) throw new Error(`folder listing missing ${expected}: ${JSON.stringify(listing)}`);
  }

  const nested = await requestApi(port, 'GET', `/api/files/${encodePath('项目 A/测试 file.md')}`);
  if (!/Nested Note/.test(nested?.content ?? '')) throw new Error(`nested file read failed: ${JSON.stringify(nested)}`);

  const html = await requestApi(port, 'GET', `/api/files/${encodePath('page with space.html')}`);
  if (html?.format !== 'html') throw new Error(`HTML file read failed: ${JSON.stringify(html)}`);

  await requestApi(port, 'POST', '/api/files/prepare', { path: 'report smoke.docx' });
  const derivedUrl = `/asset-derived/__window/packaged-smoke/${encodePath('report smoke.docx')}`;
  const docxDeadline = Date.now() + 20_000;
  let docxPreview = null;
  while (Date.now() < docxDeadline) {
    docxPreview = await requestText(port, derivedUrl, 2_000);
    if (docxPreview.ok && docxPreview.statusCode === 200) break;
    if (docxPreview.statusCode !== 409) {
      throw new Error(`packaged DOCX preview failed: status=${docxPreview.statusCode} body=${docxPreview.body.slice(0, 1_000)}`);
    }
    await sleep(100);
  }
  if (!docxPreview?.ok || docxPreview.statusCode !== 200) {
    const conversionStatus = await requestApi(port, 'GET', '/api/index-status');
    throw new Error(`packaged DOCX conversion did not finish: ${JSON.stringify(conversionStatus)}`);
  }
  if (!/Hello StashBase DOCX smoke/.test(docxPreview.body)) {
    throw new Error(`packaged DOCX preview lost fixture content: ${docxPreview.body.slice(0, 1_000)}`);
  }
  if (!/stashbase-docx-conversion: complete/.test(docxPreview.body)) {
    throw new Error('packaged DOCX preview is missing the durable completion marker');
  }
  if (/\son[a-z]+\s*=/i.test(docxPreview.body)) {
    throw new Error('packaged DOCX preview contains an inline event handler');
  }
  console.log('[smoke] packaged DOCX worker converted a fixture from app.asar');

  if (options.requireTranscription) {
    await assertPackagedTranscriptionFlow(port);
  }

  await requestApi(port, 'POST', '/api/folders', { path: 'New Folder' });
  const created = await requestApi(port, 'POST', '/api/files', {
    name: 'draft windows',
    dir: 'New Folder',
    content: '# Draft\n\nkeyword-four',
  });
  if (created?.name !== 'New Folder/draft windows.md') {
    throw new Error(`create note returned unexpected name: ${JSON.stringify(created)}`);
  }

  const renamed = await requestApi(port, 'PATCH', `/api/files/${encodePath(created.name)}`, {
    new_name: 'renamed windows.md',
    cascade: false,
    async_index: true,
  });
  if (renamed?.name !== 'New Folder/renamed windows.md') {
    throw new Error(`basename rename did not preserve parent folder: ${JSON.stringify(renamed)}`);
  }

  const moved = await requestApi(port, 'PATCH', `/api/files/${encodePath(renamed.name)}`, {
    new_name: '项目 A/moved windows.md',
    cascade: false,
    async_index: true,
  });
  if (moved?.name !== '项目 A/moved windows.md') {
    throw new Error(`full-path move returned unexpected name: ${JSON.stringify(moved)}`);
  }

  const movedBody = await requestApi(port, 'GET', `/api/files/${encodePath('项目 A/moved windows.md')}`);
  if (!/keyword-four/.test(movedBody?.content ?? '')) throw new Error(`moved file read failed: ${JSON.stringify(movedBody)}`);

  const keyword = await requestApi(port, 'GET', '/api/keyword-search?q=keyword-one');
  if ((keyword?.totalMatches ?? 0) < 2) throw new Error(`keyword search missed fixture content: ${JSON.stringify(keyword)}`);

  const status = await requestApi(port, 'GET', '/api/index-status');
  if (typeof status?.treeVersion !== 'number') throw new Error(`index status missing treeVersion: ${JSON.stringify(status)}`);

  const sync = await requestApi(port, 'POST', '/api/sync');
  if (!sync || !Array.isArray(sync.failed)) throw new Error(`sync returned unexpected payload: ${JSON.stringify(sync)}`);

  await requestApi(port, 'DELETE', `/api/files/${encodePath('项目 A/moved windows.md')}`);
  await requestApi(port, 'DELETE', `/api/folders/${encodePath('New Folder')}`);
  console.log('[smoke] packaged user file flow passed');
}

async function assertPackagedTranscriptionFlow(port) {
  const settings = await requestApi(port, 'GET', '/api/transcription/settings');
  const localProvider = settings?.providers?.find((provider) => provider.kind === 'local');
  if (!localProvider) throw new Error(`packaged local transcription provider missing: ${JSON.stringify(settings)}`);
  if (localProvider.runtimeError) {
    throw new Error(`packaged transcription runtime unavailable: ${localProvider.runtimeError}`);
  }
  await requestApi(port, 'PUT', '/api/transcription/preferences', {
    providerId: localProvider.id,
    modelId: 'tiny',
    language: 'en',
  });
  await requestApi(port, 'POST', '/api/transcription/models/tiny/download');

  const downloadDeadline = Date.now() + 3 * 60_000;
  let tiny = null;
  while (Date.now() < downloadDeadline) {
    const next = await requestApi(port, 'GET', '/api/transcription/settings');
    tiny = next.providers?.find((provider) => provider.id === localProvider.id)
      ?.models?.find((model) => model.id === 'tiny') ?? null;
    if (tiny?.available) break;
    if (tiny?.operation?.status === 'failed') {
      throw new Error(`tiny transcription model download failed: ${tiny.operation.error}`);
    }
    await sleep(500);
  }
  if (!tiny?.available) throw new Error('tiny transcription model did not install within 3 minutes');

  const transcriptDeadline = Date.now() + 3 * 60_000;
  let transcriptState = null;
  while (Date.now() < transcriptDeadline) {
    transcriptState = await requestApi(
      port,
      'GET',
      `/api/audio/transcript?path=${encodeURIComponent('transcription smoke.wav')}`,
    );
    if (transcriptState?.status === 'ready') break;
    if (transcriptState?.status === 'failed' || transcriptState?.status === 'blocked') {
      throw new Error(`packaged transcription failed: ${JSON.stringify(transcriptState)}`);
    }
    await sleep(500);
  }
  if (transcriptState?.status !== 'ready') {
    throw new Error(`packaged transcription did not finish: ${JSON.stringify(transcriptState)}`);
  }
  if (
    transcriptState.transcript?.provider?.model !== 'tiny'
    || !transcriptState.transcript?.source?.contentHash
  ) {
    throw new Error(`packaged transcript metadata is incomplete: ${JSON.stringify(transcriptState)}`);
  }

  await requestApi(port, 'POST', '/api/audio/preview/prepare', { path: 'transcription smoke.wav' });
  const preview = await requestBytes(
    port,
    `/asset-audio-preview/__window/packaged-smoke/${encodePath('transcription smoke.wav')}`,
    15_000,
  );
  if (!preview.ok || preview.statusCode !== 200 || preview.body.length === 0) {
    throw new Error(`packaged FFmpeg preview failed: status=${preview.statusCode} bytes=${preview.body.length}`);
  }
  if (!String(preview.headers['content-type'] ?? '').startsWith('audio/webm')) {
    throw new Error(`packaged preview has unexpected content type: ${preview.headers['content-type']}`);
  }
  console.log('[smoke] packaged model download, FFmpeg decode/preview, and whisper.cpp inference passed');
}

function writeWavFixture(file) {
  const sampleRate = 16_000;
  const seconds = 2;
  const sampleCount = sampleRate * seconds;
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const envelope = Math.sin(Math.PI * index / sampleCount);
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * envelope * 4_000);
    wav.writeInt16LE(sample, 44 + index * 2);
  }
  fs.writeFileSync(file, wav);
}

function writeDocxFixture(file) {
  const docxBase64 = [
    'UEsDBBQAAAAIAKaK8VzXeYTq8QAAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QzU7DMBCE730Ky9cqccoBIZSkB36OwKE8wMreJFb9J69b2rdn00KREOVozXwz62nXB+/EHjPZGDq5qhspMOhobBg7+b55ru6koALBgIsBO3lEkut+0W6OCUkwHKiTUynpXinSE3qgOiYMrAwxeyj8zKNKoLcworppmlulYygYSlXmDNkvhGgfcYCdK+LpwMr5loyOpHg4e+e6TkJKzmoorKt9ML+Kqq+SmsmThyabaMkGqa6VzOL1jh/0lSfK1qB4g1xewLNRfcRslIl65xmu/0/649o4DFbjhZ/TUo4aiXh77+qL4sGG71+06jR8/wlQSwMEFAAAAAgAporxXCAbhuqyAAAALgEAAAsAAABfcmVscy8ucmVsc43Puw6CMBQG4J2naM4uBQdjDIXFmLAafICmPZRGeklbL7y9HRzEODie23fyN93TzOSOIWpnGdRlBQStcFJbxeAynDZ7IDFxK/nsLDJYMELXFs0ZZ57yTZy0jyQjNjKYUvIHSqOY0PBYOo82T0YXDE+5DIp6Lq5cId1W1Y6GTwPagpAVS3rJIPSyBjIsHv/h3ThqgUcnbgZt+vHlayPLPChMDB4uSCrf7TKzQHNKuorZvgBQSwMEFAAAAAgAporxXBosGbe8AAAA8wAAABEAAAB3b3JkL2RvY3VtZW50LnhtbDWOQWvDMAyF7/kVwvfV6Q5jhMSFtozdNlgHu3q22oTaUrC8Zf33tQO7fNLTQ0/qd38xwC8mmZgGtd20CpAc+4kug/o8vTw8K5BsydvAhIO6oaidafql8+x+IlKGkkDSLYMac547rcWNGK1seEYq3plTtLnIdNELJz8ndihSDsSgH9v2SUc7kTINQEn9Zn8zpc4VqSKbVwyB4SNbGfdWEI5vhy+QyFfsdfUr08p1S9Dl96TXwRrX1O7/XXMHUEsBAhQDFAAAAAgAporxXNd5hOrxAAAAuAEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACACmivFcIBuG6rIAAAAuAQAACwAAAAAAAAAAAAAAgAEiAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACACmivFcGiwZt7wAAADzAAAAEQAAAAAAAAAAAAAAgAH9AQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAA6AIAAAAA',
  ].join('');
  fs.writeFileSync(file, Buffer.from(docxBase64, 'base64'));
}

function writeTinyPdf(file) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '5 0 obj\n<< /Length 51 >>\nstream\nBT /F1 18 Tf 40 80 Td (Hello StashBase PDF smoke) Tj ET\nendstream\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += obj;
  }
  const xref = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, body);
}


function writeOcrFixture(file) {
  const pngBase64 = [
    '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',
  ].join('');
  fs.writeFileSync(file, Buffer.from(pngBase64, 'base64'));
}

function runProcess(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(command)} timed out`));
    }, options.timeoutMs ?? 10_000);
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output: out });
    });
  });
}

async function smokeOcrExtractor(extractBin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-smoke-ocr-'));
  try {
    const image = path.join(tmp, 'smoke.png');
    const out = path.join(tmp, '.smoke.md');
    writeOcrFixture(image);
    const probe = await runProcess(extractBin, ['ocr', image, out], { timeoutMs: 20_000 });
    if (probe.code !== 0) {
      throw new Error(`ocr extractor failed: exit=${probe.code}\n${probe.output.slice(-4_000)}`);
    }
    const note = fs.readFileSync(out, 'utf8').replace(/\s+/g, '');
    if (!/HELLOSTASHBASEOCR/i.test(note)) {
      throw new Error(`ocr extractor did not preserve expected text\n${note.slice(0, 1_000)}`);
    }
    console.log('[smoke] python OCR extractor converted a fixture');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function smokePdfExtractor(extractBin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-smoke-pdf-'));
  try {
    const pdf = path.join(tmp, 'smoke.pdf');
    const out = path.join(tmp, '.smoke.md');
    const bundle = path.join(tmp, '.smoke_files');
    writeTinyPdf(pdf);
    const probe = await runProcess(extractBin, ['pdf', pdf, out, bundle], { timeoutMs: 15_000 });
    if (probe.code !== 0) {
      throw new Error(`pdf extractor failed: exit=${probe.code}\n${probe.output.slice(-4_000)}`);
    }
    const note = fs.readFileSync(out, 'utf8');
    if (!/Hello\s+StashBase\s+PDF\s+smoke/i.test(note)) {
      throw new Error(`pdf extractor did not preserve expected text\n${note.slice(0, 1_000)}`);
    }
    console.log('[smoke] python PDF extractor converted a fixture');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function smokeDaemon(daemonBin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-smoke-py-'));
  const folderHome = path.join(tmp, 'folder-home');
  const folderRoot = path.join(folderHome, 'Smoke');
  const storeRoot = path.join(tmp, 'store');
  fs.mkdirSync(folderRoot, { recursive: true });
  const child = spawn(daemonBin, ['--store-root', storeRoot], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`daemon smoke did not finish within 20s\n${output.slice(-4_000)}`));
      }, 20_000);
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const send = (id, op, args) => {
        child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
      };
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.event === 'ready') {
              send(1, 'bind_folder', { folder: folderRoot, provider: 'openai', api_key: 'sk-smoke' });
              continue;
            }
            if (msg.id === 1) {
              if (!msg.ok) {
                settle(reject, new Error(`daemon bind_folder failed: ${msg.error}\n${output.slice(-4_000)}`));
                continue;
              }
              send(2, 'list', { folder: folderRoot });
              continue;
            }
            if (msg.id === 2) {
              if (!msg.ok) {
                settle(reject, new Error(`daemon list failed: ${msg.error}\n${output.slice(-4_000)}`));
                continue;
              }
              settle(resolve);
            }
            if (msg.event === 'error') settle(reject, new Error(`daemon error: ${msg.error}`));
          } catch {
            // Keep collecting output; the daemon should speak JSON lines.
          }
        }
      });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.on('error', (err) => settle(reject, err));
      child.on('exit', (code, signal) => {
        settle(reject, new Error(`daemon exited before smoke completed (code=${code}, signal=${signal})\n${output.slice(-4_000)}`));
      });
    });
    console.log('[smoke] python daemon responded to bind/list');
  } finally {
    child.stdin.end();
    if (child.exitCode == null) child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2_000).then(() => {
        if (child.exitCode == null) child.kill('SIGKILL');
      }),
    ]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const appPath = findPackagedApp();
const layout = packagedLayout(appPath);
const { resourcesPath, appRoot, electronBin } = layout;
const serverEntry = path.join(appRoot, 'dist', 'server', 'index.mjs');
const daemonBin = findSidecarExecutable(resourcesPath, 'stashbase-daemon');
const extractBin = findSidecarExecutable(resourcesPath, 'stashbase-extract');
const requireExtract = args.includes('--require-extract')
  || process.env.STASHBASE_REQUIRE_EXTRACT === '1'
  || process.env.STASHBASE_BUILD_EXTRACT === '1';
const requireTranscription = args.includes('--require-transcription')
  || process.env.STASHBASE_REQUIRE_TRANSCRIPTION === '1';
const rgPath = path.join(
  resourcesPath,
  'app.asar.unpacked',
  'node_modules',
  '@vscode',
  layout.ripgrepPackage,
  'bin',
  layout.ripgrepBinary,
);

assertFile(electronBin, 'packaged Electron binary');
assertFile(appRoot, 'app.asar');
assertFile(rgPath, 'packaged ripgrep binary');
assertFile(daemonBin, 'packaged Python daemon sidecar');
if (requireExtract) assertFile(extractBin, 'packaged Python extractor sidecar');

await smokeDaemon(daemonBin);
if (fs.existsSync(extractBin)) {
  const extractProbe = await runProcess(extractBin, [], { timeoutMs: 5_000 });
  if (extractProbe.code !== 2 || !/usage: stashbase-extract/.test(extractProbe.output)) {
    throw new Error(`unexpected extractor probe result: exit=${extractProbe.code}\n${extractProbe.output.slice(-4_000)}`);
  }
  console.log('[smoke] python extractor responded');
  await smokePdfExtractor(extractBin);
  await smokeOcrExtractor(extractBin);
} else {
  console.log('[smoke] optional Python PDF/OCR extractor not bundled; skipping extractor smoke');
}

const port = Number(argValue('--port')) || 18_000 + Math.floor(Math.random() * 20_000);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-smoke-home-'));
const folderHome = path.join(home, 'folders');
const localDataRoot = path.join(home, 'data');
const appData = path.join(home, 'AppData', 'Roaming');
const localAppData = path.join(home, 'AppData', 'Local');
const output = [];

console.log(`[smoke] app ${path.relative(root, appPath)}`);
console.log(`[smoke] server ${serverEntry}`);
console.log(`[smoke] port ${port}`);

const child = spawn(electronBin, [serverEntry, `--port=${port}`], {
  cwd: resourcesPath,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''),
    HOMEPATH: home.slice(path.parse(home).root.length - (path.parse(home).root.endsWith(path.sep) ? 1 : 0)),
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    STASHBASE_FOLDER_HOME: folderHome,
    STASHBASE_LOCAL_DATA_ROOT: localDataRoot,
    STASHBASE_APP_ROOT: appRoot,
    STASHBASE_RESOURCES_PATH: resourcesPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => output.push(chunk.toString()));
child.stderr.on('data', (chunk) => output.push(chunk.toString()));

try {
  await waitForServer(port, child, output);
  await assertPackagedHealth(port, {
    app: 'stashbase',
    ok: true,
    protocolVersion: 1,
    appRoot,
    resourcesPath,
  });
  console.log('[smoke] packaged server responded');
  await assertPackagedRendererWorkers(port);
  await assertPackagedUserFlow(port, home, { requireTranscription });
} finally {
  if (child.exitCode == null) child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(2_000).then(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
    }),
  ]);
  fs.rmSync(home, { recursive: true, force: true });
}
