/** The composer's bound context: `@` suggestions and the chips they insert,
 *  visual sources as tiles reading their preparation state, dropped and pasted
 *  files, and the send a stale source refuses. */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { SOURCE_DRAG_MIME } from '@/shared/utils/source-drag';
import { draftOf, pressKey, typeInto } from '@/test/dom';
import {
  agentGateLifted,
  agentContextPort,
  agentSessionPort,
  idleAgentSessionPort,
} from '@/test/fakes/agent';

import { registerWorkspaceCleanup, renderWorkspace, RESEARCH_SCOPE } from './workspace.harness';

registerWorkspaceCleanup();

beforeEach(() => {
  // The image tile needs a stable object URL so a test can name the preview
  // it expects; `restoreMocks` puts the real implementation back afterwards.
  vi.spyOn(URL, 'createObjectURL').mockImplementation((source) =>
    source instanceof File ? `blob:${source.name.replace(/\..*$/u, '')}` : 'blob:object',
  );
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

const researchEnvironment = {
  folderPath: '/Library/Research',
  listing: {
    files: [
      { format: 'md' as const, path: 'notes.md' },
      { format: 'pdf' as const, path: 'papers/report.pdf' },
    ],
    folders: ['lessons'],
  },
  readiness: { 'papers/report.pdf': 'pending' as const },
  versions: {},
};

describe('AgentWorkspace composer context', () => {
  it('suggests scope files for @ and binds the accepted one as an inline chip', async () => {
    const { runtime } = renderWorkspace(idleAgentSessionPort(), undefined, agentContextPort());
    act(() => runtime.setScopeEnvironment(researchEnvironment));
    await screen.findByText('What’s on your mind?');
    await agentGateLifted();
    const composer = screen.getByRole('textbox', { name: 'Message' });

    typeInto(composer, 'Read @no');
    const listbox = await screen.findByRole('listbox', { name: 'Mention a file or folder' });
    expect(listbox).not.toBeNull();
    expect(screen.getByRole('option', { name: 'notes.md' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    // The open popup is announced through the controlled listbox, not
    // `aria-expanded`, which a textbox may not carry.
    expect(composer.getAttribute('aria-controls')).toBe(listbox.id);

    pressKey(composer, 'Enter');
    expect(draftOf(runtime)).toBe('Read @notes.md ');
    expect(screen.queryByRole('listbox')).toBeNull();
    const chip = composer.querySelector('[data-mention="notes.md"]'); // dom-contract: CodeMirror WidgetType in the editor's text layer
    expect(chip?.textContent).toContain('notes.md');
    expect(chip?.textContent).toContain('(file mention: notes.md)');
    expect(runtime.activeSession().store.getState().context).toEqual([
      {
        boundVersion: null,
        format: 'md',
        kind: 'source',
        source: { folderPath: '/Library/Research', path: 'notes.md' },
      },
    ]);
    // A non-visual source lives inline only; the preview row stays empty.
    expect(screen.queryByRole('list', { name: 'Attached context' })).toBeNull();

    // Backspace over the trailing space, then over the chip: one keystroke
    // removes the whole mention and unbinds its source.
    pressKey(composer, 'Backspace');
    expect(draftOf(runtime)).toBe('Read @notes.md');
    pressKey(composer, 'Backspace');
    expect(draftOf(runtime)).toBe('Read ');
    expect(composer.querySelector('[data-mention]')).toBeNull(); // dom-contract: CodeMirror WidgetType in the editor's text layer
    expect(runtime.activeSession().store.getState().context).toEqual([]);
  });

  it('keeps Enter as accept while the listbox is open and Escape dismisses it', async () => {
    const port = idleAgentSessionPort();
    const { runtime } = renderWorkspace(port, undefined, agentContextPort());
    act(() => runtime.setScopeEnvironment(researchEnvironment));
    await screen.findByText('What’s on your mind?');
    await agentGateLifted();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    typeInto(composer, '@less');
    expect(await screen.findByRole('option', { name: 'lessons' })).not.toBeNull();
    pressKey(composer, 'Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(draftOf(runtime)).toBe('@less');
    expect(runtime.activeSession().store.getState().transcript).toEqual([]);

    // With the listbox closed, Enter submits the draft as a prompt.
    pressKey(composer, 'Enter');
    await waitFor(() => expect(port.connect).toHaveBeenCalled());
  });

  it('sends a plain request while the whole folder is still being prepared', async () => {
    const port = idleAgentSessionPort();
    const { runtime } = renderWorkspace(port);
    await screen.findByText('What’s on your mind?');
    await agentGateLifted();
    act(() => {
      runtime.setScopeEnvironment({
        ...researchEnvironment,
        readiness: { 'notes.md': 'pending', 'papers/report.pdf': 'pending' },
      });
    });

    const composer = screen.getByRole('textbox', { name: 'Message' });
    typeInto(composer, 'Build wiki pages for this folder');
    pressKey(composer, 'Enter');

    // Preparation state is the only folder readiness the composer reads, and
    // it gates a bound source rather than the request. Nothing about setting
    // up search reaches this path at all: the Agent surface takes no retrieval
    // or embedding input, and a feature may not read another feature's state.
    await waitFor(() => expect(port.connect).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(runtime.activeSession().store.getState().contextIssue).toBeNull();
  });

  it('shows visual sources as tiles, reads preparation state, and refuses to send stale context', async () => {
    const port = idleAgentSessionPort();
    const onReprocess = vi.fn();
    const { runtime } = renderWorkspace(port, undefined, agentContextPort(), onReprocess);
    await screen.findByText('What’s on your mind?');
    await agentGateLifted();
    act(() => {
      runtime.setScopeEnvironment({
        ...researchEnvironment,
        readiness: { 'papers/report.pdf': 'pending', 'scans/blurry.png': 'failed' },
      });
      const session = runtime.activeSession();
      session.addContext({
        boundVersion: null,
        format: 'pdf',
        kind: 'source',
        source: { folderPath: '/Library/Research', path: 'papers/report.pdf' },
      });
      session.addContext({
        boundVersion: null,
        format: 'md',
        kind: 'source',
        source: { folderPath: '/Library/Research', path: 'gone.md' },
      });
    });
    // Unmentioned context stays visible and removable, including missing files.
    const tiles = screen.getByRole('list', { name: 'Attached context' });
    const items = within(tiles).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Preparing');

    const composer = screen.getByRole('textbox', { name: 'Message' });
    typeInto(composer, 'Summarise these');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This file is no longer in the project.',
    );
    expect(draftOf(runtime)).toBe('Summarise these');
    expect(port.connect).not.toHaveBeenCalled();

    act(() => {
      runtime.setScopeEnvironment({
        ...researchEnvironment,
        listing: {
          ...researchEnvironment.listing,
          files: [
            ...researchEnvironment.listing.files,
            { format: 'image', path: 'scans/blurry.png' },
          ],
        },
        readiness: { 'scans/blurry.png': 'failed' },
      });
      runtime.activeSession().removeContext('source:/Library/Research/gone.md');
      runtime.activeSession().addContext({
        boundVersion: null,
        format: 'image',
        kind: 'source',
        source: { folderPath: '/Library/Research', path: 'scans/blurry.png' },
      });
    });
    expect(screen.getByRole('list', { name: 'Attached context' }).textContent).toContain('Failed');
    await userEvent.click(screen.getByRole('button', { name: 'Reprocess' }));
    expect(onReprocess).toHaveBeenCalledWith({
      folderPath: '/Library/Research',
      path: 'scans/blurry.png',
    });

    // Removing the tile strips nothing from the text and unbinds the source.
    await userEvent.click(screen.getByRole('button', { name: 'Remove report.pdf' }));
    await waitFor(() =>
      expect(runtime.activeSession().store.getState().context).toEqual([
        expect.objectContaining({ source: expect.objectContaining({ path: 'scans/blurry.png' }) }),
      ]),
    );
  });

  it('drops project sources and pastes image and text attachments into Default', async () => {
    const context = agentContextPort();
    const { runtime } = renderWorkspace(idleAgentSessionPort(), undefined, context);
    act(() => runtime.setScopeEnvironment(researchEnvironment));
    await screen.findByText('What’s on your mind?');
    await agentGateLifted();
    expect(screen.getByRole('button', { name: 'Attach files' })).not.toBeNull();

    const composer = screen.getByRole('textbox', { name: 'Message' });
    const drop = (path: string) => {
      const payload = JSON.stringify({ folderPath: '/Library/Research', path });
      act(() => {
        fireEvent.drop(composer, {
          dataTransfer: {
            files: [],
            getData: (type: string) => (type === SOURCE_DRAG_MIME ? payload : ''),
            types: [SOURCE_DRAG_MIME],
          },
        });
      });
    };
    drop('notes.md');
    expect(draftOf(runtime)).toBe('@notes.md ');
    expect(composer.querySelector('[data-mention="notes.md"]')).not.toBeNull(); // dom-contract: CodeMirror WidgetType in the editor's text layer
    expect(screen.queryByRole('list', { name: 'Attached context' })).toBeNull();

    drop('papers/report.pdf');
    expect(draftOf(runtime)).toBe('@notes.md ');
    expect(screen.getByRole('list', { name: 'Attached context' }).textContent).toContain(
      'report.pdf',
    );
    expect(runtime.activeSession().store.getState().context).toEqual([
      expect.objectContaining({ format: 'md', kind: 'source' }),
      expect.objectContaining({ format: 'pdf', kind: 'source' }),
    ]);

    expect(await screen.findByRole('button', { name: 'Attach files' })).not.toBeNull();
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    const document = new File(['# Notes'], 'notes.md', { type: 'text/markdown' });
    fireEvent.paste(screen.getByRole('textbox', { name: 'Message' }), {
      clipboardData: { files: [file, document], getData: () => '' },
    });
    await waitFor(() =>
      expect(context.upload).toHaveBeenCalledWith(
        [file, document],
        expect.any(AbortSignal),
        RESEARCH_SCOPE.path,
      ),
    );
    // Uploads become the shared composer's own tiles, not name chips. Images
    // get a preview while ordinary files use the generic file treatment.
    const tile = await screen.findByRole('img', { name: 'shot.png' });
    expect(tile.getAttribute('src')).toBe('blob:shot');
    expect(screen.getByRole('img', { name: 'notes.md' })).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }));
    await waitFor(() =>
      expect(runtime.activeSession().store.getState().context).toEqual([
        expect.objectContaining({ format: 'md', kind: 'source' }),
        expect.objectContaining({ format: 'pdf', kind: 'source' }),
      ]),
    );
  });

  it('attaches a dropped code file without changing prose and sends its exact source path', async () => {
    const { listeners, port, sent } = agentSessionPort();
    const { runtime } = renderWorkspace(port, undefined, agentContextPort());
    const source = { folderPath: '/Library/Research', path: 'scripts/build (test).mjs' };
    act(() =>
      runtime.setScopeEnvironment({
        ...researchEnvironment,
        listing: {
          ...researchEnvironment.listing,
          files: [...researchEnvironment.listing.files, { format: 'generic', path: source.path }],
        },
      }),
    );
    await screen.findByText('What’s on your mind?');
    await agentGateLifted();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    typeInto(composer, 'Explain this build script');
    const drop = () =>
      fireEvent.drop(composer, {
        dataTransfer: {
          files: [],
          getData: (type: string) => (type === SOURCE_DRAG_MIME ? JSON.stringify(source) : ''),
          types: [SOURCE_DRAG_MIME],
        },
      });

    drop();
    expect(draftOf(runtime)).toBe('Explain this build script');
    expect(
      within(screen.getByRole('list', { name: 'Attached context' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Remove build (test).mjs' }));
    expect(runtime.activeSession().store.getState().context).toEqual([]);
    expect(draftOf(runtime)).toBe('Explain this build script');
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Attached context' })).toBeNull(),
    );

    drop();
    drop();
    expect(
      within(screen.getByRole('list', { name: 'Attached context' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    expect(draftOf(runtime)).toBe('Explain this build script');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(port.connect).toHaveBeenCalledOnce());
    act(() => listeners[0]?.onEvent({ kind: 'ready' }));
    await waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({
          kind: 'prompt',
          text: 'Explain this build script\n\nAttached files:\n- /Library/Research/scripts/build (test).mjs',
        }),
      ),
    );
    expect(runtime.activeSession().store.getState().transcript).toContainEqual(
      expect.objectContaining({
        context: [{ boundVersion: null, format: 'generic', kind: 'source', source }],
        kind: 'user',
        text: 'Explain this build script',
      }),
    );
  });
});
