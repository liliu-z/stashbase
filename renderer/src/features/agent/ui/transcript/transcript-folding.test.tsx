import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { AgentTranscriptBlock } from '@/features/agent/domain/session';
import { expectFocused } from '@/test/dom';

import { AgentTranscript } from './transcript';

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
