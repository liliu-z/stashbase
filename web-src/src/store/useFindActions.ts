import { useCallback, useRef, type MutableRefObject } from 'react';
import type { FindController, MatchInfo } from './actionTypes';
import type { Action, State } from './state';

type Dispatch = (action: Action) => void;

/** Owns focus routing and the active document view's find controller. */
export function useFindActions(stateRef: MutableRefObject<State>, dispatch: Dispatch) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const findControllerRef = useRef<FindController | null>(null);

  const applyMatchInfo = useCallback(async (
    pending: MatchInfo | Promise<MatchInfo>,
  ): Promise<void> => {
    const info = await Promise.resolve(pending);
    dispatch({ type: 'FIND_SET', patch: { current: info.current, total: info.total } });
  }, [dispatch]);

  const registerSearchInput = useCallback((element: HTMLInputElement | null) => {
    searchInputRef.current = element;
  }, []);

  const focusSearch = useCallback(() => {
    const state = stateRef.current;
    if (state.sidebarCollapsed) {
      dispatch({ type: 'SIDEBAR_SET_COLLAPSED', collapsed: false });
    }
    if (state.activeSidebarView !== 'search') {
      dispatch({ type: 'SIDEBAR_VIEW', view: 'search' });
    }
    requestAnimationFrame(() => {
      const element = searchInputRef.current;
      if (!element) return;
      element.focus();
      element.select();
      element.classList.remove('flash-focus');
      void element.offsetWidth;
      element.classList.add('flash-focus');
    });
  }, [dispatch, stateRef]);

  const registerFindController = useCallback((controller: FindController | null) => {
    const previous = findControllerRef.current;
    if (previous && previous !== controller) previous.close();
    findControllerRef.current = controller;
    if (!controller) return;
    const { query, wholeWord, caseSensitive, open } = stateRef.current.find;
    if (open && query) {
      void applyMatchInfo((controller.restoreQuery ?? controller.setQuery)(query, { wholeWord, caseSensitive }));
    }
  }, [applyMatchInfo, stateRef]);

  const openFind = useCallback(() => {
    dispatch({ type: 'FIND_OPEN' });
  }, [dispatch]);

  const closeFind = useCallback(() => {
    findControllerRef.current?.close();
    dispatch({ type: 'FIND_CLOSE' });
  }, [dispatch]);

  const setFindQuery = useCallback((query: string) => {
    dispatch({ type: 'FIND_SET', patch: { query } });
    const controller = findControllerRef.current;
    if (!controller) {
      dispatch({ type: 'FIND_SET', patch: { current: 0, total: 0 } });
      return;
    }
    const { wholeWord, caseSensitive } = stateRef.current.find;
    void applyMatchInfo(controller.setQuery(query, { wholeWord, caseSensitive }));
  }, [applyMatchInfo, dispatch, stateRef]);

  const toggleFindCaseSensitive = useCallback(() => {
    const next = !stateRef.current.find.caseSensitive;
    dispatch({ type: 'FIND_SET', patch: { caseSensitive: next } });
    const controller = findControllerRef.current;
    if (!controller) return;
    const { query, wholeWord } = stateRef.current.find;
    void applyMatchInfo(controller.setQuery(query, { wholeWord, caseSensitive: next }));
  }, [applyMatchInfo, dispatch, stateRef]);

  const toggleFindWholeWord = useCallback(() => {
    const next = !stateRef.current.find.wholeWord;
    dispatch({ type: 'FIND_SET', patch: { wholeWord: next } });
    const controller = findControllerRef.current;
    if (!controller) return;
    const { query, caseSensitive } = stateRef.current.find;
    void applyMatchInfo(controller.setQuery(query, { wholeWord: next, caseSensitive }));
  }, [applyMatchInfo, dispatch, stateRef]);

  const findNext = useCallback(() => {
    const controller = findControllerRef.current;
    if (controller) void applyMatchInfo(controller.next());
  }, [applyMatchInfo]);

  const findPrev = useCallback(() => {
    const controller = findControllerRef.current;
    if (controller) void applyMatchInfo(controller.prev());
  }, [applyMatchInfo]);

  return {
    closeFind,
    findNext,
    findPrev,
    focusSearch,
    openFind,
    registerFindController,
    registerSearchInput,
    setFindQuery,
    toggleFindCaseSensitive,
    toggleFindWholeWord,
  };
}
