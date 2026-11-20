import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { AgentTurnChangedFile } from '@/features/agent/domain/session';

import { AgentTurnChangesCard } from './turn-changes-card';

afterEach(cleanup);

const folderPath = '/project/notes';
const files: AgentTurnChangedFile[] = [
  { additions: 3, change: 'edited', deletions: 1, path: `${folderPath}/drafts/plan.md` },
  { additions: 5, change: 'created', deletions: 0, path: `${folderPath}/summary.md` },
  { additions: 0, change: 'deleted', deletions: 4, path: `${folderPath}/old.md` },
];
const sourceFor = (path: string) =>
  path.startsWith(`${folderPath}/`)
    ? { folderPath, path: path.slice(folderPath.length + 1) }
    : null;

describe('the changed-in-this-turn card', () => {
  it('offers Review for an edit, Open for a new file and nothing for a deletion', async () => {
    const onReviewTurnChange = vi.fn();
    const onOpenSource = vi.fn();
    render(
      <AgentTurnChangesCard
        files={files}
        onOpenSource={onOpenSource}
        onReviewTurnChange={onReviewTurnChange}
        sourceFor={sourceFor}
        turnId="turn-1"
      />,
    );

    expect(screen.getByRole('region', { name: 'Changed 3 files' })).not.toBeNull();
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Review changes to plan.md', 'Open summary.md']);
    expect(screen.getByText('Deleted')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Review changes to plan.md' }));
    expect(onReviewTurnChange).toHaveBeenCalledWith({
      source: { folderPath, path: 'drafts/plan.md' },
      turnId: 'turn-1',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Open summary.md' }));
    expect(onOpenSource).toHaveBeenCalledWith({ folderPath, path: 'summary.md' }, null);
  });

  it('names a deleted file by its project folder although it is no longer listed', () => {
    render(
      <AgentTurnChangesCard
        files={[
          { additions: 0, change: 'deleted', deletions: 4, path: `${folderPath}/old/plan.md` },
        ]}
        projectPathFor={(path) => path.slice(folderPath.length + 1)}
        sourceFor={() => null}
        turnId="turn-1"
      />,
    );

    expect(screen.getByText('old/').closest('[title]')?.getAttribute('title')).toBe(
      `${folderPath}/old/plan.md`,
    );
    expect(screen.getByRole('region', { name: 'Changed 1 file' }).textContent).not.toContain(
      folderPath,
    );
  });

  it('previews three files, expands the remaining files, and collapses without losing actions', async () => {
    const onReviewTurnChange = vi.fn();
    render(
      <AgentTurnChangesCard
        files={[
          ...files,
          { additions: 7, change: 'edited', deletions: 2, path: `${folderPath}/fourth.md` },
          { additions: 1, change: 'created', deletions: 0, path: `${folderPath}/fifth.md` },
        ]}
        onReviewTurnChange={onReviewTurnChange}
        sourceFor={sourceFor}
        turnId="turn-2"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Changed 5 files' })).not.toBeNull();
    expect(screen.getByLabelText('16 added, 7 removed')).not.toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText('fourth.md')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show 2 more files', expanded: false });
    await userEvent.click(toggle);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Collapse files', expanded: true })).toBe(toggle);
    await userEvent.click(screen.getByRole('button', { name: 'Review changes to fourth.md' }));
    expect(onReviewTurnChange).toHaveBeenCalledWith({
      source: { folderPath, path: 'fourth.md' },
      turnId: 'turn-2',
    });
    await userEvent.click(toggle);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText('fourth.md')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 2 more files', expanded: false })).toBe(toggle);
  });

  it('offers no control for a file outside the chat folder', () => {
    render(
      <AgentTurnChangesCard
        files={[{ additions: 1, change: 'edited', deletions: 0, path: '/elsewhere/plan.md' }]}
        onReviewTurnChange={vi.fn()}
        sourceFor={sourceFor}
        turnId="turn-1"
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });
});
