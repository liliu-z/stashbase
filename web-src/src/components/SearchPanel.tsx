import { useEffect, useRef, type ReactNode } from 'react';
import type { FileMeta, KeywordHitFile, KeywordMatch, SearchHit } from '../api';
import { useApp } from '../store/AppContext';
import { openSettings } from './SettingsModal';
import type { SearchTypeCategory } from '../../../shared/search-types.ts';

/**
 * The "search" sidebar view — owns the search input, the mode toggle
 * (≈ ↔ =) with conditional `Aa` / `Word` sub-filters when in keyword
 * mode, the subfolder-scope and file-type filter row, and the result
 * list.
 *
 * Empty query → empty body (no "Recent searches" prompt yet — that's
 * deferred until we add a real history feature).
 *
 * This component is intentionally siblings with `FilesPanel`, switched
 * by `state.activeSidebarView` from the `Sidebar` wrapper. Splitting
 * search out of the files panel means the user no longer has to clear
 * the query to get the tree back — they just click the Files icon in
 * the activity bar.
 */
export function SearchPanel() {
  const { state } = useApp();
  const query = state.filterQuery.trim();
  return (
    <div className="search-panel" id="sidebar-panel-search" role="tabpanel">
      <SearchBox />
      <SearchFilters />
      <SearchStatusBanner />
      <div className="search-panel-body">
        {state.searchMode === 'semantic' && state.embedderHasKey === false ? (
          <SearchResults query={query} />
        ) : query ? (
          <SearchResults query={query} />
        ) : (
          // Per design: nothing shown until the user starts typing.
          // The user has plenty of feedback from the input itself.
          null
        )}
      </div>
    </div>
  );
}

const SEARCH_TYPE_CHIPS: Array<{ type: SearchTypeCategory; label: string; title: string }> = [
  { type: 'notes', label: 'Notes', title: 'Markdown and HTML' },
  { type: 'pdf', label: 'PDF', title: 'PDF documents' },
  { type: 'image', label: 'Images', title: 'OCR-searchable images' },
  { type: 'docx', label: 'DOCX', title: 'Word documents' },
  { type: 'audio', label: 'Audio', title: 'Transcribed audio' },
];

/** Subfolder scope + file-type chips. Both narrow the NEXT search in
 *  either mode and compose; no selection = whole folder, every type. */
function SearchFilters() {
  const { state, actions, dispatch } = useApp();
  const scopes = subfolderScopes(state.files);
  const staleScope = state.searchScope != null && !scopes.includes(state.searchScope);

  function rerun(next: { scope?: string | null; types?: SearchTypeCategory[] }) {
    if (state.filterQuery.trim()) void actions.runSearch(state.filterQuery, undefined, next);
  }

  function setScope(scope: string | null) {
    dispatch({ type: 'SEARCH_SCOPE', scope });
    rerun({ scope });
  }

  function toggleType(type: SearchTypeCategory) {
    const types = state.searchTypes.includes(type)
      ? state.searchTypes.filter((t) => t !== type)
      : [...state.searchTypes, type];
    dispatch({ type: 'SEARCH_TYPES', types });
    rerun({ types });
  }

  return (
    <div className="search-filters">
      {(scopes.length > 0 || staleScope) && (
        <select
          className="search-scope"
          value={state.searchScope ?? ''}
          onChange={(e) => setScope(e.target.value || null)}
          aria-label="Search scope"
          title="Limit search to a subfolder"
        >
          <option value="">All folders</option>
          {staleScope && <option value={state.searchScope!}>{state.searchScope}</option>}
          {scopes.map((scope) => <option key={scope} value={scope}>{scope}</option>)}
        </select>
      )}
      <div className="search-type-chips" role="group" aria-label="File types">
        {SEARCH_TYPE_CHIPS.map(({ type, label, title }) => (
          <button
            key={type}
            type="button"
            className={'search-type-chip' + (state.searchTypes.includes(type) ? ' active' : '')}
            aria-pressed={state.searchTypes.includes(type)}
            title={title}
            onClick={() => toggleType(type)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Every directory that contains a visible file, folder-relative,
 *  sorted. Derived from the file list so the options always reflect
 *  the live tree. */
function subfolderScopes(files: FileMeta[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.name.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

function SearchStatusBanner() {
  const { state, actions } = useApp();
  const isSemantic = state.searchMode === 'semantic';
  const semanticDisabled = state.embedderHasKey === false;
  const conversionPendingCount = state.pendingConversions.length;
  const semanticPendingPaths = new Set<string>();
  for (const path of state.pendingSemanticNames) semanticPendingPaths.add(path);
  for (const path of state.pendingConversions) semanticPendingPaths.add(path);
  const semanticPendingCount = semanticPendingPaths.size;
  const pendingCount = isSemantic ? semanticPendingCount : conversionPendingCount;
  const failedCount = state.preparationFailures.filter((problem) => problem.status !== 'cancelled').length;
  const cancelledCount = state.preparationFailures.length - failedCount;
  const failureCount = failedCount + cancelledCount;
  const blockedCount = state.blockedConversions.length;
  const total = state.files.length;
  const unavailablePaths = new Set([
    ...state.pendingConversions,
    ...state.preparationFailures.map((failure) => failure.path),
    ...state.blockedConversions,
    ...(isSemantic ? [...state.pendingSemanticNames] : []),
  ]);
  const readyCount = Math.max(0, total - unavailablePaths.size);

  if (isSemantic && state.indexWarning) {
    return (
      <div className="search-status-banner warning">
        <div className="search-status-copy">
          <div className="search-status-title">Search needs attention</div>
          <div className="search-status-detail">
            Search may be incomplete: {state.indexWarning.message}
          </div>
        </div>
        <div className="search-status-actions">
          <button type="button" onClick={() => { void actions.runSync(); }}>Retry</button>
          <button type="button" onClick={() => { void actions.dismissIndexWarning(); }}>Dismiss</button>
        </div>
      </div>
    );
  }

  if (failureCount > 0) {
    return (
      <div className="search-status-banner warning">
        <div className="search-status-copy">
          <div className="search-status-title">
            {failedCount > 0 ? 'Some files could not be prepared for search.' : 'Some file preparation was cancelled.'}
          </div>
          <div className="search-status-detail">
            {[
              failedCount > 0 ? `${failedCount} failed` : '',
              cancelledCount > 0 ? `${cancelledCount} cancelled` : '',
            ].filter(Boolean).join(' · ')}. Open a file to retry it.
          </div>
        </div>
      </div>
    );
  }

  if (blockedCount > 0) {
    return (
      <div className="search-status-banner warning">
        <div className="search-status-copy">
          <div className="search-status-title">Transcription setup required</div>
          <div className="search-status-detail">
            {readyCount} file{readyCount === 1 ? ' is' : 's are'} ready to search. {blockedCount} audio file{blockedCount === 1 ? '' : 's'} need transcription setup.
          </div>
        </div>
        <div className="search-status-actions">
          <button type="button" onClick={() => openSettings('transcription')}>Open Settings</button>
        </div>
      </div>
    );
  }

  if (isSemantic && semanticDisabled) return null;

  if (pendingCount > 0) {
    const readyLabel = `${readyCount} file${readyCount === 1 ? '' : 's'} ${readyCount === 1 ? 'is' : 'are'} ready to search.`;
    const pendingLabel = isSemantic
      ? `${pendingCount} ${pendingCount === 1 ? 'is' : 'are'} still being prepared.`
      : `${pendingCount} ${pendingCount === 1 ? 'is' : 'are'} still being converted.`;
    return (
      <div className="search-status-banner pending">
        <div className="search-status-copy">
          <div className="search-status-title">
            {isSemantic ? 'Making files searchable' : 'Preparing text for keyword search'}
          </div>
          <div className="search-status-detail">
            {readyLabel} {pendingLabel}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

/** Input + ≈/= mode flip + (keyword-only) Aa / Word sub-toggles. The
 *  mode flip swaps the icon based on current mode so the button
 *  doubles as a state indicator. */
function SearchBox() {
  const { state, actions, dispatch } = useApp();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); }, []);

  // Hand the input handle to the store on mount so `actions.focusSearch`
  // can reach it without a global DOM query.
  useEffect(() => {
    actions.registerSearchInput(inputRef.current);
    return () => actions.registerSearchInput(null);
  }, [actions]);

  // Keep results fresh against the current content. This fires on mount
  // (returning to Search after a view switch — the Sidebar mounts/
  // unmounts SearchPanel) AND whenever the content changes underneath
  // while Search stays open: a new/removed note (`files`) or a finished
  // screenshot/PDF conversion (`pendingConversions` — its OCR text only
  // becomes searchable once conversion completes, which also reloads
  // `files`). Without this the user must edit the query to see new
  // matches, since results live in the store and aren't otherwise
  // refetched.
  useEffect(() => {
    if (state.filterQuery.trim()) void actions.runSearch(state.filterQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.files, state.pendingConversions]);

  function onChange(value: string) {
    dispatch({ type: 'FILTER', q: value });
    if (debounce.current) clearTimeout(debounce.current);
    if (!value.trim()) {
      void actions.runSearch('');
      return;
    }
    dispatch({ type: 'SEARCH_START' });
    debounce.current = setTimeout(() => { void actions.runSearch(value); }, 250);
  }

  function flipMode() {
    const next = state.searchMode === 'semantic' ? 'keyword' : 'semantic';
    dispatch({ type: 'SEARCH_MODE', mode: next });
    if (state.filterQuery.trim()) {
      void actions.runSearch(state.filterQuery, next);
    }
  }

  function toggleCaseStrict() {
    const next = !state.caseStrict;
    dispatch({ type: 'SEARCH_CASE_STRICT', strict: next });
    if (state.filterQuery.trim()) {
      void actions.runSearch(state.filterQuery, 'keyword', {
        caseStrict: next,
        wholeWord: state.wholeWord,
      });
    }
  }

  function toggleWholeWord() {
    const next = !state.wholeWord;
    dispatch({ type: 'SEARCH_WHOLE_WORD', on: next });
    if (state.filterQuery.trim()) {
      void actions.runSearch(state.filterQuery, 'keyword', {
        caseStrict: state.caseStrict,
        wholeWord: next,
      });
    }
  }

  const isKeyword = state.searchMode === 'keyword';
  const semanticDisabled = state.embedderHasKey === false;

  return (
    <div className="side-search">
      {/* `type="text"` (not `search`) on purpose — we don't want the
       *  native cancel-X glyph crowding the toggle row on the right,
       *  and we don't want the native Esc-clears-input behaviour
       *  either; clearing happens by deleting characters or by
       *  flipping back to Files via the activity bar. */}
      <input
        ref={inputRef}
        type="text"
        placeholder="Search…"
        autoComplete="off"
        spellCheck={false}
        value={state.filterQuery}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="side-search-mode" role="group" aria-label="Search mode">
        {isKeyword && (
          <>
            <button
              type="button"
              className={'side-search-mode-btn' + (state.caseStrict ? ' active' : '')}
              onClick={toggleCaseStrict}
              aria-label="Match case"
              aria-pressed={state.caseStrict}
              title="Match Case"
            >
              Aa
            </button>
            <button
              type="button"
              className={'side-search-mode-btn word-toggle' + (state.wholeWord ? ' active' : '')}
              onClick={toggleWholeWord}
              aria-label="Match whole word"
              aria-pressed={state.wholeWord}
              title="Whole word"
            >
              Word
            </button>
          </>
        )}
        <button
          type="button"
          className="side-search-mode-btn side-search-mode-flip"
          onClick={flipMode}
          aria-label={isKeyword ? 'Switch to semantic search' : 'Switch to keyword search'}
          title={
            isKeyword
              ? semanticDisabled ? 'Keyword search · click for semantic setup' : 'Keyword search · click for semantic'
              : 'Semantic search · click for keyword'
          }
        >
          {isKeyword ? '=' : '≈'}
        </button>
      </div>
    </div>
  );
}

function SearchResults({ query }: { query: string }) {
  const { state } = useApp();
  if (state.searchMode === 'semantic' && state.embedderHasKey === false) {
    return (
      <div className="empty-list">
        <div>Semantic search needs an OpenAI API key.</div>
        <div>Keyword search works without embeddings.</div>
      </div>
    );
  }

  // A real failure (server / daemon error) — distinct from "no matches".
  if (state.searchError) {
    if (state.searchError.startsWith('Semantic search is disabled')) {
      return (
        <div className="empty-list">
          <div>Semantic search needs an OpenAI API key.</div>
          <div>Keyword search works without embeddings.</div>
        </div>
      );
    }
    return <div className="empty-list search-failed">Search failed: {state.searchError}</div>;
  }
  if (state.searchMode === 'keyword') {
    return <KeywordSearchResults query={query} />;
  }
  if (state.searching && state.searchHits === null) {
    return <div className="empty-list">Searching…</div>;
  }
  if (!state.searchHits || state.searchHits.length === 0) {
    return <div className="empty-list">No matches</div>;
  }
  return (
    <div className="search-hits">
      {state.searchHits.map((hit, i) => (
        <SearchHitRow key={`${hit.fileName}#${hit.chunkIndex}#${i}`} hit={hit} />
      ))}
    </div>
  );
}

function KeywordSearchResults({ query }: { query: string }) {
  const { state } = useApp();
  if (state.searching && state.keywordResult === null) {
    return <div className="empty-list">Searching…</div>;
  }
  const result = state.keywordResult;
  if (!result || result.files.length === 0) {
    return <div className="empty-list">No matches</div>;
  }
  return (
    <div className="search-hits keyword-hits">
      <div className="keyword-summary">
        {result.totalMatches} match{result.totalMatches === 1 ? '' : 'es'} in {result.files.length} file{result.files.length === 1 ? '' : 's'}
        {result.truncated && ' (truncated)'}
      </div>
      {result.files.map((file) => (
        <KeywordFileGroup key={file.path} file={file} query={query} />
      ))}
    </div>
  );
}

function KeywordFileGroup({ file, query }: { file: KeywordHitFile; query: string }) {
  const { actions } = useApp();
  const basename = file.path.split('/').pop() ?? file.path;
  const hiddenCount = file.totalMatches - file.matches.length;
  return (
    <div className="keyword-file-group">
      <div
        className="keyword-file-header"
        title={file.path}
        onClick={() => {
          void actions.selectFileWithHighlight(file.path, {
            startLine: file.matches[0]?.line,
            chunkText: query,
            audioSeekText: file.matches[0]?.text,
            audioSeekMs: file.matches[0]?.audioTimestampMs,
            openFindBar: true,
            pdfPage: file.matches[0]?.pdfPage,
          });
        }}
      >
        <span className="keyword-file-name">{basename}</span>
        <span className="keyword-file-count">{file.totalMatches}</span>
      </div>
      {file.matches.map((m, i) => (
        <KeywordMatchRow key={`${file.path}#${m.line}#${i}`} file={file} match={m} query={query} />
      ))}
      {hiddenCount > 0 && (
        <div className="keyword-match-row keyword-truncated">+ {hiddenCount} more in this file</div>
      )}
    </div>
  );
}

function KeywordMatchRow({ file, match, query }: { file: KeywordHitFile; match: KeywordMatch; query: string }) {
  const { actions } = useApp();
  return (
    <div
      className="keyword-match-row"
      onClick={() => {
        void actions.selectFileWithHighlight(file.path, {
          startLine: match.line,
          chunkText: query,
          audioSeekText: match.text,
          audioSeekMs: match.audioTimestampMs,
          openFindBar: true,
          pdfPage: match.pdfPage,
        });
      }}
      title={`Line ${match.line}`}
    >
      <span className="keyword-line-num">{match.line}</span>
      <span className="keyword-line-text">{highlightRanges(match.text, match.ranges)}</span>
    </div>
  );
}

function highlightRanges(text: string, ranges: Array<[number, number]>) {
  if (ranges.length === 0) return <span>{text}</span>;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) parts.push(<span key={`g${cursor}`}>{text.slice(cursor, start)}</span>);
    parts.push(<mark key={`m${start}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(<span key={`g${cursor}`}>{text.slice(cursor)}</span>);
  return <>{parts}</>;
}

function SearchHitRow({ hit }: { hit: SearchHit }) {
  const { actions } = useApp();
  const fileBasename = hit.fileName.split('/').pop() ?? hit.fileName;
  // No term highlighting on semantic snippets: a semantic hit isn't a
  // literal substring match, so marking the query words is misleading —
  // only keyword search (real ranges) highlights. Plain, truncated text.
  const snippet = hit.content.length > 240 ? hit.content.slice(0, 240) + '…' : hit.content;
  return (
    <div
      className="search-hit"
      onClick={() => {
        void actions.selectFileWithHighlight(hit.fileName, {
          startLine: hit.startLine,
          endLine: hit.endLine,
          chunkText: hit.content,
          pdfPage: hit.pdfPage,
        });
      }}
      title={hit.fileName}
    >
      {hit.heading && <div className="search-hit-heading">{hit.heading}</div>}
      <div className="search-hit-snippet">{snippet}</div>
      <div className="search-hit-meta">
        <span className="search-hit-file">{fileBasename}</span>
      </div>
    </div>
  );
}
