import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { expectFocused } from '@/test/dom';

import { AgentActivityGroup, AgentPermissionCard } from './activity';
import type { AgentToolBlock } from './tool-presentation';

const command: AgentToolBlock = {
  id: 'tool-1',
  input: { command: 'pnpm test:agent' },
  kind: 'tool',
  name: 'Bash',
  status: 'running',
};

afterEach(cleanup);

describe('Agent activity', () => {
  it.each(['running', 'done', 'error'] as const)(
    'omits tool failures from chat when the next call is %s',
    async (status) => {
      const failed: AgentToolBlock = {
        id: 'failed-edit',
        input: { path: '/project/plan.md', old_text: 'Draft.', new_text: '' },
        kind: 'tool',
        name: 'stashbase_edit_file',
        result: 'EDIT_MISMATCH: old_text not found',
        status: 'error',
      };
      render(
        <AgentActivityGroup
          steps={[
            failed,
            {
              ...failed,
              id: 'next-edit',
              input: { path: '/project/plan.md', old_text: 'Draft。', new_text: 'Revised。' },
              result: status === 'error' ? 'FILE_CHANGED' : undefined,
              status,
            },
          ]}
        />,
      );

      expect(screen.queryByRole('button', { name: /plan\.md.*Failed/u })).toBeNull();
      expect(screen.queryByRole('list', { name: 'Changed files' }) !== null).toBe(
        status === 'done',
      );
      expect(screen.queryByRole('button') === null).toBe(status === 'error');
      if (status !== 'error') {
        await userEvent.click(
          screen.getByRole('button', {
            name: status === 'running' ? 'Edited plan.md…' : 'Edited file',
            expanded: false,
          }),
        );
      }
      expect(screen.queryByRole('button', { name: /plan\.md.*(Running|Done)/u }) !== null).toBe(
        status !== 'error',
      );
      expect(screen.queryByRole('button', { name: /Failed/u })).toBeNull();
      expect(screen.queryByText(/EDIT_MISMATCH|FILE_CHANGED/u)).toBeNull();
      expect(screen.queryByLabelText('stashbase_edit_file result')).toBeNull();
    },
  );

  it('keeps ordinary activity collapsed behind an accessible disclosure', async () => {
    render(<AgentActivityGroup steps={[command]} />);

    const summary = screen.getByRole('button', { name: 'Ran pnpm test:agent…' });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Ran.*pnpm test:agent.*Running/u })).not.toBeNull();
  });

  it('presents a permission as an explicit decision and restores focus to its heading', async () => {
    const onReply = vi.fn(() => true);
    const { rerender } = render(
      <AgentPermissionCard
        onReply={onReply}
        tool={{
          ...command,
          permissionId: 'permission-1',
          permissionRequested: true,
          status: 'awaiting',
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReply).toHaveBeenCalledWith('tool-1', 'permission-1', false);
    rerender(
      <AgentPermissionCard
        onReply={onReply}
        tool={{ ...command, permissionRequested: true, status: 'denied' }}
      />,
    );
    const heading = screen.getByRole('heading', { name: 'Run this command?' });
    await waitFor(() => expectFocused(heading));
    expect(screen.getByRole('status').textContent).toBe('Denied');
  });

  it('shows the diff behind a file-change decision instead of raw arguments', async () => {
    const { container } = render(
      <AgentPermissionCard
        onReply={vi.fn(() => true)}
        tool={{
          id: 'edit-1',
          input: {
            file_path: '/project/Research/notes.md',
            new_string: 'Accepted: use Screely.',
            old_string: 'Undecided.',
          },
          kind: 'tool',
          name: 'Edit',
          permissionId: 'permission-2',
          permissionRequested: true,
          permissionTitle: null,
          status: 'awaiting',
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Apply these changes?' })).not.toBeNull();
    expect(screen.queryByLabelText('Edit arguments')).toBeNull();
    expect(screen.getByRole('region', { name: 'Edited notes.md' })).not.toBeNull();
    await waitFor(() => {
      expect(container.querySelector('.cm-deletedChunk')?.textContent).toContain('Undecided.'); // dom-contract: CodeMirror internals
      expect(container.querySelector('.cm-changedLine')?.textContent).toContain('Accepted'); // dom-contract: CodeMirror internals
    });
    expect(screen.getByRole('button', { name: 'Allow' })).not.toBeNull();
  });

  it('lists what settled work changed, with Open only for files inside the scope', async () => {
    const onOpenSource = vi.fn();
    render(
      <AgentActivityGroup
        onOpenSource={onOpenSource}
        sourceFor={(path) =>
          path.startsWith('/project/Research/')
            ? { folderPath: '/project/Research', path: path.slice('/project/Research/'.length) }
            : null
        }
        steps={[
          {
            id: 'write-1',
            input: { content: '# Plan', file_path: '/project/Research/plan.md' },
            kind: 'tool',
            name: 'Write',
            status: 'done',
          },
          {
            id: 'diff-1',
            input: { additions: 1, after: 'x\n', before: '', deletions: 0, path: 'notes.md' },
            kind: 'tool',
            name: 'FileDiff',
            status: 'done',
          },
          {
            id: 'write-2',
            input: { content: 'nope', file_path: '/project/Research/denied.md' },
            kind: 'tool',
            name: 'Write',
            status: 'denied',
          },
        ]}
      />,
    );

    const list = screen.getByRole('list', { name: 'Changed files' });
    expect(list.textContent).toContain('plan.md');
    expect(list.textContent).toContain('notes.md');
    expect(list.textContent).not.toContain('denied.md');
    expect(screen.queryByRole('button', { name: 'Open notes.md' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open plan.md' }));
    expect(onOpenSource).toHaveBeenCalledWith(
      { folderPath: '/project/Research', path: 'plan.md' },
      null,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edited files', expanded: false }));
    expect(screen.getByRole('button', { name: /Changed.*notes\.md.*Done/u })).not.toBeNull();
  });
});
