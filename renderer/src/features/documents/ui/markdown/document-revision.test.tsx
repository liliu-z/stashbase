/**
 * The review as the reader meets it: driven from the document runtime's
 * state, through the component's own props, over a real Milkdown editor.
 * `revision-engine.test.ts` proves what the diff plugin does; this proves the
 * surface and the domain agree about it.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createDocumentNavigationRuntime } from '@/features/documents/application/navigation-runtime';
import {
  changeDocumentText,
  createDocumentState,
  reconcileDocumentSource,
  type DocumentState,
} from '@/features/documents/domain/document';
import {
  publishDocumentRevisionCount,
  startDocumentRevision,
  type RevisionReview,
} from '@/features/documents/domain/revision';
import { textSource } from '@/test/fakes/documents';
import { settleMarkdownListener } from '@/test/milkdown';

import { MarkdownDocument } from './document';

const BASE = '# Title\n\nThe first line.\n\nThe second line.\n';
const PROPOSAL = '# Title\n\nThe line.\n\nThe second sentence.\n';
const VERSION = 'sha256:v1';

const scope = {
  generation: 1,
  id: 'tab-1',
  source: { folderPath: '/project/notes', path: 'plan.md' },
};

const review: RevisionReview = {
  baseVersion: VERSION,
  id: 'review-1',

  before: PROPOSAL,
};

function loaded(content = BASE): DocumentState {
  return reconcileDocumentSource(
    createDocumentState(scope, 'editable'),
    textSource({ content, version: VERSION }),
  );
}

/** The real runtime path minus its transport: domain transitions in, the
 *  component's props out, so the two cannot drift in this file. */
function Surface({
  base = BASE,
  onDocumentChange,
  proposal,
  reconciled,
}: {
  /** The document's own text. Only the case where a proposal spells the same
   *  document differently needs one that is not `BASE`. */
  base?: string | undefined;
  onDocumentChange?: ((value: string) => void) | undefined;
  /** Who offered the review; `turn` runs it in reverse. */
  proposal: string | null;
  reconciled?: string | undefined;
}) {
  const navigation = useRef(createDocumentNavigationRuntime('tab-1')).current;
  const [state, setState] = useState(() => loaded(base));

  useEffect(() => {
    if (proposal === null) return;
    setState((current) => {
      const started = startDocumentRevision(
        current,
        {
          ...review,
          before: proposal,
        },
        current.editor?.value ?? '',
      );
      return started.kind === 'started' ? started.state : current;
    });
  }, [proposal]);

  useEffect(() => {
    if (reconciled === undefined) return;
    setState((current) =>
      reconcileDocumentSource(current, textSource({ content: reconciled, version: 'sha256:v2' })),
    );
  }, [reconciled]);

  const editor = state.editor;
  return (
    <MarkdownDocument
      active
      canChangeMode
      dirty={editor !== null && editor.value !== editor.baseline}
      mode="writer"
      name="plan.md"
      navigation={navigation}
      onChange={(value) => {
        onDocumentChange?.(value);
        setState((current) => changeDocumentText(current, value));
      }}
      onModeChange={vi.fn()}
      onNavigate={vi.fn()}
      onOpenExternal={vi.fn(async () => true)}
      readOnly={false}
      revision={{
        onPending: (reviewId, pending) =>
          setState((current) => publishDocumentRevisionCount(current, reviewId, pending)),
        state: state.revision,
      }}
      source={scope.source}
      tabId="tab-1"
      value={editor?.value ?? base}
    />
  );
}

async function openSurface(props: Parameters<typeof Surface>[0]) {
  const view = render(<Surface {...props} />);
  await waitFor(() =>
    expect(
      screen
        .getByRole('document', { name: 'plan.md Markdown content' })
        .getAttribute('data-markdown-state'),
    ).toBe('ready'),
  );
  return view;
}

const acceptControls = () => screen.queryAllByRole('button', { name: 'Undo' });

afterEach(cleanup);

describe('a revision review on the Markdown surface', () => {
  it('opens from the document state and counts what is pending in the header', async () => {
    const { rerender } = await openSurface({ proposal: null });
    expect(screen.queryByRole('group', { name: 'Changes from this turn' })).toBeNull();
    expect(acceptControls()).toHaveLength(0);

    rerender(<Surface proposal={PROPOSAL} />);
    await waitFor(() => expect(acceptControls()).toHaveLength(2));
    expect(screen.getByRole('group', { name: 'Changes from this turn' })).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('2 changes from this turn');
  });

  it('counts down as changes are taken and ends when the last one is resolved', async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    await openSurface({ onDocumentChange: (value) => changes.push(value), proposal: PROPOSAL });
    await waitFor(() => expect(acceptControls()).toHaveLength(2));

    await user.click(acceptControls()[0] as HTMLElement);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('1 change from this turn'),
    );

    await user.click(acceptControls()[0] as HTMLElement);
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Changes from this turn' })).toBeNull(),
    );
    await act(settleMarkdownListener);

    expect(changes.at(-1)).toBe(PROPOSAL);
  });

  it('leaves the source untouched when the whole review is kept', async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    await openSurface({ onDocumentChange: (value) => changes.push(value), proposal: PROPOSAL });
    await waitFor(() => expect(acceptControls()).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'Keep all' }));
    await waitFor(() => expect(acceptControls()).toHaveLength(0));
    await act(settleMarkdownListener);

    expect(changes).toEqual([]);
    expect(screen.queryByRole('group', { name: 'Changes from this turn' })).toBeNull();
  });

  it('takes every remaining change at once', async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    await openSurface({ onDocumentChange: (value) => changes.push(value), proposal: PROPOSAL });
    await waitFor(() => expect(acceptControls()).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'Undo all' }));
    await act(settleMarkdownListener);

    expect(changes.at(-1)).toBe(PROPOSAL);
    expect(screen.queryByRole('group', { name: 'Changes from this turn' })).toBeNull();
  });

  it('holds a background reconcile off the text the review describes', async () => {
    await openSurface({ proposal: PROPOSAL, reconciled: '# Replaced from disk\n' });
    await waitFor(() => expect(acceptControls()).toHaveLength(2));

    // The decorations split the changed sentences, so the assertion is what
    // the disk copy would have replaced rather than a whole line of prose.
    const surface = screen.getByRole('document', { name: 'plan.md Markdown content' });
    expect(surface.textContent).not.toContain('Replaced from disk');
    expect(surface.textContent).toContain('The second lin');
    expect(screen.getByRole('status').textContent).toBe('2 changes from this turn');
  });

  it('ends a review whose proposal spells the same document differently', async () => {
    // Markdown has several spellings for one document, so the string
    // comparisons that refuse an identical proposal cannot catch this one. Left
    // open, the diff plugin holds the editor against nothing: it blocks every
    // edit and draws no control to end it. The reconcile landing below is the
    // observable proof the document is live again, since an open review is
    // exactly what holds one off.
    const setext = 'Title\n=====\n\nThe first line.\n\nThe second line.\n';
    const { rerender } = await openSurface({ base: setext, proposal: BASE });

    expect(acceptControls()).toHaveLength(0);
    expect(screen.queryByRole('group', { name: 'Changes from this turn' })).toBeNull();

    rerender(<Surface base={setext} proposal={BASE} reconciled="# Replaced from disk\n" />);
    await waitFor(() =>
      expect(
        screen.getByRole('document', { name: 'plan.md Markdown content' }).textContent,
      ).toContain('Replaced from disk'),
    );
  });

  it('strips a proposal frontmatter before the parser sees it', async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    await openSurface({
      onDocumentChange: (value) => changes.push(value),
      proposal: `---\ntitle: Plan\n---\n${PROPOSAL}`,
    });
    await waitFor(() => expect(acceptControls()).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'Undo all' }));
    await act(settleMarkdownListener);

    expect(changes.at(-1)).toBe(PROPOSAL);
  });

  it('restores the text from before the turn when a turn review is undone', async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    await openSurface({
      onDocumentChange: (value) => changes.push(value),
      proposal: PROPOSAL,
    });
    await waitFor(() => expect(acceptControls()).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'Undo all' }));
    await act(settleMarkdownListener);

    expect(changes.at(-1)).toBe(PROPOSAL);
  });
});
