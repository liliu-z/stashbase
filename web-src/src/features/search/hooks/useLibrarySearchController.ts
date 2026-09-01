/**
 * Everything the library search popup DOES, separated from what it looks
 * like: query/mode/scope/result state, the debounced and immediate search
 * runs, module-memory persistence, keyboard-entry bookkeeping, and result
 * activation. `ManagedLibrarySearch.tsx` calls this once and renders what
 * comes back.
 *
 * State lives here rather than in the reducer for the reason `librarySearch.ts`
 * documents: the popup must survive close/reopen AND folder switches, both of
 * which wipe folder-scoped reducer fields.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, type KeywordMatch } from '@/common/api/api';
import { useLatestRef } from '@/common/hooks/useLatestRef';
import type { LibrarySearchMode, LibrarySearchPrefill } from '@/common/lib/librarySearchTrigger';
import { useAppActions, useWorkspace } from '@/store/contexts/AppContext';
import { folderRefsEqual } from '@/store/lib/folderPath';
import type { PendingHighlight } from '@/store/state/state';
import {
  applyLibrarySearchPrefill,
  folderBasename,
  readLibrarySearchMemory,
  resolveSemanticHits,
  writeLibrarySearchMemory,
  type LibrarySearchScope,
} from '@/features/search/lib/librarySearch';
import { buildSearchEntries, type ResultEntry, type RowProps } from '@/features/search/lib/searchResultGrouping';

/** Sentinel kept out of user-facing copy: rendering special-cases the
 *  missing-embedding-key state instead of showing a raw error line. */
export const EMBEDDER_KEY_ERROR = 'embedder-key-required';

/** Also the display cap: every fetched hit is listed, strongest first,
 *  so this bounds the list itself rather than an initial slice. */
const SEMANTIC_SEARCH_CANDIDATES = 30;

interface RunOpts {
  query: string;
  mode: LibrarySearchMode;
  scope: LibrarySearchScope;
}

export function useLibrarySearchController({ prefill, onClose }: {
  prefill?: LibrarySearchPrefill | null;
  onClose: () => void;
}) {
  const state = useWorkspace();
  const { actions, dispatch } = useAppActions();
  const initial = useRef(applyLibrarySearchPrefill(readLibrarySearchMemory(), prefill)).current;
  const [query, setQuery] = useState(initial.query);
  const [mode, setMode] = useState<LibrarySearchMode>(initial.mode);
  const [scope, setScope] = useState<LibrarySearchScope>(initial.scope);
  const [semanticHits, setSemanticHits] = useState(initial.semanticHits);
  const [keywordResult, setKeywordResult] = useState(initial.keywordResult);
  const [error, setError] = useState(initial.error);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const folderPathRef = useLatestRef(state.folderPath);
  const folderRoots = useMemo(() => {
    const roots = state.recent.map((entry) => entry.path);
    if (state.folderPath && !roots.some((root) => folderRefsEqual(root, state.folderPath))) {
      roots.push(state.folderPath);
    }
    return roots;
  }, [state.recent, state.folderPath]);
  const folderRootsRef = useLatestRef(folderRoots);
  const hasLibrary = folderRoots.length > 0;
  const librarySpansFolders = folderRoots.length > 1;

  // Every state change lands in module memory so close/reopen — and any
  // folder switch while the popup is away — restore it exactly.
  useEffect(() => {
    writeLibrarySearchMemory({ query, mode, scope, semanticHits, keywordResult, error });
  }, [query, mode, scope, semanticHits, keywordResult, error]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, []);

  const runSearch = useCallback(async (opts: RunOpts) => {
    const myGen = ++generation.current;
    const q = opts.query.trim();
    if (!q) {
      setSemanticHits(null);
      setKeywordResult(null);
      setError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const stale = () => myGen !== generation.current;
    // A folder scope names its folder outright, so it needs no reference
    // to the window's current folder and survives a switch untouched.
    const folderScope = opts.scope.kind === 'folder' ? { folder: opts.scope.path } : {};
    try {
      if (opts.mode === 'keyword') {
        // Exact search is plain, case-insensitive substring matching:
        // the popup offers no case/whole-word latches, so it must never
        // send options the user cannot see or unset.
        const result = await api.libraryKeywordSearch(q, folderScope);
        if (stale()) return;
        setKeywordResult(result);
        setSemanticHits(null);
        setError(null);
      } else {
        const embedder = await api.getEmbedder();
        if (stale()) return;
        dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: embedder.authorized });
        if (!embedder.authorized) {
          setError(EMBEDDER_KEY_ERROR);
          setSemanticHits(null);
          setSearching(false);
          return;
        }
        if (embedder.source === 'stashbase-account' && embedder.account.quota?.remainingTokens === 0) {
          setError('Your hosted Similarity Search allowance is exhausted. Exact Search is still available.');
          setSemanticHits(null);
          setSearching(false);
          return;
        }
        const { hits } = await api.librarySearch(q, SEMANTIC_SEARCH_CANDIDATES, folderScope);
        if (stale()) return;
        const resolved = resolveSemanticHits(hits, folderRootsRef.current);
        setSemanticHits(resolved);
        setKeywordResult(null);
        setError(null);
      }
      setSearching(false);
    } catch (err) {
      if (stale()) return;
      const message = errorMessage(err);
      console.warn(`[library-search:${opts.mode}] failed:`, message);
      setError(message);
      setSearching(false);
    }
  }, [dispatch]);

  // Keep results fresh against current content: fires on mount (a reopened
  // popup silently refreshes its remembered results) and whenever a note
  // lands or a conversion finishes while the popup stays open. Old results
  // stay visible until the fresh response arrives, so this never flashes.
  useEffect(() => {
    if (query.trim()) void runSearch({ query, mode, scope });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.files, state.pendingConversions]);

  /** Cancel a pending keystroke debounce — every immediate run must win
   *  over it, or the debounce would later re-run with stale options. */
  function cancelDebounce() {
    if (debounce.current) {
      clearTimeout(debounce.current);
      debounce.current = null;
    }
  }

  function onQueryChange(value: string) {
    setQuery(value);
    setActive(0);
    cancelDebounce();
    if (!value.trim()) {
      void runSearch({ query: '', mode, scope });
      return;
    }
    debounce.current = setTimeout(() => {
      debounce.current = null;
      void runSearch({ query: value, mode, scope });
    }, 250);
  }

  function rerun(next: Partial<RunOpts>) {
    cancelDebounce();
    if (query.trim()) void runSearch({ query, mode, scope, ...next });
  }

  function setSearchMode(next: LibrarySearchMode) {
    setMode(next);
    setActive(0);
    rerun({ mode: next });
  }

  function setSearchScope(next: LibrarySearchScope) {
    setScope(next);
    setActive(0);
    rerun({ scope: next });
  }

  const activeFolderPath = state.folderPath;

  // One flat entry list drives keyboard navigation, aria ids, and click
  // handling; the render walks the same grouped structures in the same
  // order, and every `index` is the entry's position in that flat list.
  const { entries, semanticView, keywordGroups } = useMemo(
    () => buildSearchEntries({ mode, semanticHits, keywordResult, activeFolderPath }),
    [mode, semanticHits, keywordResult, activeFolderPath],
  );

  useEffect(() => {
    if (active >= entries.length) setActive(Math.max(0, entries.length - 1));
  }, [active, entries.length]);

  useEffect(() => {
    document.getElementById(`library-search-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  /** Open one result WITHOUT switching the window's folder: same-folder
   *  hits go through normal selection, cross-folder hits open an
   *  out-of-folder read-only tab. Only the no-folder workspace binds the
   *  folder first — there is no context to preserve there. */
  function openTarget(folder: string, rel: string, hit: PendingHighlight) {
    onClose();
    const current = folderPathRef.current;
    if (!current) {
      void actions.openFolder(folder)
        .then(() => {
          // A superseding open may have won the race — never select into
          // whatever folder happens to be current now.
          if (!folderRefsEqual(folderPathRef.current, folder)) return;
          return actions.selectFileWithHighlight(rel, hit).then(() => revealAncestors(rel));
        })
        .catch((err: unknown) => {
          actions.toast(`Could not open ${folderBasename(folder)}: ${errorMessage(err)}`, { level: 'error' });
        });
      return;
    }
    const sameFolder = folderRefsEqual(folder, current);
    void actions.openLibraryFile(folder, rel, { hit }).then(() => {
      if (sameFolder) revealAncestors(rel);
    });
  }

  /** The tree keeps ancestors collapsed after switches; expand the opened
   *  file's chain so its selected row is actually visible. Active-folder
   *  targets only — the tree does not show other folders. */
  function revealAncestors(rel: string) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      dispatch({ type: 'EXPAND_FOLDER', path: parts.slice(0, i).join('/') });
    }
  }

  function keywordHighlight(match: KeywordMatch | undefined): PendingHighlight {
    return {
      startLine: match?.line,
      chunkText: query.trim(),
      audioSeekText: match?.text,
      audioSeekMs: match?.audioTimestampMs,
      openFindBar: true,
      pdfPage: match?.pdfPage,
    };
  }

  function activateEntry(entry: ResultEntry) {
    switch (entry.kind) {
      case 'semantic':
        openTarget(entry.hit.folder, entry.hit.rel, {
          startLine: entry.hit.startLine,
          endLine: entry.hit.endLine,
          chunkText: entry.hit.content,
          pdfPage: entry.hit.pdfPage,
        });
        break;
      case 'file':
        openTarget(entry.file.folder, entry.file.path, keywordHighlight(entry.file.matches[0]));
        break;
      case 'match':
        openTarget(entry.file.folder, entry.file.path, keywordHighlight(entry.match));
        break;
    }
  }

  const rowProps = (index: number): RowProps => ({
    id: `library-search-${index}`,
    role: 'option',
    'aria-selected': index === active,
    onMouseMove: () => setActive(index),
    onMouseDown: (event) => {
      event.preventDefault();
      activateEntry(entries[index]);
    },
  });

  return {
    query,
    mode,
    scope,
    searching,
    error,
    semanticHits,
    keywordResult,
    entries,
    semanticView,
    keywordGroups,
    active,
    setActive,
    inputRef,
    hasLibrary,
    librarySpansFolders,
    onQueryChange,
    setSearchMode,
    setSearchScope,
    activateEntry,
    rowProps,
  };
}
