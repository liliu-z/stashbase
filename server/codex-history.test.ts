import './__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexThreadHasContent, codexThreadToBlocks, listCodexSessions } from './codex-history.ts';
import { nativeTimesByUuid, transcriptToBlocks } from './claude-history.ts';
import { codexHistoryActions } from './codex-history-adapter.ts';
import { sendError } from './http.ts';
import { agentProcessClosed } from './agent-process.ts';

for (const recovery of ['healthy', 'stalled'] as const) test(`concurrent Codex history lists wait for retirement and bound a ${recovery} retry`, { skip: process.platform === 'win32', timeout: 10_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-list-'));
  const binary = path.join(root, 'codex');
  fs.writeFileSync(binary, 'fixture'); fs.chmodSync(binary, 0o700);
  const release = path.join(root, 'release');
  const stopping = path.join(root, 'stopping');
  const listRequests = path.join(root, 'lists');
  const previousBin = process.env.STASHBASE_CODEX_BIN;
  process.env.STASHBASE_CODEX_BIN = binary;
  const spawn = childProcess.spawn;
  const children: childProcess.ChildProcessWithoutNullStreams[] = [];
  let initializing = true;
  const realTimeout = setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((...args: Parameters<typeof setTimeout>) => {
    const [fn, ms, ...rest] = args;
    return realTimeout(fn, ms === 30_000 && !initializing ? 200 : ms, ...rest);
  }) as typeof setTimeout);
  t.mock.method(childProcess, 'spawn', ((command: string) => {
    assert.equal(command, binary);
    assert.ok(children.every(child => child.exitCode != null || child.signalCode != null), 'replacement cannot overlap the retiring reader');
    initializing = true;
    const first = children.length === 0;
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const readline = require('node:readline');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(stopping)}, 'stopping');
        const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0); }
        }, 5);
      });
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.id == null) return;
        if (request.method === 'thread/list') fs.appendFileSync(${JSON.stringify(listRequests)}, 'list\\n');
        if (request.method === 'thread/list' && ${first || recovery === 'stalled'}) return;
        const result = request.method === 'thread/list' ? { data: [{ id: 'history-thread', cwd: ${JSON.stringify(root)}, preview: 'Saved work', updatedAt: 123 }] } : {};
        process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
      });
    `], { detached: true, stdio: 'pipe' });
    children.push(child);
    // Shorten the list deadline only after the real child has initialized;
    // process startup under load is not the stalled-read scenario.
    child.stdout.once('data', () => { initializing = false; });
    return child;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(async () => {
    fs.writeFileSync(release, 'release');
    for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    await Promise.all(children.map(child => agentProcessClosed(child)));
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (previousBin === undefined) delete process.env.STASHBASE_CODEX_BIN;
    else process.env.STASHBASE_CODEX_BIN = previousBin;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const result = Promise.all([listCodexSessions(root), listCodexSessions(root)])
    .then(value => ({ value, error: '' }), error => ({ value: [], error: String(error) }));
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(stopping) && Date.now() < deadline) await new Promise(resolve => realTimeout(resolve, 5));
  assert.ok(fs.existsSync(stopping));
  assert.equal(children.length, 1);
  fs.writeFileSync(release, 'release');
  const settled = await result;
  if (recovery === 'healthy') {
    assert.equal(settled.error, '');
    assert.deepEqual(settled.value.map(rows => rows.map(row => row.id)), [['history-thread'], ['history-thread']]);
  } else assert.match(settled.error, /Codex app-server request timed out: thread\/list/);
  assert.equal(children.length, 2);
  assert.equal(fs.readFileSync(listRequests, 'utf8'), 'list\nlist\n', 'concurrent list callers share each physical read and its one retry');
});

test('missing Codex is an installation prerequisite for history, not an empty result or server failure', async (t) => {
  t.mock.method(fs, 'accessSync', () => {
    throw Object.assign(new Error('not installed'), { code: 'ENOENT' });
  });
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('must not spawn'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const history = codexHistoryActions();
  for (const action of [
    () => history.list('/missing-codex-project'),
    () => history.messages('thread', '/missing-codex-project'),
    () => history.rename('thread', 'Title', '/missing-codex-project'),
    () => history.remove('thread', '/missing-codex-project'),
  ]) {
    await assert.rejects(action, (error: unknown) => {
      let status = 200;
      let body: unknown;
      sendError({
        status(value: number) { status = value; return this; },
        json(value: unknown) { body = value; return this; },
      } as Parameters<typeof sendError>[0], error);
      assert.equal(status, 412);
      assert.equal((body as { code: string }).code, 'AGENT_NOT_INSTALLED');
      assert.match((body as { error: string }).error, /Install Codex in Settings/);
      return true;
    });
  }
  assert.equal(spawn.mock.callCount(), 0);
});

test('Codex history validates native project ownership before renaming and deleting', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-history-'));
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  fs.mkdirSync(project); fs.mkdirSync(other);
  const binary = path.join(root, process.platform === 'win32' ? 'codex.exe' : 'codex');
  fs.writeFileSync(binary, 'fixture binary');
  fs.chmodSync(binary, 0o700);
  const previousBin = process.env.STASHBASE_CODEX_BIN;
  process.env.STASHBASE_CODEX_BIN = binary;
  const originalSpawn = childProcess.spawn;
  const processes: EventEmitter[] = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const thread = { id: 'thread', cwd: project, name: 'Original', updatedAt: 123, preview: 'Started', turns: [] };
  let missing = false;
  let invalidAfterRename = false;
  let renamed = false;
  childProcess.spawn = ((command: string) => {
    assert.equal(command, binary, 'Never launch a real native runtime in this test');
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: () => { proc.emit('close', 0, null); return true; },
    });
    processes.push(proc);
    proc.stdin.on('data', (data: Buffer) => {
      for (const line of data.toString().trim().split('\n')) {
        const request = JSON.parse(line) as { id?: number; method: string; params: Record<string, unknown> };
        if (request.id == null) continue;
        requests.push(request);
        if (request.method === 'thread/name/set') { thread.name = String(request.params.name); renamed = true; }
        const result = request.method === 'thread/read'
          ? { thread: invalidAfterRename && renamed ? {} : { ...thread } }
          : {};
        queueMicrotask(() => proc.stdout.write(JSON.stringify(missing && request.method === 'thread/read'
          ? { id: request.id, error: { code: -32602, message: 'thread not found' } }
          : { id: request.id, result }) + '\n'));
      }
    });
    return proc;
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  t.after(() => {
    for (const proc of processes) proc.emit('close', 0, null);
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    if (previousBin === undefined) delete process.env.STASHBASE_CODEX_BIN;
    else process.env.STASHBASE_CODEX_BIN = previousBin;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const history = codexHistoryActions();
  for (const action of [
    () => history.messages(thread.id, other),
    () => history.rename(thread.id, 'Forbidden', other),
    () => history.remove(thread.id, other),
  ]) {
    requests.length = 0;
    await assert.rejects(async () => action(), /session not found/);
    assert.equal(requests.some(({ method }) => method === 'thread/name/set' || method === 'thread/delete'), false);
  }
  requests.length = 0;
  const result = await history.rename(thread.id, 'Renamed', project);
  assert.deepEqual(requests.filter(({ method }) => method !== 'initialize').map(({ method }) => method), ['thread/read', 'thread/name/set', 'thread/read']);
  assert.deepEqual(result, { id: thread.id, title: 'Renamed', lastModified: 123_000, hasContent: true, cwd: project });

  missing = true;
  requests.length = 0;
  await assert.rejects(history.rename(thread.id, 'Missing', project), /thread not found/);
  assert.deepEqual(requests.map(({ method }) => method), ['thread/read']);
  missing = false;
  renamed = false;
  invalidAfterRename = true;
  await assert.rejects(history.rename(thread.id, 'Invalid metadata', project), /session not found/);
  invalidAfterRename = false;
  requests.length = 0;
  await history.remove(thread.id, project);
  assert.deepEqual(requests.map(({ method }) => method), ['thread/read', 'thread/delete']);
});

test('Codex history distinguishes allocated blanks from started conversations', () => {
  assert.equal(codexThreadHasContent({ id: 'blank', preview: '' }), false);
  assert.equal(codexThreadHasContent({ id: 'started', preview: 'Review the plan' }), true);
});

test('restores an expired transient image as a name-only card from the persisted prompt marker', () => {
  const imagePath = path.join(os.tmpdir(), 'stashbase-attachments', 'batch-1', 'image.png');
  const blocks = codexThreadToBlocks({
    turns: [{
      items: [{
        type: 'userMessage',
        content: [{
          type: 'text',
          text: `check what is written in the image\n\nAttached files:\n- ${imagePath}`,
        }],
      }],
    }],
  });

  assert.deepEqual(blocks, [{
    kind: 'user',
    id: 'c0',
    text: 'check what is written in the image',
    attachments: [{
      path: imagePath,
      name: 'image.png',
    }],
  }]);
});

test('restores an unrecognised transient file as a name-only attachment', () => {
  const archivePath = path.join(
    os.tmpdir(),
    'stashbase-attachments',
    'batch-archive',
    'sources.zip',
  );
  const blocks = codexThreadToBlocks({
    turns: [{
      items: [{
        type: 'userMessage',
        content: [{
          type: 'text',
          text: `inspect this archive\n\nAttached files:\n- ${archivePath}`,
        }],
      }],
    }],
  });

  assert.deepEqual(blocks, [{
    kind: 'user',
    id: 'c0',
    text: 'inspect this archive',
    attachments: [{ path: archivePath, name: 'sources.zip' }],
  }]);
});

test('does not expose arbitrary filesystem paths embedded in a prompt', () => {
  const blocks = codexThreadToBlocks({
    turns: [{
      items: [{
        type: 'userMessage',
        content: [{
          type: 'text',
          text: 'keep this\n\nAttached files:\n- /Users/someone/private.png',
        }],
      }],
    }],
  });

  assert.deepEqual(blocks, [{
    kind: 'user',
    id: 'c0',
    text: 'keep this\n\nAttached files:\n- /Users/someone/private.png',
  }]);
});

test('restores the same expired attachment card for a Claude SDK transcript', () => {
  const imagePath = path.join(os.tmpdir(), 'stashbase-attachments', 'batch-2', 'image.png');
  const blocks = transcriptToBlocks([{
    type: 'user',
    message: { content: `review the attached image\n\nAttached files:\n- ${imagePath}` },
  }]);

  assert.deepEqual(blocks, [{
    kind: 'user',
    id: 'h0',
    text: 'review the attached image',
    attachments: [{
      path: imagePath,
      name: 'image.png',
    }],
  }]);
});

test('lifts selected passages into quoted cards beside the file attached from the same document', () => {
  const blocks = codexThreadToBlocks({
    turns: [{
      items: [{
        type: 'userMessage',
        content: [{
          type: 'text',
          text: [
            'tighten these',
            '',
            'Selected passages:',
            '- /Users/me/notes/draft.md',
            '  > First paragraph.',
            '  >',
            '  > Second paragraph.',
            '- /Users/me/notes/draft.md',
            '  > A later line.',
            '',
            'Attached files:',
            '- /Users/me/notes/draft.md',
          ].join('\n'),
        }],
      }],
    }],
  });

  assert.deepEqual(blocks, [{
    kind: 'user',
    id: 'c0',
    text: 'tighten these',
    attachments: [
      { path: '/Users/me/notes/draft.md', name: 'draft.md', quote: 'First paragraph.\n\nSecond paragraph.' },
      { path: '/Users/me/notes/draft.md', name: 'draft.md', quote: 'A later line.' },
      { path: '/Users/me/notes/draft.md', name: 'draft.md' },
    ],
  }]);
});

test('keeps a passage from an unknown path in the prose while lifting a known one', () => {
  const blocks = transcriptToBlocks([{
    type: 'user',
    message: {
      content: [
        'Selected passages:',
        '- /etc/passwd',
        '  > root:x:0:0',
        '- /Users/me/notes/draft.md',
        '  > Kept as a card.',
      ].join('\n'),
    },
  }]);

  assert.deepEqual(blocks, [{
    kind: 'user',
    id: 'h0',
    text: 'Selected passages:\n- /etc/passwd\n  > root:x:0:0',
    attachments: [{ path: '/Users/me/notes/draft.md', name: 'draft.md', quote: 'Kept as a card.' }],
  }]);
});

test('leaves typed prose that only resembles a passage block untouched', () => {
  const text = 'notes\n\nSelected passages:\n- /Users/me/notes/draft.md\nnot a quote line';
  const blocks = codexThreadToBlocks({
    turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text }] }] }],
  });

  assert.deepEqual(blocks, [{ kind: 'user', id: 'c0', text }]);
});

test('restores a non-image document attachment as a name-only card', () => {
  const blocks = codexThreadToBlocks({
    turns: [{
      items: [{
        type: 'userMessage',
        content: [{
          type: 'text',
          text: 'summarise the report\n\nAttached files:\n- /Users/me/notes/report.pdf',
        }],
      }],
    }],
  });

  assert.deepEqual(blocks, [{
    kind: 'user',
    id: 'c0',
    text: 'summarise the report',
    attachments: [{ path: '/Users/me/notes/report.pdf', name: 'report.pdf' }],
  }]);
});

test('restores folder-relative document attachments, dropping available and unavailable derived hints', () => {
  const hints = [
    'for text context, use mcp__stashbase__read_file with path /Users/me/notes/report.pdf; it returns the derived text representation for this pdf',
    'derived text is not available yet; Current prepared text is unavailable; retry after preparation completes or reprocess the source.',
  ];
  for (const hint of hints) {
    const blocks = codexThreadToBlocks({
      turns: [{
        items: [{
          type: 'userMessage',
          content: [{
            type: 'text',
            text: `what does it argue?\n\nAttached files:\n- papers/report (final).pdf (${hint})`,
          }],
        }],
      }],
    });

    assert.deepEqual(blocks, [{
      kind: 'user',
      id: 'c0',
      text: 'what does it argue?',
      attachments: [{ path: 'papers/report (final).pdf', name: 'report (final).pdf' }],
    }]);
  }
});

test('restores a non-image document card for a Claude SDK transcript', () => {
  const blocks = transcriptToBlocks([{
    type: 'user',
    message: { content: 'review this\n\nAttached files:\n- /Users/me/docs/spec.docx' },
  }]);

  assert.deepEqual(blocks, [{
    kind: 'user',
    id: 'h0',
    text: 'review this',
    attachments: [{ path: '/Users/me/docs/spec.docx', name: 'spec.docx' }],
  }]);
});

test('restores generic and extensionless file references as name-only cards', () => {
  const sources = ['/Users/me/project/build notes (local).mjs', '/Users/me/project/.env', '/etc/passwd'];
  const blocks = codexThreadToBlocks({
    turns: [{
      items: [{
        type: 'userMessage',
        content: [{
          type: 'text',
          text: `review these\n\nAttached files:\n${sources.map(source => `- ${source}`).join('\n')}`,
        }],
      }],
    }],
  });

  assert.deepEqual(blocks, [{
    kind: 'user',
    id: 'c0',
    text: 'review these',
    attachments: sources.map(source => ({ path: source, name: path.basename(source) })),
  }]);
});

test('leaves attachment-like prose without an absolute file path untouched', () => {
  const text = 'keep this\n\nAttached files:\n- build notes (local).mjs';
  const blocks = codexThreadToBlocks({
    turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text }] }] }],
  });
  assert.deepEqual(blocks, [{ kind: 'user', id: 'c0', text }]);
});

test('turn startedAt/completedAt become user/assistant timestamps in ms', () => {
  const blocks = codexThreadToBlocks({
    turns: [{
      startedAt: 1787636210,
      completedAt: 1787636424,
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', text: 'answer' },
      ],
    }],
  });

  assert.deepEqual(blocks, [
    { kind: 'user', id: 'c0', text: 'question', at: 1787636210000 },
    { kind: 'assistant', id: 'c1', text: 'answer', at: 1787636424000 },
  ]);
});

test('a turn without recorded times leaves its messages timeless', () => {
  const blocks = codexThreadToBlocks({
    turns: [{
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', text: 'answer' },
      ],
    }],
  });

  assert.deepEqual(blocks, [
    { kind: 'user', id: 'c0', text: 'question' },
    { kind: 'assistant', id: 'c1', text: 'answer' },
  ]);
});

test('Claude SDK messages take their time from the native line sharing their uuid', () => {
  const blocks = transcriptToBlocks(
    [
      { type: 'user', uuid: 'u-1', message: { content: 'question' } },
      { type: 'assistant', uuid: 'a-1', message: { content: [{ type: 'text', text: 'answer' }] } },
      { type: 'assistant', uuid: 'a-2', message: { content: [{ type: 'text', text: 'unjoined' }] } },
    ],
    new Map([['u-1', 1787636210000], ['a-1', 1787636424000]]),
  );

  assert.deepEqual(blocks, [
    { kind: 'user', id: 'h0', text: 'question', at: 1787636210000 },
    { kind: 'assistant', id: 'h1', text: 'answer', at: 1787636424000 },
    { kind: 'assistant', id: 'h2', text: 'unjoined' },
  ]);
});

test('nativeTimesByUuid keeps only real, parseable native timestamps', () => {
  const times = nativeTimesByUuid([
    { type: 'user', uuid: 'u-1', timestamp: '2026-05-20T12:58:56.700Z' },
    { type: 'assistant', uuid: 'a-1', timestamp: 'not a date' },
    { type: 'assistant', uuid: 'a-2' },
    { type: 'assistant', timestamp: '2026-05-20T12:59:00.000Z' },
  ]);
  assert.deepEqual([...times.entries()], [['u-1', Date.parse('2026-05-20T12:58:56.700Z')]]);
});
