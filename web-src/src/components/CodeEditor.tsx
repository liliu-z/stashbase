import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  indentOnInput,
  foldGutter,
} from '@codemirror/language';
import {
  searchKeymap,
  highlightSelectionMatches,
  search,
  setSearchQuery,
  getSearchQuery,
  SearchQuery,
  findNext,
  findPrevious,
} from '@codemirror/search';
import { markdown as mdLang } from '@codemirror/lang-markdown';
import { useApp, type MatchInfo } from '../store/AppContext';

/**
 * CodeMirror 6 host. Mounts a CM EditorView into a div the first time,
 * destroys it on unmount, and registers `{ getValue, focus }` with the
 * store so the save / rename actions can read the live buffer without
 * prop-drilling refs around.
 *
 * Markdown is the only editable format, so the editor is md-only.
 * Editor identity is keyed by the tab plus its document generation, so
 * replacing a tab's file starts fresh while renames preserve its state.
 * Initial content is read once per document generation; CM owns it after.
 */
export function CodeEditor({
  tabId,
  sessionVersion,
  name,
  initialContent,
  onChange,
}: {
  tabId: string;
  sessionVersion: number;
  name: string;
  initialContent: string;
  onChange?: (doc: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { state, actions } = useApp();
  // Snapshot at mount time: if a rename is in progress (newNote starts
  // edit-mode AND rename together), let the RenameInput keep focus —
  // grabbing it here would blur the input, fire its onBlur commit,
  // and tear down the rename UI before the user can type a name.
  const renamingAtMountRef = useRef(state.renaming != null);
  renamingAtMountRef.current = state.renaming != null;
  // Track rename transition so we can pull focus back to the editor
  // when the user finishes (Enter) or cancels (Esc) — completes the
  // newNote → name it → start typing flow without a manual click.
  const prevRenamingRef = useRef(state.renaming != null);
  // Stable callbacks accessed from inside the CM updateListener (which
  // captures whatever's current at mount time). Refs side-step that.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const lang = mdLang({ addKeymap: false });
    // Strip CM's built-in Cmd-F binding — we route Cmd+F to our own
    // FindBar component instead. Cmd-G / Shift-Cmd-G (find next/prev)
    // stay so the bar's hotkeys still work when focus is in the editor.
    const editorSearchKeymap = searchKeymap.filter((b) => b.key !== 'Mod-f');
    const linkKeymap = [{ key: 'Mod-k', run: insertMarkdownLink }];
    const extensions = [
      lineNumbers(),
      foldGutter(),
      history(),
      bracketMatching(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      highlightActiveLine(),
      EditorView.lineWrapping,
      highlightSelectionMatches(),
      // search() owns the SearchQuery state + match decorations even
      // though we never call openSearchPanel — our FindBar drives it
      // imperatively via setSearchQuery / findNext / findPrevious.
      search(),
      keymap.of([indentWithTab, ...linkKeymap, ...defaultKeymap, ...historyKeymap, ...editorSearchKeymap]),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px' },
        '.cm-scroller': {
          fontFamily:
            '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
          lineHeight: '1.55',
        },
        '.cm-line': {
          overflowWrap: 'anywhere',
        },
        '.cm-content': { padding: '12px 0 12px 8px' },
        '.cm-gutters': {
          // Opaque so content scrolling horizontally doesn't show
          // through the line-number column — matches `.md-editor`'s
          // background (`var(--bg)`).
          background: 'var(--bg)',
          color: '#9aa0a6',
          border: 'none',
          padding: '0 8px 0 12px',
        },
        '.cm-activeLine': { background: 'rgba(0,0,0,0.025)' },
        '.cm-activeLineGutter': { background: 'transparent', color: '#5f6368' },
      }),
      lang,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
      }),
    ];

    const session = actions.getEditorSession(tabId);
    const savedSession = session?.version === sessionVersion ? session : undefined;
    const view = new EditorView({
      state: savedSession?.state ?? EditorState.create({ doc: initialContent, extensions }),
      parent: host,
    });
    if (savedSession) {
      view.scrollDOM.scrollTop = savedSession.scrollTop;
      view.scrollDOM.scrollLeft = savedSession.scrollLeft;
    }
    viewRef.current = view;
    actions.registerEditor({
      getValue: () => view.state.doc.toString(),
      focus: () => view.focus(),
    });
    actions.registerFindController({
      setQuery: (q, opts) => applyEditorQuery(view, q, opts.wholeWord, opts.caseSensitive),
      restoreQuery: (q, opts) => applyEditorQuery(view, q, opts.wholeWord, opts.caseSensitive, false),
      next: () => { findNext(view); return matchInfoFor(view); },
      prev: () => { findPrevious(view); return matchInfoFor(view); },
      close: () => {
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
      },
    });
    if (!renamingAtMountRef.current) view.focus();

    return () => {
      actions.setEditorSession(tabId, {
        version: sessionVersion,
        state: view.state,
        scrollTop: view.scrollDOM.scrollTop,
        scrollLeft: view.scrollDOM.scrollLeft,
      });
      actions.registerFindController(null);
      actions.registerEditor(null);
      view.destroy();
      viewRef.current = null;
    };
  // Mount once per document generation; initialContent and onChange are captured via
  // refs so they don't trigger re-mounts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionVersion, tabId]);

  // Re-focus the editor when an inline rename ends (commit or cancel).
  useEffect(() => {
    const isRenaming = state.renaming != null;
    if (prevRenamingRef.current && !isRenaming) {
      viewRef.current?.focus();
    }
    prevRenamingRef.current = isRenaming;
  }, [state.renaming]);

  // Chunk-highlight after a SearchHit click. We pick the line range
  // (1-based) from pendingHighlight, then dispatch a scroll + select
  // so the chunk visibly highlights via the selection background.
  // Sufficient for V1; a fading line decoration is V2.
  const pendingHighlight = state.tabs.find((t) => t.id === state.activeTabId)?.pendingHighlight ?? null;
  useEffect(() => {
    if (!pendingHighlight?.startLine) return;
    const view = viewRef.current;
    if (!view) return;
    const startLine = Math.max(1, Math.min(view.state.doc.lines, pendingHighlight.startLine));
    const endLine = Math.max(startLine, Math.min(view.state.doc.lines, pendingHighlight.endLine ?? startLine));
    const from = view.state.doc.line(startLine).from;
    const to = view.state.doc.line(endLine).to;
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    actions.consumePendingHighlight();
  }, [pendingHighlight, actions]);

  return <div ref={hostRef} style={{ height: '100%' }} />;
}

/** Push a new SearchQuery and, for an interactive query, land selection on
 * the first match at or after the current cursor. Restored sessions keep
 * their saved selection while regaining query decorations and match counts. */
export function applyEditorQuery(
  view: EditorView,
  q: string,
  wholeWord: boolean,
  caseSensitive: boolean,
  selectMatch = true,
): MatchInfo {
  const query = new SearchQuery({
    search: q,
    caseSensitive,
    regexp: false,
    wholeWord,
  });
  view.dispatch({ effects: setSearchQuery.of(query) });
  if (selectMatch && q && query.valid) findNext(view);
  return matchInfoFor(view);
}

/** Compute "current of total" by iterating the search cursor across the
 *  full document. Linear in match count — fine for a single doc; the
 *  iterator is the canonical way to count matches in CM6 since
 *  decorations don't expose a count API. */
function matchInfoFor(view: EditorView): MatchInfo {
  const q = getSearchQuery(view.state);
  if (!q.search || !q.valid) return { current: 0, total: 0 };
  const sel = view.state.selection.main;
  const cursor = q.getCursor(view.state) as Iterator<{ from: number; to: number }>;
  let total = 0;
  let current = 0;
  while (true) {
    const r = cursor.next();
    if (r.done) break;
    total++;
    if (r.value.from === sel.from && r.value.to === sel.to) current = total;
  }
  return { current, total };
}

function insertMarkdownLink(view: EditorView): boolean {
  const target = window.prompt('Link target: note.md, folder/note.md#heading, #heading, or https://...');
  if (target == null) return true;
  const href = target.trim();
  if (!href) return true;
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to);
  const text = selected || 'link text';
  const inserted = `[${text}](${href})`;
  const textFrom = sel.from + 1;
  const textTo = textFrom + text.length;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: inserted },
    selection: selected ? { anchor: sel.from + inserted.length } : { anchor: textFrom, head: textTo },
  });
  view.focus();
  return true;
}
