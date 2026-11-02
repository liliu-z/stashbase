import { cleanup, render, screen, within } from '@testing-library/react';
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

  it('hides Copy while the turn streams and copies original math source afterwards', async () => {
    const user = userEvent.setup();
    const text = String.raw`Price \$10: \(x^2\).` + '\n\n$$\n\\frac{1}{2}\n$$';
    const mathTurn: AgentTranscriptBlock[] = [
      ...turn.slice(0, -1),
      { id: 'a2', kind: 'assistant', text },
    ];
    const { rerender } = renderTranscript(mathTurn, true);
    expect(screen.queryByRole('button', { name: 'Copy response' })).toBeNull();
    rerender(
      <AgentTranscript
        activeTurn={false}
        blocks={mathTurn}
        onOpenExternal={vi.fn()}
        onPermission={vi.fn(() => true)}
        onRetry={vi.fn(() => true)}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Copy response' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Copy response' }));
    expect(await navigator.clipboard.readText()).toBe(text);
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
