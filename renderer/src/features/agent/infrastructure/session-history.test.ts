import { describe, expect, it } from 'vite-plus/test';

import { httpClient } from '@/test/fakes/http';

import { createAgentSessionAdapter } from './session-api';

describe('Agent session history', () => {
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
});
