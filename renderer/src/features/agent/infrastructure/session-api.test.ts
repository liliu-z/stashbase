import { describe, expect, it, vi } from 'vite-plus/test';

import { httpClient } from '@/test/fakes/http';

import { createAgentSessionAdapter } from './session-api';

describe('Agent session API', () => {
  it('opens the shared socket without exposing renderer-owned window identity', () => {
    let opened = '';
    const socket = {
      readyState: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
      send: vi.fn(),
    };
    const api = createAgentSessionAdapter(httpClient(), 'https://127.0.0.1:43123/', (url) => {
      opened = url;
      return socket;
    });

    api.connect(
      {
        agent: 'codex',
        effort: 'high',
        model: 'gpt-codex',
        scope: { kind: 'folder', path: '/Notes & Plans' },
      },
      { onClose: vi.fn(), onEvent: vi.fn(), onInvalidResponse: vi.fn() },
    );

    const url = new URL(opened);
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/ws/agent');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      access: 'auto',
      agent: 'codex',
      effort: 'high',
      folder: '/Notes & Plans',
      model: 'gpt-codex',
    });
    expect(url.searchParams.has('windowId')).toBe(false);
  });

  it('replays a quoted attachment in the chat folder as a passage and the rest as uploads', async () => {
    const api = createAgentSessionAdapter(
      httpClient({
        effort: null,
        messages: [
          {
            attachments: [
              {
                name: 'essay.md',
                path: '/project/Research/drafts/essay.md',
                quote: 'The opening line.',
              },
              { name: 'other.md', path: '/project/Plans/other.md', quote: 'Elsewhere.' },
              { name: 'chart.png', path: '/tmp/chart.png', previewUrl: '/api/preview?p=chart' },
            ],
            id: 'user-1',
            kind: 'user',
            text: 'Is this clear?',
          },
        ],
        protocol: 2,
      }),
      'http://127.0.0.1:1',
    );
    const replay = await api.replay(
      {
        agent: 'codex',
        hasContent: true,
        id: 'session-1',
        lastModified: 42,
        scope: { kind: 'folder', path: '/project/Research' },
        title: 'Research',
      },
      new AbortController().signal,
    );

    expect(replay.transcript).toEqual([
      {
        context: [
          {
            kind: 'passage',
            quote: 'The opening line.',
            source: { folderPath: '/project/Research', path: 'drafts/essay.md' },
          },
          { kind: 'transient', name: 'other.md', path: '/project/Plans/other.md' },
          {
            kind: 'transient',
            name: 'chart.png',
            path: '/tmp/chart.png',
            previewUrl: 'http://127.0.0.1:1/api/preview?p=chart',
          },
        ],
        id: 'user-1',
        kind: 'user',
        text: 'Is this clear?',
      },
    ]);
  });

  it('validates history, replay, and websocket events at the adapter seam', async () => {
    const historyClient = httpClient([
      {
        id: 'session-1',
        title: 'Research',
        lastModified: 42,
        hasContent: true,
        folder: '/Research',
      },
    ]);
    await expect(
      createAgentSessionAdapter(historyClient, 'http://127.0.0.1:1').list(
        'claude',
        { kind: 'folder', path: '/Research' },
        new AbortController().signal,
      ),
    ).resolves.toEqual([
      {
        agent: 'claude',
        hasContent: true,
        id: 'session-1',
        lastModified: 42,
        scope: { kind: 'folder', path: '/Research' },
        title: 'Research',
      },
    ]);
    expect(historyClient.request).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/agents/claude/sessions?folder=%2FResearch' }),
    );

    const malformed = createAgentSessionAdapter(
      httpClient({ protocol: 1, messages: [], effort: null }),
      'http://127.0.0.1:1',
    );
    await expect(
      malformed.replay(
        {
          agent: 'codex',
          hasContent: true,
          id: 'session-1',
          lastModified: 42,
          scope: { kind: 'folder', path: '/project/Research' },
          title: 'Research',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: 'invalid-response' });

    const invalid = vi.fn();
    const events: unknown[] = [];
    const messageListeners: Array<(event: { data: unknown }) => void> = [];
    const socket: {
      readyState: number;
      addEventListener(type: 'close', listener: () => void): void;
      addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
      removeEventListener(type: 'close', listener: () => void): void;
      removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
      close(): void;
      send(data: string): void;
    } = {
      readyState: 0,
      addEventListener(type, listener) {
        if (type === 'message') {
          messageListeners.push(listener as (event: { data: unknown }) => void);
        }
      },
      removeEventListener: () => undefined,
      close: () => undefined,
      send: () => undefined,
    };
    createAgentSessionAdapter(httpClient(), 'http://127.0.0.1:1', () => socket).connect(
      { agent: 'stashbase', scope: { kind: 'folder', path: '/project/Research' } },
      { onClose: vi.fn(), onEvent: (event) => events.push(event), onInvalidResponse: invalid },
    );
    messageListeners[0]?.({ data: JSON.stringify({ t: 'unknown' }) });
    messageListeners[0]?.({ data: JSON.stringify({ t: 'session-id', id: 'native-1' }) });
    messageListeners[0]?.({
      data: JSON.stringify({
        t: 'models',
        models: [{ id: 'native-model', label: 'Native model', supportedEfforts: ['high'] }],
        activeModel: 'native-model',
      }),
    });
    messageListeners[0]?.({
      data: JSON.stringify({
        t: 'skills',
        skills: [{ id: 'review', label: 'review', argumentHint: 'a file to review' }],
        state: 'available',
      }),
    });
    messageListeners[0]?.({
      data: JSON.stringify({ t: 'skills', skills: [], state: 'failed', error: 'No skill folder.' }),
    });
    expect(invalid).toHaveBeenCalledOnce();
    expect(events).toEqual([
      { id: 'native-1', kind: 'identified' },
      {
        activeModel: 'native-model',
        fallback: null,
        kind: 'models',
        models: [{ id: 'native-model', label: 'Native model', supportedEfforts: ['high'] }],
      },
      {
        error: null,
        kind: 'skills',
        skills: [{ id: 'review', label: 'review', argumentHint: 'a file to review' }],
        state: 'available',
      },
      { error: 'No skill folder.', kind: 'skills', skills: [], state: 'failed' },
    ]);
  });

  it('attributes folder-scoped history rows to the requested folder', async () => {
    const historyClient = httpClient([
      { hasContent: true, id: 'session-1', title: 'Research', lastModified: 42 },
    ]);

    await expect(
      createAgentSessionAdapter(historyClient, 'http://127.0.0.1:1').list(
        'codex',
        { kind: 'folder', path: '/Library/Research' },
        new AbortController().signal,
      ),
    ).resolves.toEqual([
      {
        agent: 'codex',
        hasContent: true,
        id: 'session-1',
        lastModified: 42,
        scope: { kind: 'folder', path: '/Library/Research' },
        title: 'Research',
      },
    ]);
  });

  it('normalizes tool and permission events and validates permission replies', () => {
    const events: unknown[] = [];
    const sent: string[] = [];
    let onMessage: ((event: { data: unknown }) => void) | undefined;
    const socket: {
      readyState: number;
      addEventListener(type: 'close', listener: () => void): void;
      addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
      removeEventListener(type: 'close', listener: () => void): void;
      removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
      close(): void;
      send(data: string): void;
    } = {
      readyState: 1,
      addEventListener(type, listener) {
        if (type === 'message') onMessage = listener;
      },
      removeEventListener: vi.fn(),
      close: vi.fn(),
      send: (data: string) => {
        sent.push(data);
      },
    };
    const connection = createAgentSessionAdapter(
      httpClient(),
      'http://127.0.0.1:1',
      () => socket,
    ).connect(
      { access: 'default', agent: 'codex', scope: { kind: 'folder', path: '/project/Research' } },
      { onClose: vi.fn(), onEvent: (event) => events.push(event), onInvalidResponse: vi.fn() },
    );

    onMessage?.({
      data: JSON.stringify({ t: 'tool', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }),
    });
    onMessage?.({
      data: JSON.stringify({
        t: 'permission',
        id: 'permission-1',
        toolUseId: 'tool-1',
        name: 'Bash',
        title: null,
        input: { command: 'pwd' },
      }),
    });
    expect(
      connection.send?.({
        allow: true,
        always: null,
        answers: null,
        id: 'permission-1',
        kind: 'reply-permission',
      }),
    ).toBe(true);
    expect(
      connection.send?.({
        allow: true,
        always: null,
        answers: { 'Which format?': 'Summary' },
        id: 'permission-2',
        kind: 'reply-permission',
      }),
    ).toBe(true);
    onMessage?.({
      data: JSON.stringify({
        t: 'file-diff',
        id: 'diff:1',
        file: 'notes.md',
        before: 'one\n',
        after: 'one\ntwo\n',
        additions: 1,
        deletions: 0,
      }),
    });

    expect(events).toEqual([
      { id: 'tool-1', input: { command: 'pwd' }, kind: 'tool-started', name: 'Bash' },
      {
        id: 'permission-1',
        input: { command: 'pwd' },
        kind: 'permission-requested',
        name: 'Bash',
        title: null,
        toolUseId: 'tool-1',
      },
      {
        additions: 1,
        after: 'one\ntwo\n',
        before: 'one\n',
        deletions: 0,
        id: 'diff:1',
        kind: 'file-changed',
        path: 'notes.md',
      },
    ]);
    expect(sent).toEqual([
      JSON.stringify({ t: 'permission-reply', id: 'permission-1', allow: true }),
      JSON.stringify({
        t: 'permission-reply',
        id: 'permission-2',
        allow: true,
        answers: { 'Which format?': 'Summary' },
      }),
    ]);
  });
});
