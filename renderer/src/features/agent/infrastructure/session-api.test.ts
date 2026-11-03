import { describe, expect, it, vi } from 'vite-plus/test';

import { AGENT_SESSION_CLOSE } from '@/protocols/websocket/agent-session';
import { httpClient } from '@/test/fakes/http';

import { createAgentSessionAdapter } from './session-api';

describe('Agent session API', () => {
  it('keeps a missing runtime distinct from a lost project or an unavailable history service', async () => {
    const scope = { kind: 'folder', path: '/Research' } as const;
    const signal = new AbortController().signal;
    for (const [status, code, kind] of [
      [412, 'AGENT_NOT_INSTALLED', 'installation-required'],
      [412, 'NO_FOLDER', 'scope-lost'],
      [500, 'AGENT_NOT_INSTALLED', 'unavailable'],
    ] as const) {
      const message =
        'Codex CLI not found. Install Codex in Settings → Agents to access its chats.';
      const adapter = createAgentSessionAdapter(
        {
          request: async () => ({ status, body: { code, error: message } }),
        },
        'http://127.0.0.1:1',
      );
      await expect(adapter.list('codex', scope, signal)).rejects.toMatchObject({
        kind,
        cause: { message },
      });
    }
  });

  it('recognizes explicit clean server retirement while retaining unexpected closes and prior failures', () => {
    for (const scenario of ['retired', 'unknown-clean', 'lost', 'failed'] as const) {
      let receive: (message: { data: unknown }) => void = vi.fn();
      let close: (event: Pick<CloseEvent, 'code' | 'reason' | 'wasClean'>) => void = vi.fn();
      const socket = {
        readyState: 1,
        addEventListener(type: string, listener: typeof receive | typeof close) {
          if (type === 'message') receive = listener as typeof receive;
          else close = listener as typeof close;
        },
        removeEventListener: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
      };
      const reportError = vi.fn();
      const onEvent = vi.fn();
      const onClose = vi.fn();
      createAgentSessionAdapter(
        { ...httpClient(), reportError },
        'http://127.0.0.1:1',
        () => socket,
      ).connect(
        { agent: 'claude', scope: { kind: 'folder', path: '/Research' } },
        { onEvent, onClose, onInvalidResponse: vi.fn() },
      );
      if (scenario === 'failed')
        receive({ data: JSON.stringify({ t: 'exit', message: 'Native runtime failed.' }) });
      close({
        code: scenario === 'lost' ? 1006 : AGENT_SESSION_CLOSE.code,
        reason: scenario === 'unknown-clean' ? '' : AGENT_SESSION_CLOSE.reason,
        wasClean: scenario !== 'lost',
      });
      expect(onClose).toHaveBeenCalledOnce();
      const expectedClose = scenario === 'retired' || scenario === 'failed';
      expect(reportError).toHaveBeenCalledTimes(expectedClose ? 0 : 1);
      expect(
        onEvent.mock.calls.map(([event]) => ({ kind: event.kind, message: event.message })),
      ).toEqual(
        expectedClose
          ? [{ kind: 'exited', message: scenario === 'retired' ? null : 'Native runtime failed.' }]
          : [],
      );
    }
  });

  it('does not label a consumer failure as a malformed server response', () => {
    let receive: (message: { data: unknown }) => void = vi.fn();
    const failure = new Error('Consumer failed while applying a valid text event');
    const invalid = vi.fn();
    const onEvent = vi.fn().mockImplementationOnce(() => {
      throw failure;
    });
    const socket = {
      readyState: 1,
      addEventListener(
        type: string,
        listener:
          | typeof receive
          | ((event?: Pick<CloseEvent, 'code' | 'reason' | 'wasClean'>) => void),
      ) {
        if (type === 'message') receive = listener as typeof receive;
      },
      removeEventListener: vi.fn(),
      close: vi.fn(),
      send: vi.fn(),
    };
    createAgentSessionAdapter(httpClient(), 'http://127.0.0.1:1', () => socket).connect(
      { agent: 'claude', scope: { kind: 'folder', path: '/Research' } },
      { onClose: vi.fn(), onEvent, onInvalidResponse: invalid },
    );
    expect(() => receive({ data: JSON.stringify({ t: 'text', delta: 'A valid reply' }) })).toThrow(
      failure,
    );
    expect(invalid).not.toHaveBeenCalled();
    receive({ data: JSON.stringify({ t: 'turn-end', isError: false }) });
    expect(onEvent).toHaveBeenLastCalledWith({ kind: 'turn-ended', isError: false });
    receive({
      data: JSON.stringify({
        t: 'exit',
        message: 'Not logged in',
        failure: { kind: 'auth-expired' },
      }),
    });
    expect(onEvent).toHaveBeenLastCalledWith({
      kind: 'exited',
      message: 'Not logged in',
      failure: 'auth-expired',
    });
  });

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
      telemetryConnectionId: expect.any(String),
      model: 'gpt-codex',
    });
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
        effort: 'high',
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
        effort: 'high',
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

    connection.send?.({
      kind: 'prompt',
      skill: null,
      text: 'Read the screenshot',
      attachments: ['/tmp/shot.png'],
    });
    expect(JSON.parse(sent.pop() ?? '{}')).toEqual({
      t: 'prompt',
      text: 'Read the screenshot',
      attachments: ['/tmp/shot.png'],
    });

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
        approvalScopes: ['session'],
      }),
    });
    expect(
      connection.send?.({
        allow: true,
        always: null,
        scope: 'session',
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
        approvalScopes: ['session'],
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
      JSON.stringify({ t: 'permission-reply', id: 'permission-1', allow: true, scope: 'session' }),
      JSON.stringify({
        t: 'permission-reply',
        id: 'permission-2',
        allow: true,
        answers: { 'Which format?': 'Summary' },
      }),
    ]);
  });
});

it('joins a disconnect to the new turn after an earlier server error on the same connection', () => {
  let message: (event: { data: unknown }) => void = vi.fn();
  let closed: (event?: Pick<CloseEvent, 'code' | 'reason' | 'wasClean'>) => void = vi.fn();
  let opened = '';
  const reportError = vi.fn();
  const socket = {
    readyState: 1,
    addEventListener(type: string, callback: typeof message | typeof closed) {
      if (type === 'message') message = callback as typeof message;
      if (type === 'close') closed = callback as typeof closed;
    },
    removeEventListener: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
  };
  const connection = createAgentSessionAdapter(
    { ...httpClient(), reportError },
    'http://localhost',
    (url) => {
      opened = url;
      return socket;
    },
  ).connect(
    { agent: 'stashbase', scope: { kind: 'folder', path: '/project' } },
    {
      onClose: vi.fn(),
      onEvent: vi.fn(),
      onInvalidResponse: vi.fn(),
    },
  );
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  connection.send?.({ kind: 'prompt', text: 'First', skill: null, telemetryTurnId: first });
  message({ data: JSON.stringify({ t: 'error', message: 'First failed' }) });
  message({ data: JSON.stringify({ t: 'turn-end', isError: true }) });
  connection.send?.({ kind: 'prompt', text: 'Second', skill: null, telemetryTurnId: second });
  closed({ code: 1006, reason: '', wasClean: false });
  expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'agent-connection', {
    turn_id: second,
    connection_id: new URL(opened).searchParams.get('telemetryConnectionId'),
    close_code: 1006,
    was_clean: false,
    close_initiator: 'unknown',
  });
  expect(JSON.stringify(reportError.mock.calls)).not.toContain(first);
});
