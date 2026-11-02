import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { AgentTranscriptBlock } from '@/features/agent/domain/session';
import { expectFocused } from '@/test/dom';

import { AgentTranscript, closingReplies } from './transcript';

const turn: AgentTranscriptBlock[] = [
  { id: 'u1', kind: 'user', text: 'Map the repo' },
  { id: 'a1', kind: 'assistant', text: 'I will read the orientation files first.' },
  { id: 'th1', kind: 'thinking', text: 'Listing top-level entries' },
  { id: 't1', input: { command: 'ls' }, kind: 'tool', name: 'Bash', status: 'done' },
  { id: 'a2', kind: 'assistant', text: 'It is a small learning project.' },
];

afterEach(cleanup);

const longTurn = (count = 9): AgentTranscriptBlock[] => [
  { id: 'prompt', kind: 'user', text: 'Research this draft' },
  ...Array.from({ length: count }, (_, index): AgentTranscriptBlock => ({
    id: `progress-${index}`,
    kind: 'assistant',
    text: `Progress ${index + 1}`,
  })),
  { id: 'answer', kind: 'assistant', text: 'The completed draft', turnOutcome: 'completed' },
];

describe('completed turn process folding', () => {
  const props = { onOpenExternal: vi.fn(), onPermission: () => true, onRetry: () => true };

  it('folds more than eight process messages, keeps the result, and remembers manual expansion for this chat', async () => {
    const scope = {};
    const view = () => (
      <AgentTranscript {...props} activeTurn={false} blocks={longTurn()} disclosureScope={scope} />
    );
    const mounted = render(view());
    expect(screen.getByText('Research this draft')).not.toBeNull();
    expect(screen.getByText('The completed draft')).not.toBeNull();
    await waitFor(() => expect(screen.queryByText('Progress 1')).toBeNull());
    const toggle = screen.getByRole('button', { name: 'Show 9 process messages', expanded: false });
    await userEvent.click(toggle);
    expect(screen.getByText('Progress 1')).not.toBeNull();
    expect(screen.getByText('Progress 9')).not.toBeNull();
    mounted.unmount();
    const reopened = render(view());
    expect(
      screen.getByRole('button', { name: 'Hide 9 process messages', expanded: true }),
    ).not.toBeNull();
    expect(screen.getByText('Progress 9')).not.toBeNull();
    reopened.rerender(
      <AgentTranscript {...props} activeTurn={false} blocks={longTurn()} disclosureScope={{}} />,
    );
    await waitFor(() => expect(screen.queryByText('Progress 1')).toBeNull());
    reopened.rerender(view());
    expect(screen.getByText('Progress 1')).not.toBeNull();
  });

  it('counts routine activity as one visible message and exposes a notification target inside folded work', async () => {
    const blocks = longTurn(8);
    blocks.splice(
      3,
      0,
      {
        id: 'read',
        kind: 'tool',
        name: 'Read',
        input: { file_path: '/project/draft.md' },
        status: 'done',
      },
      { id: 'search', kind: 'tool', name: 'Search', input: { pattern: 'draft' }, status: 'done' },
    );
    const mounted = render(<AgentTranscript {...props} activeTurn={false} blocks={blocks} />);
    expect(screen.getByRole('button', { name: 'Show 9 process messages' })).not.toBeNull();
    mounted.rerender(
      <AgentTranscript {...props} activeTurn={false} blocks={blocks} focusBlockId="progress-0" />,
    );
    expect(screen.getByText('Progress 1')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Hide 9 process messages' })).not.toBeNull();
  });

  it('leaves eight messages, running work, stopped work and unclassified history expanded', () => {
    const mounted = render(<AgentTranscript {...props} activeTurn={false} blocks={longTurn(8)} />);
    expect(screen.queryByRole('button', { name: /process messages/u })).toBeNull();
    for (const outcome of ['completed', 'stopped', 'failed', undefined] as const) {
      const blocks = longTurn();
      blocks[blocks.length - 1] = {
        id: 'answer',
        kind: 'assistant',
        text: 'A partial reply',
        turnOutcome: outcome,
      };
      mounted.rerender(
        <AgentTranscript {...props} activeTurn={outcome === 'completed'} blocks={blocks} />,
      );
      expect(screen.getByText('Progress 1')).not.toBeNull();
      expect(screen.queryByRole('button', { name: /process messages/u })).toBeNull();
    }
  });

  it('does not fold underneath a reader who left the end, even if they later return', () => {
    let following = false;
    const view = (activeTurn: boolean) => (
      <AgentTranscript
        {...props}
        activeTurn={activeTurn}
        blocks={longTurn()}
        canFoldProcess={() => following}
      />
    );
    const mounted = render(view(true));
    mounted.rerender(view(false));
    expect(
      screen.getByRole('button', { name: 'Hide 9 process messages', expanded: true }),
    ).not.toBeNull();
    following = true;
    mounted.rerender(view(false));
    expect(screen.getByText('Progress 1')).not.toBeNull();
  });

  it('keeps keyboard focus inside the process when the running turn completes', () => {
    const blocks = longTurn();
    blocks[1] = {
      id: 'progress-0',
      kind: 'assistant',
      text: '[Inspect the source](https://example.com)',
    };
    const mounted = render(<AgentTranscript {...props} activeTurn blocks={blocks} />);
    const link = screen.getByRole('link', { name: 'Inspect the source' });
    link.focus();
    mounted.rerender(<AgentTranscript {...props} activeTurn={false} blocks={blocks} />);
    expectFocused(link);
    expect(
      screen.getByRole('button', { name: 'Hide 9 process messages', expanded: true }),
    ).not.toBeNull();
  });

  it('keeps accepted follow-ups and file results outside the folded process, in their original order', async () => {
    const blocks = longTurn();
    blocks.splice(5, 0, {
      id: 'follow-up',
      kind: 'user',
      text: 'Also check the sources',
      followUp: true,
    });
    blocks.push({
      kind: 'turn-changes',
      id: 'files',
      turnId: 'turn',
      files: [{ path: '/project/draft.md', change: 'edited', additions: 3, deletions: 1 }],
    });
    render(<AgentTranscript {...props} activeTurn={false} blocks={blocks} />);
    expect(screen.getByText('Also check the sources')).not.toBeNull();
    expect(screen.getByText('draft.md')).not.toBeNull();
    await waitFor(() => expect(screen.queryByText('Progress 1')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Show 9 process messages' }));
    expect(screen.getByText('Progress 9')).not.toBeNull();
  });

  it('expands the whole long turn across the transcript page boundary', async () => {
    render(<AgentTranscript {...props} activeTurn={false} blocks={longTurn(205)} />);
    expect(screen.queryByRole('button', { name: 'Show earlier messages' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show 205 process messages' }));
    expect(screen.getByText('Progress 1')).not.toBeNull();
    expect(screen.getByText('Progress 205')).not.toBeNull();
  });

  it('reveals the preceding turn on the first earlier-messages click after a very long turn', async () => {
    render(
      <AgentTranscript
        {...props}
        activeTurn={false}
        blocks={[
          { id: 'old-prompt', kind: 'user', text: 'An earlier request' },
          { id: 'old-reply', kind: 'assistant', text: 'An earlier reply' },
          ...longTurn(405),
        ]}
      />,
    );
    expect(screen.queryByText('An earlier request')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show earlier messages' }));
    expect(screen.getByText('An earlier request')).not.toBeNull();
    expect(screen.getByText('An earlier reply')).not.toBeNull();
  });
});

function renderTranscript(blocks: AgentTranscriptBlock[], activeTurn: boolean) {
  return render(
    <AgentTranscript
      activeTurn={activeTurn}
      blocks={blocks}
      onOpenExternal={vi.fn()}
      onPermission={vi.fn(() => true)}
      onRetry={vi.fn(() => true)}
    />,
  );
}

it('keeps a terminal turn failure visible while tool failures are omitted', () => {
  renderTranscript(
    [
      ...turn.slice(0, 2),
      {
        id: 'failed-tool',
        kind: 'tool',
        name: 'Bash',
        input: { command: 'ls' },
        status: 'error',
        result: 'Permission denied',
      },
      {
        id: 'turn-error',
        kind: 'error',
        text: 'Connection lost',
        failure: 'network',
        retryablePrompt: 'Map the repo',
      },
    ],
    false,
  );
  expect(screen.getByRole('heading', { name: 'The agent could not finish' })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull();
  expect(screen.queryByRole('button', { name: /Ran.*ls.*Failed/u })).toBeNull();
});

it('offers the runtime update instead of a retry on a turn the runtime was too old for, then a retry once it ran', async () => {
  const update = vi.fn();
  const refused: AgentTranscriptBlock[] = [
    { id: 'u1', kind: 'user', text: 'Map the repo' },
    {
      id: 'too-old',
      kind: 'error',
      text: 'API Error: 400 Claude Code 2.1.220 does not support this model',
      failure: 'runtime-outdated',
      retryablePrompt: 'Map the repo',
    },
  ];
  const view = (completedBlockId: string | null) => (
    <AgentTranscript
      activeTurn={false}
      blocks={refused}
      onOpenExternal={vi.fn()}
      onPermission={vi.fn(() => true)}
      onRetry={vi.fn(() => true)}
      runtimeUpdate={{
        busy: false,
        completed: false,
        completedBlockId,
        failure: null,
        label: 'Claude',
        progress: null,
        update,
      }}
    />
  );
  const rendered = render(view(null));

  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Update Claude' }));
  expect(update).toHaveBeenCalledWith('too-old');

  rendered.rerender(view('too-old'));
  expect(screen.queryByRole('button', { name: 'Update Claude' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull();
});

it('offers a model refresh, and a manual retry only after it, when the hosted model changed', async () => {
  const refresh = vi.fn();
  const onRetry = vi.fn(() => true);
  const refused: AgentTranscriptBlock[] = [
    { id: 'u1', kind: 'user', text: 'Draft the intro' },
    {
      id: 'changed',
      kind: 'error',
      text: 'The selected model configuration has changed. Refresh the models, then review and send again.',
      failure: 'model-changed',
      retryablePrompt: 'Draft the intro',
    },
  ];
  const view = (refreshedBlockId: string | null) => (
    <AgentTranscript
      activeTurn={false}
      blocks={refused}
      modelRefresh={{ busy: false, failure: null, refresh, refreshedBlockId }}
      onOpenExternal={vi.fn()}
      onPermission={vi.fn(() => true)}
      onRetry={onRetry}
    />
  );
  const rendered = render(view(null));

  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh models' }));
  expect(refresh).toHaveBeenCalledWith('changed');
  // Refreshing never sends anything by itself.
  expect(onRetry).not.toHaveBeenCalled();

  rendered.rerender(view('changed'));
  expect(screen.queryByRole('button', { name: 'Refresh models' })).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  expect(onRetry).toHaveBeenCalledWith('changed');
});

it('keeps progress visible after a running tool fails and disappears', () => {
  const blocks: AgentTranscriptBlock[] = [
    ...turn.slice(0, 2),
    { id: 'edit', kind: 'tool', name: 'Edit', input: {}, status: 'running' },
  ];
  const props = {
    activeTurn: true,
    onOpenExternal: vi.fn(),
    onPermission: vi.fn(() => true),
    onRetry: vi.fn(() => true),
  };
  const { rerender } = render(<AgentTranscript {...props} blocks={blocks} />);
  expect(screen.queryByRole('status')).toBeNull();
  rerender(
    <AgentTranscript
      {...props}
      blocks={[
        ...blocks.slice(0, -1),
        { id: 'edit', kind: 'tool', name: 'Edit', input: {}, status: 'error' },
      ]}
    />,
  );
  expect(screen.getByRole('status').textContent).toContain('Thinking');
  expect(screen.queryByRole('button', { name: /Edited file/u })).toBeNull();
});

it('keeps the work moving in the header between two tool calls', () => {
  // The reported frozen frame: the turn is still running but nothing is, so a
  // header that only counted settled calls held still and the indicator was
  // suppressed by the group that was supposed to narrate.
  renderTranscript(turn.slice(0, 4), true);

  expect(screen.getByRole('button', { name: 'Ran ls…', expanded: false })).not.toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

it('returns the header to the settled group once the turn ends', () => {
  renderTranscript(turn, false);

  expect(screen.getByRole('button', { name: 'Ran command', expanded: false })).not.toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

it('lets a decision card speak for itself instead of the indicator', () => {
  renderTranscript(
    [
      ...turn.slice(0, 2),
      {
        id: 'ask',
        input: { command: 'rm -rf build' },
        kind: 'tool',
        name: 'Bash',
        permissionId: 'permission-1',
        permissionRequested: true,
        status: 'awaiting',
      },
    ],
    true,
  );

  expect(screen.getByRole('heading', { name: 'Run this command?' })).not.toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

describe('Agent transcript time cues', () => {
  it('shows a day divider only where consecutive prompts change day, and a hover time per prompt', () => {
    // Pinned, so the cue below is a literal the reader would see rather than
    // whatever the formatter happens to answer for the machine's clock.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 9, 15, 30));
    const now = Date.now();
    const yesterday = now - 86_400_000;
    renderTranscript(
      [
        { at: yesterday, id: 'u1', kind: 'user', text: 'Start' },
        { id: 'a1', kind: 'assistant', text: 'Sure.' },
        { at: now, id: 'u2', kind: 'user', text: 'Continue' },
        { id: 'a2', kind: 'assistant', text: 'Done.' },
      ],
      false,
    );
    const separators = screen.getAllByRole('separator');
    expect(separators.map((node) => node.getAttribute('aria-label'))).toEqual(['Today']);
    expect(screen.getByText(/^3:30\s?PM$/u)).not.toBeNull();
    vi.useRealTimers();
  });

  it('shows when a settled reply finished and how long its turn took', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 9, 15, 30));
    const now = Date.now();
    renderTranscript(
      [
        { at: now - 12_000, id: 'u1', kind: 'user', text: 'Start' },
        { at: now, id: 'a1', kind: 'assistant', text: 'Done.' },
      ],
      false,
    );
    expect(screen.getByText(/^3:30\s?PM · 12s$/u)).not.toBeNull();
    vi.useRealTimers();
  });
});

describe('Agent transcript permission decisions', () => {
  it.each(['Allow', 'Reject'] as const)(
    'folds %s into its summary without scrolling to the start of the turn',
    async (decision) => {
      const onPermission = vi.fn(() => true);
      const ask: AgentTranscriptBlock = {
        id: 'tool-2',
        input: { content: '# Plan', file_path: '/project/Research/plan.md' },
        kind: 'tool',
        name: 'Write',
        permissionId: 'permission-1',
        permissionRequested: true,
        permissionTitle: null,
        status: 'awaiting',
      };
      const { rerender } = render(
        <AgentTranscript
          activeTurn
          blocks={[...turn, ask]}
          onOpenExternal={vi.fn()}
          onPermission={onPermission}
          onRetry={vi.fn(() => true)}
        />,
      );
      expect(screen.getByRole('heading', { name: 'Apply these changes?' })).not.toBeNull();

      const summary = screen.getByRole('button', { name: 'Ran command', expanded: false });
      const focus = vi.spyOn(summary, 'focus');
      await userEvent.click(screen.getByRole('button', { name: decision }));
      expect(onPermission).toHaveBeenCalledWith('tool-2', 'permission-1', decision === 'Allow');
      rerender(
        <AgentTranscript
          activeTurn
          blocks={[
            ...turn,
            {
              ...ask,
              permissionId: undefined,
              status: decision === 'Allow' ? 'running' : 'denied',
            },
          ]}
          onOpenExternal={vi.fn()}
          onPermission={onPermission}
          onRetry={vi.fn(() => true)}
        />,
      );

      expect(screen.queryByRole('heading', { name: 'Apply these changes?' })).toBeNull();
      // The group precedes the intervening reply, so focusing its summary must
      // not pull the viewport away from the decision the reader just made.
      expectFocused(summary);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      await userEvent.click(summary);
      expect(
        screen.getByRole('button', { name: /Wrote.*plan\.md.*(Running|Denied)/u }),
      ).not.toBeNull();
      expect(screen.queryByRole('list', { name: 'Changed files' })).toBeNull();
    },
  );
});

describe('Agent transcript copy affordance', () => {
  it('marks only the closing reply of each settled turn, with when its prompt went out', () => {
    expect([...closingReplies(turn, true)]).toEqual([]);
    expect([...closingReplies(turn, false)]).toEqual([['a2', undefined]]);
    const closing = turn[4];
    if (!closing) throw new Error('The fixture turn has no closing reply.');
    const twoTurns = [
      ...turn,
      { at: 1_000, id: 'u2', kind: 'user', text: 'Go on' } as const,
      { ...closing, id: 'a3' },
    ];
    expect([...closingReplies(twoTurns, true)]).toEqual([['a2', undefined]]);
    expect([...closingReplies(twoTurns, false)]).toEqual([
      ['a2', undefined],
      ['a3', 1_000],
    ]);
  });

  it('hides Copy while the turn streams and shows one afterwards', () => {
    const { rerender } = renderTranscript(turn, true);
    expect(screen.queryByRole('button', { name: 'Copy response' })).toBeNull();
    rerender(
      <AgentTranscript
        activeTurn={false}
        blocks={turn}
        onOpenExternal={vi.fn()}
        onPermission={vi.fn(() => true)}
        onRetry={vi.fn(() => true)}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Copy response' })).toHaveLength(1);
  });
});

describe('Agent transcript prompt actions', () => {
  const twoTurns: AgentTranscriptBlock[] = [
    ...turn,
    { id: 'u2', kind: 'user', text: 'Go on' },
    { id: 'a3', kind: 'assistant', text: 'Sure.' },
  ];

  it('offers copy on every prompt and edit only on the latest one once its turn settles', async () => {
    const onEditPrompt = vi.fn();
    const transcript = (activeTurn: boolean) => (
      <AgentTranscript
        activeTurn={activeTurn}
        blocks={twoTurns}
        onEditPrompt={onEditPrompt}
        onOpenExternal={vi.fn()}
        onPermission={vi.fn(() => true)}
        onRetry={vi.fn(() => true)}
      />
    );
    const { rerender } = render(transcript(true));
    expect(screen.getAllByRole('button', { name: 'Copy message' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Reuse message' })).toBeNull();

    rerender(transcript(false));
    const edit = screen.getAllByRole('button', { name: 'Reuse message' });
    expect(edit).toHaveLength(1);
    await userEvent.click(edit[0] as HTMLElement);
    expect(onEditPrompt).toHaveBeenCalledWith('u2');
  });

  it('renders no edit control when nothing can take the prompt back', () => {
    renderTranscript(twoTurns, false);
    expect(screen.queryByRole('button', { name: 'Reuse message' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Copy message' })).toHaveLength(2);
  });
});

describe('Agent transcript context', () => {
  it('shows sent context as chips and file mentions inline', () => {
    renderTranscript(
      [
        {
          context: [
            {
              boundVersion: 3,
              format: 'md',
              kind: 'source',
              source: { folderPath: '/Library/Research', path: 'docs/a.md' },
            },
            {
              boundVersion: null,
              format: 'pdf',
              kind: 'source',
              source: { folderPath: '/Library/Research', path: 'docs/b.pdf' },
            },
            { kind: 'transient', name: 'shot.png', path: '/tmp/attach/shot.png' },
          ],
          id: 'u1',
          kind: 'user',
          text: 'Read @docs/a.md and /tmp/attach/shot.png please',
        },
      ],
      false,
    );
    // The mentioned source reads inline only; the dropped one and the upload
    // share the tile row above the bubble.
    const tiles = screen.getByRole('group', { name: 'Sent attachments' });
    expect(within(tiles).getByRole('img', { name: 'b.pdf' })).not.toBeNull();
    expect(within(tiles).queryByRole('img', { name: 'a.md' })).toBeNull();
    expect(within(tiles).getByRole('img', { name: 'shot.png' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/u })).toBeNull();
    expect(screen.getByText('(file mention: docs/a.md)', { exact: false })).not.toBeNull();
    expect(
      screen.getByText('(file mention: /tmp/attach/shot.png)', { exact: false }),
    ).not.toBeNull();
    const inline = screen.getByText('(file mention: docs/a.md)', { exact: false }).parentElement;
    expect(inline?.tagName).toBe('SPAN');
    expect(inline?.textContent).toContain('a.md');
  });

  it('rehydrates replayed attachments as tiles, with a server preview when one exists', () => {
    renderTranscript(
      [
        {
          attachments: [
            { name: 'report.pdf', path: '/Users/me/notes/report.pdf' },
            {
              name: 'shot.png',
              path: '/tmp/attach/shot.png',
              previewUrl: 'https://127.0.0.1:43123/api/agent/attachment-preview?path=x',
            },
          ],
          id: 'u1',
          kind: 'user',
          text: 'Summarise this',
        },
      ],
      false,
    );
    const tiles = screen.getByRole('group', { name: 'Sent attachments' });
    expect(within(tiles).getByRole('img', { name: 'report.pdf' })).not.toBeNull();
    expect(within(tiles).getByRole('img', { name: 'shot.png' }).getAttribute('src')).toContain(
      'attachment-preview',
    );
  });
});

it('folds a long prompt behind Show more and opens it again with Show less', async () => {
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(900);
  try {
    renderTranscript([{ id: 'u1', kind: 'user', text: 'A long brief' }], false);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getByRole('button', { name: 'Show more' })).not.toBeNull();
  } finally {
    height.mockRestore();
  }
});

it('leaves a short prompt open with no fold control', () => {
  renderTranscript([{ id: 'u1', kind: 'user', text: 'Map the repo' }], false);
  expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
});

it('locates passage references in sent messages and unread follow-ups', async () => {
  const user = userEvent.setup();
  const onOpenSource = vi.fn();
  const source = { folderPath: '/project', path: 'essay.md' };
  const context = [{ kind: 'passage' as const, source, quote: 'Opening words' }];
  render(
    <AgentTranscript
      activeTurn
      blocks={[{ id: 'u', kind: 'user', text: 'Revise', context }]}
      pending={[{ id: 'p', text: 'Also revise', context }]}
      onOpenExternal={vi.fn()}
      onOpenSource={onOpenSource}
      onPermission={vi.fn(() => true)}
      onRetry={vi.fn(() => true)}
    />,
  );
  const references = screen.getAllByRole('button', {
    name: 'Locate passage in essay.md: Opening words',
  });
  expect(references).toHaveLength(2);
  for (const reference of references) await user.click(reference);
  expect(onOpenSource).toHaveBeenCalledTimes(2);
  expect(onOpenSource).toHaveBeenLastCalledWith(source, 'Opening words', 'markdown');
});
