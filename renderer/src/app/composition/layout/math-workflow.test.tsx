/** J07's formula handoff through the real Chat and document editors. Agent
 * events and versioned storage are controlled ports; rendering, selection-copy,
 * Markdown paste, formula edits, autosave and reopen use the app's own owners.
 * This does not establish provider output quality or the OS clipboard. */
import { EditorView } from '@codemirror/view';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { Providers } from '@/app/providers';
import { App } from '@/app/shell';
import { typeInto } from '@/test/dom';
import { agentSessionPort } from '@/test/fakes/agent';
import { appDependencies } from '@/test/fakes/app';
import { documentAdapters, sourceApi, textSource } from '@/test/fakes/documents';
import { accountPort, projectMathPort, SIGNED_IN_ACCOUNT } from '@/test/fakes/settings';
import { filesApi, listing, projectApi, projectRegistrySnapshot } from '@/test/fakes/workspace';
import { MATH_MARKDOWN, MATH_TEX } from '@/test/fixtures/math';
import { settleMarkdownListener } from '@/test/milkdown';

const FOLDER = '/project/math';

function mathWorkflow() {
  const dependencies = appDependencies();
  const session = agentSessionPort();
  const sources = new Map([
    ['Copied.md', textSource({ content: '' })],
    ['Selection.md', textSource({ content: '' })],
  ]);
  const saves: Array<{ path: string; content: string }> = [];
  dependencies.agent.session = session.port;
  dependencies.settings.accountApi = accountPort(SIGNED_IN_ACCOUNT);
  let mathMode = true;
  dependencies.settings.projectMathApi = projectMathPort({
    load: vi.fn(async (scope) => ({ scope, math_mode: mathMode })),
    update: vi.fn(async (scope, value) => {
      mathMode = value;
      return { scope, math_mode: value };
    }),
  });
  dependencies.project.api = projectApi({
    load: vi.fn(async () =>
      projectRegistrySnapshot({
        activeFolder: { name: 'Math', path: FOLDER },
        projects: [{ path: FOLDER, favorite: false, openedAt: '2026-11-02T00:00:00.000Z' }],
      }),
    ),
  });
  dependencies.workspace.adapters.files = filesApi({
    load: vi.fn(async () => listing([...sources.keys()], [], 'Math')),
  });
  dependencies.documents.adapters = documentAdapters({
    source: sourceApi({
      load: vi.fn(async ({ folderPath, path }) => {
        expect(folderPath).toBe(FOLDER);
        const source = sources.get(path);
        if (!source) throw new Error(`No source for ${path}`);
        return { ...source };
      }),
      save: vi.fn(async ({ folderPath, path }, input) => {
        expect(folderPath).toBe(FOLDER);
        expect(input.baseVersion).toBe(sources.get(path)?.version);
        saves.push({ path, content: input.content });
        const next = textSource({ content: input.content, version: `saved-${saves.length}` });
        sources.set(path, next);
        return next;
      }),
    }),
  });
  return { dependencies, session, sources, saves };
}

/** KaTeX exposes the same source annotation in both actual renderers. */
function formulas(root: HTMLElement): string[] {
  const annotations = root.querySelectorAll('annotation[encoding="application/x-tex"]'); // dom-contract: accessible MathML retains rendered TeX.
  return Array.from(annotations, (node) => (node.textContent ?? '').trim());
}

async function documentSurface(name: string): Promise<HTMLElement> {
  const surface = await screen.findByRole(
    'document',
    { name: `${name} Markdown content` },
    { timeout: 5_000 },
  );
  await waitFor(() => expect(surface.getAttribute('data-markdown-state')).toBe('ready'), {
    timeout: 5_000,
  });
  return surface;
}

async function openFile(name: string, user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('treeitem', { name }));
  return documentSurface(name);
}

async function reopenFile(name: string, user: ReturnType<typeof userEvent.setup>) {
  const tab = screen.getByRole('tab', { name: new RegExp(`^${name.replace('.', '\\.')}`) });
  fireEvent.keyDown(tab, { key: 'Delete' });
  await waitFor(() =>
    expect(screen.queryByRole('document', { name: `${name} Markdown content` })).toBeNull(),
  );
  return openFile(name, user);
}

async function toggleMath(surface: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  const control = within(surface).getByLabelText(/^Math$/u);
  await waitFor(() => {
    expect(control.hasAttribute('disabled')).toBe(false);
    expect(control.getAttribute('aria-disabled')).not.toBe('true');
  });
  await user.click(control);
}

async function paste(surface: HTMLElement, clipboardData: DataTransfer) {
  const editor = within(surface).getByRole('textbox', { name: 'Markdown editor' });
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
  await act(async () => {
    editor.focus();
    editor.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
}

function selectedFormula(root: HTMLElement, tex: string): DataTransfer {
  const annotations = root.querySelectorAll('annotation'); // dom-contract: TeX identifies the formula whose rendered glyphs the user selects.
  const annotation = Array.from(annotations).find((node) => node.textContent?.trim() === tex);
  const source = annotation?.closest('[data-markdown-math]');
  const glyphs = source?.querySelector('.katex-html'); // dom-contract: KaTeX's visible glyphs live beside its MathML inside the source wrapper.
  if (!glyphs) throw new Error('The Chat formula did not render.');
  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(glyphs);
  selection?.removeAllRanges();
  selection?.addRange(range);
  const clipboardData = new DataTransfer();
  const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData });
  fireEvent(glyphs, event);
  expect(event.defaultPrevented).toBe(true);
  selection?.removeAllRanges();
  return clipboardData;
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
  delete document.body.dataset.bootSettled;
});

it('keeps formulas through Chat, Agent writing, document edits and copy-paste/save/reopen', async () => {
  const fixture = mathWorkflow();
  const user = userEvent.setup();
  render(
    <Providers>
      <App dependencies={fixture.dependencies} />
    </Providers>,
  );
  await openFile('Copied.md', user);
  typeInto(await screen.findByRole('textbox', { name: 'Message' }), 'Explain and write formulas.');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  const listener = fixture.session.listeners[0];
  if (!listener) throw new Error('The Agent session did not connect.');
  act(() => {
    listener.onEvent({ kind: 'ready' });
    listener.onEvent({ kind: 'identified', id: 'math-conversation' });
    listener.onEvent({ kind: 'turn-started' });
    fixture.sources.set('Written.md', textSource({ content: MATH_MARKDOWN }));
    listener.onEvent({
      kind: 'tool-started',
      id: 'write-formulas',
      name: 'Write',
      input: { file_path: `${FOLDER}/Written.md`, content: MATH_MARKDOWN },
    });
    listener.onEvent({
      kind: 'tool-finished',
      id: 'write-formulas',
      content: 'ok',
      isError: false,
    });
  });
  const split = MATH_MARKDOWN.indexOf(MATH_TEX.matrix);
  act(() => listener.onEvent({ kind: 'text', delta: MATH_MARKDOWN.slice(0, split) }));
  const chat = screen.getByRole('log', { name: 'Chat transcript' });
  await waitFor(() => expect(formulas(chat)).toContain(MATH_TEX.fraction));
  act(() => {
    listener.onEvent({ kind: 'text', delta: MATH_MARKDOWN.slice(split) });
    listener.onEvent({ kind: 'turn-ended', isError: false });
  });
  await waitFor(() => expect(formulas(chat)).toEqual(Object.values(MATH_TEX)));
  await user.click(await screen.findByRole('button', { name: 'Open Written.md' }));
  let written = await documentSurface('Written.md');
  expect(formulas(written)).toEqual(formulas(chat));

  // One project toggle updates both live surfaces without rewriting the file.
  await toggleMath(written, user);
  const explicit = Object.values(MATH_TEX).filter((tex) => tex !== MATH_TEX.inline);
  await waitFor(() => expect(formulas(chat)).toEqual(explicit));
  expect(formulas(written)).toEqual(explicit);
  await toggleMath(written, user);
  await waitFor(() => expect(formulas(chat)).toEqual(Object.values(MATH_TEX)));
  expect(formulas(written)).toEqual(formulas(chat));
  await act(settleMarkdownListener);
  expect(fixture.saves).toEqual([]);

  // Editing the document's source changes that file, not the original reply.
  const fraction = within(written).getAllByRole('button', { name: 'Edit formula' })[0];
  if (!fraction) throw new Error('No editable formula.');
  await user.click(fraction);
  // dom-contract: formula disclosure reuses its live CodeMirror source editor.
  const host = fraction.closest('.stashbase-math-block')?.querySelector<HTMLElement>('.cm-editor');
  const editor = host && EditorView.findFromDOM(host);
  if (!editor) throw new Error('Formula source did not open.');
  const revised = String.raw`\frac{a-b}{c+d}`;
  act(() => {
    editor.focus();
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: revised } });
  });
  await user.click(within(written).getByRole('button', { name: 'Done editing formula' }));
  await waitFor(() =>
    expect(fixture.sources.get('Written.md')?.content).toBe(
      MATH_MARKDOWN.replace(MATH_TEX.fraction, revised),
    ),
  );
  written = await reopenFile('Written.md', user);
  expect(formulas(written)).toEqual(
    Object.values(MATH_TEX).map((tex) => (tex === MATH_TEX.fraction ? revised : tex)),
  );
  expect(formulas(chat)).toEqual(Object.values(MATH_TEX));

  await user.click(within(chat).getByRole('button', { name: 'Copy response' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(MATH_MARKDOWN));
  const copiedResponse = new DataTransfer();
  copiedResponse.setData('text/plain', await navigator.clipboard.readText());
  let copied = await openFile('Copied.md', user);
  await paste(copied, copiedResponse);
  await waitFor(() => expect(fixture.sources.get('Copied.md')?.content).toContain(MATH_TEX.matrix));
  const saved = fixture.sources.get('Copied.md')?.content ?? '';
  for (const tex of Object.values(MATH_TEX)) expect(saved).toContain(tex);
  expect(saved).toContain(String.raw`\$10`);
  expect(saved).toContain('`$literal$`');
  expect(saved).toContain('const price = "$not_math$";');
  copied = await reopenFile('Copied.md', user);
  expect(formulas(copied)).toEqual(Object.values(MATH_TEX));
  const explanation = within(copied).getByText('explanation');
  expect(explanation.tagName).toBe('STRONG');
  // dom-contract: the copied explanation remains in a semantic Markdown list.
  const list = explanation.closest('ul');
  if (!list) throw new Error('The pasted list was flattened.');
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  expect(fixture.sources.get('Copied.md')?.content).toBe(saved);

  const selected = selectedFormula(chat, MATH_TEX.matrix);
  expect(selected.getData('text/plain')).toBe(`$$\n${MATH_TEX.matrix}\n$$`);
  let selection = await openFile('Selection.md', user);
  await paste(selection, selected);
  await waitFor(() =>
    expect(fixture.sources.get('Selection.md')?.content).toContain(MATH_TEX.matrix),
  );
  selection = await reopenFile('Selection.md', user);
  expect(formulas(selection)).toEqual([MATH_TEX.matrix]);
  expect(fixture.session.listeners).toHaveLength(1);
}, 30_000);
