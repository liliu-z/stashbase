import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { downloadGitHubSnapshot } from './github-snapshot.ts';

const repository = { owner: 'owner', repo: 'repo', canonicalUrl: 'https://github.com/owner/repo', defaultFolderName: 'repo' };
interface Entry { path: string; type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link' | 'CharacterDevice' | 'GNUDumpDir'; content?: string; linkpath?: string; mode?: number; size?: number }
function archive(entries: Entry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    const header = new Header({
      path: entry.path, type: entry.type ?? 'File', mode: entry.mode ?? 0o644,
      size: entry.size ?? content.length, linkpath: entry.linkpath,
    });
    header.encode();
    chunks.push(header.block!, content);
    if (content.length % 512) chunks.push(Buffer.alloc(512 - content.length % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
const valid = () => archive([
  { path: 'repo-sha/', type: 'Directory' },
  { path: 'repo-sha/README.md', content: '# Snapshot\n' },
]);
async function staging(t: import('node:test').TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stashbase-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'repository');
  await fs.mkdir(destination);
  return destination;
}

test('follows the public archive redirect and extracts nested files, Unicode and executable modes', async (t) => {
  const destination = await staging(t);
  const calls: string[] = [];
  const request: typeof fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(options?.redirect, 'manual');
    assert.equal(options?.credentials, 'omit');
    assert.equal(new Headers(options?.headers).has('authorization'), false);
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/owner/repo/legacy.tar.gz/refs/heads/trunk' } })
      : new Response(archive([
        { path: 'owner-repo-sha/', type: 'Directory' },
        { path: 'owner-repo-sha/资料/notes.md', content: '你好\n' },
        { path: 'owner-repo-sha/run.sh', content: '#!/bin/sh\n', mode: 0o755 },
      ]));
  };
  await downloadGitHubSnapshot(repository, destination, new AbortController().signal, request);
  assert.deepEqual(calls, [
    'https://api.github.com/repos/owner/repo/tarball',
    'https://codeload.github.com/owner/repo/legacy.tar.gz/refs/heads/trunk',
  ]);
  assert.equal(await fs.readFile(path.join(destination, '资料/notes.md'), 'utf8'), '你好\n');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(destination, 'run.sh'))).mode & 0o777, 0o755);
  assert.deepEqual((await fs.readdir(destination)).sort(), ['run.sh', '资料']);
});

test('refuses off-host, insecure and credential-bearing redirects before requesting them', async (t) => {
  const destination = await staging(t);
  for (const location of ['http://codeload.github.com/a', 'https://evil.example/a', 'https://codeload.github.com.evil.example/a', 'https://user:secret@codeload.github.com/a', 'https://codeload.github.com:444/a']) {
    let calls = 0;
    await assert.rejects(downloadGitHubSnapshot(repository, destination, new AbortController().signal, async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location } });
    }), { code: 'DOWNLOAD_FAILED' });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(downloadGitHubSnapshot(repository, destination, new AbortController().signal, async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://api.github.com/loop' } });
  }), { code: 'DOWNLOAD_FAILED' });
  assert.equal(calls, 4);
});

test('refuses malformed, truncated, escaping, colliding and unsupported archive entries', async (t) => {
  const cases: Array<Buffer | Entry[]> = [
    Buffer.from('<html>not an archive</html>'),
    gzipSync(Buffer.from('not a tar archive')),
    gzipSync(valid()),
    valid().subarray(0, valid().length - 8),
    [{ path: 'root/../../outside', content: 'bad' }],
    [{ path: '/absolute', content: 'bad' }],
    [{ path: 'root/C:\\outside', content: 'bad' }],
    [{ path: 'root/hello:stream', content: 'bad' }],
    [{ path: 'root/.git/config', content: 'bad' }],
    [{ path: 'root/a', content: 'one' }, { path: 'root/a', content: 'two' }],
    [{ path: 'root/A', content: 'one' }, { path: 'root/a', content: 'two' }],
    [{ path: 'root/a', content: 'one' }, { path: 'other/b', content: 'two' }],
    [{ path: 'root/a', type: 'Link', linkpath: 'outside' }],
    [{ path: 'root/device', type: 'CharacterDevice' }],
    [{ path: 'root/special', type: 'GNUDumpDir' }],
    [{ path: 'root/a', type: 'SymbolicLink', linkpath: '../../outside' }],
    [{ path: 'root/a', type: 'SymbolicLink', linkpath: '.' }, { path: 'root/a/file', content: 'bad' }],
    [{ path: 'root/a/file', content: 'bad' }, { path: 'root/a', type: 'SymbolicLink', linkpath: '.' }],
    [{ path: 'root/file', size: 8192, content: 'truncated' }],
  ];
  for (const [i, entries] of cases.entries()) {
    await t.test(`invalid archive ${i + 1}`, async (t) => {
      const destination = await staging(t);
      await assert.rejects(downloadGitHubSnapshot(repository, destination, new AbortController().signal,
        async () => new Response(Buffer.isBuffer(entries) ? entries : archive(entries))), { code: 'INVALID_ARCHIVE' });
      assert.deepEqual(await fs.readdir(path.dirname(destination)), ['repository']);
    });
  }
});

test('bounds declared and streamed download bytes, expanded bytes, entry sizes and entry counts', async (t) => {
  for (const options of [
    { headers: { 'content-length': '100' }, limits: { downloadBytes: 10 } },
    { limits: { downloadBytes: 10 } },
    { limits: { expandedBytes: 100 } },
    { limits: { entries: 1 } },
  ]) {
    const destination = await staging(t);
    await assert.rejects(downloadGitHubSnapshot(repository, destination, new AbortController().signal,
      async () => new Response(valid(), { headers: options.headers }), options.limits), { code: 'ARCHIVE_TOO_LARGE' });
  }
  const destination = await staging(t);
  await assert.rejects(downloadGitHubSnapshot(repository, destination, new AbortController().signal,
    async () => new Response(archive([{ path: 'root/huge', size: 10_000 }])), { expandedBytes: 4096 }), { code: 'ARCHIVE_TOO_LARGE' });
});

test('keeps internal symbolic links and refuses dangling, cyclic and indirectly escaping links', { skip: process.platform === 'win32' }, async (t) => {
  const destination = await staging(t);
  await downloadGitHubSnapshot(repository, destination, new AbortController().signal, async () => new Response(archive([
    { path: 'root/docs/notes.md', content: 'notes' },
    { path: 'root/current', type: 'SymbolicLink', linkpath: 'docs/notes.md' },
  ])));
  assert.equal(await fs.readlink(path.join(destination, 'current')), 'docs/notes.md');
  assert.equal(await fs.readFile(path.join(destination, 'current'), 'utf8'), 'notes');
  for (const entries of [
    [{ path: 'root/link', type: 'SymbolicLink' as const, linkpath: 'missing' }],
    [{ path: 'root/a', type: 'SymbolicLink' as const, linkpath: 'b' }, { path: 'root/b', type: 'SymbolicLink' as const, linkpath: 'a' }],
    [{ path: 'root/a', type: 'SymbolicLink' as const, linkpath: '.' }, { path: 'root/b', type: 'SymbolicLink' as const, linkpath: 'a/../outside' }],
  ]) {
    const target = await staging(t);
    await fs.writeFile(path.join(path.dirname(target), 'outside'), 'keep');
    await assert.rejects(downloadGitHubSnapshot(repository, target, new AbortController().signal,
      async () => new Response(archive(entries))), { code: 'INVALID_ARCHIVE' });
    assert.equal(await fs.readFile(path.join(path.dirname(target), 'outside'), 'utf8'), 'keep');
  }
});

test('cancels the streaming response and waits for extraction writes before returning', async (t) => {
  const destination = await staging(t);
  const controller = new AbortController();
  let cancelled = false;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const importing = downloadGitHubSnapshot(repository, destination, controller.signal, async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(valid().subarray(0, -8)); started(); },
    cancel() { cancelled = true; },
  })));
  const refused = assert.rejects(importing, { code: 'IMPORT_CANCELLED' });
  await ready;
  controller.abort();
  await refused;
  assert.equal(cancelled, true);
  await fs.rm(destination, { recursive: true });
});

test('stalled response bodies time out as retryable download failures', async (t) => {
  const destination = await staging(t);
  let cancelled = false;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(downloadGitHubSnapshot(repository, destination, new AbortController().signal,
      async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
      { idleMs: 10 }), { code: 'DOWNLOAD_FAILED' });
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});
