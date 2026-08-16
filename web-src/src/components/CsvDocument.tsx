import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Compartment, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { useApp, type FindController, type FindOptions, type MatchInfo } from '../store/AppContext';
import {
  analyzeCsvSource,
  deleteCsvRow,
  insertCsvRow,
  matchingCsvCells,
  pasteCsvMatrix,
  replaceCsvCell,
  type CsvLineEnding,
  type CsvSourceAnalysis,
} from './csv/sourceModel';
import type { CsvTableSessionState } from './csv/CsvTableView';
import { TableIcon, CodeIcon, WarningIcon } from '../icons';
import { SegmentedControl, SegmentedControlItem } from './ui/segmented-control';

const LazyCsvTableView = lazy(() =>
  import('./csv/CsvTableView').then((module) => ({ default: module.CsvTableView })),
);

interface RetainedCsvSession {
  table: CsvTableSessionState;
  viewMode: 'table' | 'source';
}

const retainedCsvSessions = new Map<string, RetainedCsvSession>();

type LiveFindController = FindController & { refresh: () => MatchInfo };

export function toCsvEditorText(source: string): string {
  return source.replace(/\r\n?/gu, '\n');
}

export function fromCsvEditorText(source: string, lineEnding: CsvLineEnding): string {
  if (lineEnding === '\n') return source;
  return source.replace(/\n/gu, lineEnding === '\r\n' ? '\r\n' : '\r');
}

export const stashbaseCsvHighlightStyle = HighlightStyle.define([
  { tag: tags.string, class: 'cm-csv-field' },
  { tag: tags.separator, class: 'cm-csv-delimiter' },
  { tag: tags.invalid, class: 'cm-csv-invalid' },
]);

export interface CsvEditorSession {
  view: EditorView;
  find: LiveFindController;
  setReadOnly: (readOnly: boolean) => void;
  replaceFromDisk: (content: string) => void;
  destroy: () => void;
}

export function createCsvEditor(
  host: HTMLElement,
  opts: {
    content: string;
    readOnly: boolean;
    onUserChange: () => void;
    onContentChange?: (content: string) => void;
    onFindInfo: (info: MatchInfo) => void;
  },
): CsvEditorSession {
  const readOnly = new Compartment();
  let applyingExternal = false;
  let find: LiveFindController;
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: opts.content,
      extensions: [
        lineNumbers(),
        history(),
        syntaxHighlighting(stashbaseCsvHighlightStyle),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        readOnly.of([EditorState.readOnly.of(opts.readOnly), EditorView.editable.of(!opts.readOnly)]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          opts.onContentChange?.(update.state.doc.toString());
          if (!applyingExternal) opts.onUserChange();
          queueMicrotask(() => opts.onFindInfo(find.refresh()));
        }),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--fg)' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
          '.cm-content': { padding: '20px 0 72px', caretColor: 'var(--focus-ring)' },
          '.cm-line': { padding: '0 20px' },
          '.cm-gutters': { backgroundColor: 'var(--pane)', color: 'var(--muted)', border: '0' },
          '.cm-activeLine, .cm-activeLineGutter': {
            backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)',
          },
          '&.cm-focused': { outline: 'none' },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
            backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
          },
          '.cm-csv-field': { color: 'var(--fg)' },
          '.cm-csv-delimiter': { color: 'var(--muted)' },
          '.cm-csv-invalid': {
            color: 'var(--syntax-json-invalid, var(--destructive))',
            textDecoration: 'underline wavy var(--syntax-json-invalid, var(--destructive))',
            textUnderlineOffset: '2px',
          },
        }),
      ],
    }),
  });

  find = makeCsvFindController(() => view);

  return {
    view,
    find,
    setReadOnly: (next) =>
      view.dispatch({
        effects: readOnly.reconfigure([
          EditorState.readOnly.of(next),
          EditorView.editable.of(!next),
        ]),
      }),
    replaceFromDisk: (next) => {
      const normalized = toCsvEditorText(next);
      if (view.state.doc.toString() === normalized) return;
      applyingExternal = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: normalized } });
      } finally {
        applyingExternal = false;
      }
    },
    destroy: () => view.destroy(),
  };
}

export function CsvDocument({
  tabId,
  content,
  readOnly,
  active,
}: {
  tabId: string;
  content: string;
  readOnly: boolean;
  active: boolean;
}) {
  const { actions, activeTab, dispatch } = useApp();
  const registerFindController = actions.registerFindController;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<CsvEditorSession | null>(null);
  const initialAnalysis = useMemo(() => analyzeCsvSource(content), [tabId]);
  const retained = retainedCsvSessions.get(tabId);

  const [source, setSource] = useState(content);
  const [viewMode, setViewModeState] = useState<'table' | 'source'>(
    retained?.viewMode ?? (initialAnalysis.ok ? 'table' : 'source'),
  );
  const [analysis, setAnalysis] = useState<CsvSourceAnalysis>(initialAnalysis);
  const [tableSession, setTableSession] = useState<CsvTableSessionState>(
    retained?.table ?? {},
  );

  const sourceRef = useRef(source);
  const lineEndingRef = useRef(initialAnalysis.lineEnding);
  const tableSessionRef = useRef(tableSession);
  sourceRef.current = source;
  tableSessionRef.current = tableSession;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const session = createCsvEditor(host, {
      content,
      readOnly,
      onUserChange: actions.scheduleSave,
      onContentChange: (next) => {
        const nextRaw = fromCsvEditorText(next, lineEndingRef.current);
        setSource(nextRaw);
        const nextAnalysis = analyzeCsvSource(nextRaw);
        setAnalysis(nextAnalysis);
        if (!nextAnalysis.ok && viewMode === 'table') {
          setViewModeState('source');
        }
      },
      onFindInfo: (info) => dispatch({ type: 'FIND_SET', patch: info }),
    });

    sessionRef.current = session;

    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
      actions.registerEditor(null);
      actions.registerFindController(null);
      session.destroy();
    };
  }, [tabId]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.setReadOnly(readOnly);
    if (!readOnly && active) {
      actions.registerEditor({
        getValue: () => fromCsvEditorText(session.view.state.doc.toString(), lineEndingRef.current),
        focus: () => session.view.focus(),
      });
    } else {
      actions.registerEditor(null);
    }
  }, [actions, active, readOnly]);

  useEffect(() => {
    if (activeTab?.dirty) return;
    lineEndingRef.current = analyzeCsvSource(content).lineEnding;
    sessionRef.current?.replaceFromDisk(content);
    setSource(content);
    setAnalysis(analyzeCsvSource(content));
  }, [activeTab?.dirty, content]);

  const retainSession = (table: CsvTableSessionState, mode: 'table' | 'source') => {
    retainedCsvSessions.delete(tabId);
    retainedCsvSessions.set(tabId, { table, viewMode: mode });
    while (retainedCsvSessions.size > 20) retainedCsvSessions.delete(retainedCsvSessions.keys().next().value!);
  };

  const setViewMode = (mode: 'table' | 'source') => {
    setViewModeState(mode);
    retainSession(tableSession, mode);
  };

  const updateTableSession = (next: CsvTableSessionState) => {
    retainSession(next, viewMode);
    setTableSession(next);
  };

  const tableFindRef = useRef<FindController | null>(null);
  if (!tableFindRef.current) {
    tableFindRef.current = makeCsvTableFindController(
      () => sourceRef.current,
      () => tableSessionRef.current,
      (next) => updateTableSession(next),
    );
  }

  useEffect(() => {
    if (!active) return;
    const controller = viewMode === 'table' ? tableFindRef.current : sessionRef.current?.find;
    if (!controller) return;
    registerFindController(controller);
    return () => registerFindController(null);
  }, [registerFindController, active, viewMode]);

  const applySourcePatch = (nextRawSource: string) => {
    const view = sessionRef.current?.view;
    if (!view || nextRawSource === source) return;
    const current = view.state.doc.toString();
    const editorText = toCsvEditorText(nextRawSource);
    let from = 0;
    while (from < current.length && from < editorText.length && current[from] === editorText[from]) from++;
    let currentTo = current.length;
    let nextTo = editorText.length;
    while (currentTo > from && nextTo > from && current[currentTo - 1] === editorText[nextTo - 1]) {
      currentTo--;
      nextTo--;
    }
    view.dispatch({ changes: { from, to: currentTo, insert: editorText.slice(from, nextTo) } });
    setSource(nextRawSource);
    setAnalysis(analyzeCsvSource(nextRawSource));
    actions.scheduleSave();
  };

  const handleCellEdited = (col: number, row: number, value: string) => {
    const patched = replaceCsvCell(source, analysis, col, row, value);
    applySourcePatch(patched);
  };

  const handlePaste = (startCol: number, startRow: number, values: readonly (readonly string[])[]) => {
    const patched = pasteCsvMatrix(source, analysis, startCol, startRow, values);
    applySourcePatch(patched);
  };

  const handleRowInserted = (insertIndex: number) => {
    const patched = insertCsvRow(source, analysis, insertIndex, []);
    applySourcePatch(patched);
  };

  const handleRowDeleted = (deleteIndex: number) => {
    const patched = deleteCsvRow(source, analysis, deleteIndex);
    applySourcePatch(patched);
  };

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden bg-background"
      data-tab-id={tabId}
      role="region"
      aria-label="CSV document"
      hidden={!active}
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4" role="group" aria-label="CSV view mode">
        <div className="flex items-center gap-3">
          <SegmentedControl
            aria-label="CSV view mode"
            value={[viewMode]}
            onValueChange={(next) => {
              const val = next[0];
              if (val === 'table' || val === 'source') {
                setViewMode(val);
              }
            }}
          >
            <SegmentedControlItem
              value="table"
              disabled={!analysis.ok}
              title={analysis.ok ? 'Inspect CSV as a table' : analysis.error}
              className="text-xs px-2.5 py-1 min-w-[72px]"
            >
              <div className="flex items-center gap-1.5 justify-center">
                <TableIcon className="size-3.5" />
                <span>Table</span>
              </div>
            </SegmentedControlItem>
            <SegmentedControlItem
              value="source"
              className="text-xs px-2.5 py-1 min-w-[72px]"
            >
              <div className="flex items-center gap-1.5 justify-center">
                <CodeIcon className="size-3.5" />
                <span>Source</span>
              </div>
            </SegmentedControlItem>
          </SegmentedControl>
          {!analysis.ok && (
            <span className="flex items-center gap-1.5 text-xs text-destructive" role="status">
              <WarningIcon className="size-3.5" />
              <span>{analysis.error}</span>
            </span>
          )}
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <div ref={hostRef} className="h-full w-full overflow-hidden" hidden={viewMode !== 'source'} />
        {viewMode === 'table' && analysis.ok && (
          <Suspense fallback={<div className="p-4 text-sm text-muted-foreground" role="status">Loading Table…</div>}>
            <LazyCsvTableView
              analysis={analysis}
              readOnly={readOnly}
              onCellEdited={handleCellEdited}
              onPaste={handlePaste}
              onRowInserted={handleRowInserted}
              onRowDeleted={handleRowDeleted}
              session={tableSession}
              onSessionChange={updateTableSession}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

export function makeCsvTableFindController(
  getSource: () => string,
  getSession: () => CsvTableSessionState,
  setSession: (session: CsvTableSessionState) => void,
): FindController {
  let matches: Array<{ col: number; row: number }> = [];
  let current = -1;
  let query = '';
  let options: FindOptions = { wholeWord: false, caseSensitive: false };
  const info = (): MatchInfo => ({ current: current < 0 ? 0 : current + 1, total: matches.length });
  const collect = () => {
    const analysis = analyzeCsvSource(getSource());
    if (!analysis.ok || !query) {
      matches = [];
      current = -1;
      return;
    }
    matches = matchingCsvCells(analysis, query, options).map((m) => ({ col: m.col, row: m.row }));
    if (!matches.length) current = -1;
    else if (current < 0 || current >= matches.length) current = 0;
  };
  const select = () => {
    if (current < 0) return;
    const session = getSession();
    const match = matches[current];
    setSession({ ...session, selectedCell: [match.col, match.row] });
  };
  const setQuery = (next: string, nextOptions: FindOptions) => {
    query = next;
    options = nextOptions;
    current = -1;
    collect();
    select();
    return info();
  };
  const move = (delta: number) => {
    collect();
    if (matches.length) {
      current = (current + delta + matches.length) % matches.length;
      select();
    }
    return info();
  };
  return {
    setQuery,
    restoreQuery: setQuery,
    next: () => move(1),
    prev: () => move(-1),
    close: () => {
      matches = [];
      current = -1;
      query = '';
      setSession({ ...getSession(), selectedCell: undefined });
    },
  };
}

export function makeCsvFindController(getView: () => EditorView | null): LiveFindController {
  let matches: Array<{ from: number; to: number }> = [];
  let current = -1;
  let query = '';
  let options: FindOptions = { wholeWord: false, caseSensitive: false };

  const info = (): MatchInfo => ({ current: matches.length ? current + 1 : 0, total: matches.length });
  const move = (delta: number): MatchInfo => {
    const view = getView();
    if (!view || matches.length === 0) return info();
    current = (current + delta + matches.length) % matches.length;
    selectMatch(view, matches[current].from, matches[current].to);
    return info();
  };
  const setQuery = (nextQuery: string, opts: FindOptions): MatchInfo => {
    query = nextQuery;
    options = opts;
    const view = getView();
    matches = view ? textMatches(view.state.doc.toString(), query, opts) : [];
    current = matches.length ? 0 : -1;
    if (view && current >= 0) selectMatch(view, matches[current].from, matches[current].to);
    return info();
  };
  const refresh = (): MatchInfo => {
    const view = getView();
    if (!view) {
      matches = [];
      current = -1;
      return info();
    }
    const cursor = view.state.selection.main.from;
    matches = textMatches(view.state.doc.toString(), query, options);
    if (matches.length === 0) current = -1;
    else {
      const atOrAfterCursor = matches.findIndex((match) => match.from >= cursor);
      current = atOrAfterCursor >= 0 ? atOrAfterCursor : 0;
    }
    return info();
  };
  return {
    setQuery,
    restoreQuery: setQuery,
    next: () => move(1),
    prev: () => move(-1),
    close: () => {
      matches = [];
      current = -1;
    },
    refresh,
  };
}

export function textMatches(text: string, query: string, opts: FindOptions): Array<{ from: number; to: number }> {
  if (!query) return [];
  const haystack = opts.caseSensitive ? text : text.toLocaleLowerCase();
  const needle = opts.caseSensitive ? query : query.toLocaleLowerCase();
  const out: Array<{ from: number; to: number }> = [];
  for (let from = 0; from <= haystack.length - needle.length; ) {
    const hit = haystack.indexOf(needle, from);
    if (hit < 0) break;
    const end = hit + needle.length;
    if (!opts.wholeWord || (isBoundary(text, hit - 1) && isBoundary(text, end))) {
      out.push({ from: hit, to: end });
    }
    from = Math.max(end, hit + 1);
  }
  return out;
}

function isBoundary(text: string, index: number): boolean {
  return index < 0 || index >= text.length || !/[\p{L}\p{N}_]/u.test(text[index]);
}

function selectMatch(view: EditorView, from: number, to: number): void {
  if (from < 0 || to < from || to > view.state.doc.length) return;
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
}
