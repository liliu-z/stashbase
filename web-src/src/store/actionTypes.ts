import type { EditorState } from '@codemirror/state';

/** A tab-local CodeMirror snapshot retained while Reading View is mounted. */
export interface EditorSession {
  version: number;
  state: EditorState;
  scrollTop: number;
  scrollLeft: number;
}

/** Imperative handle a `<CodeEditor>` registers on mount so save,
 * rename, and file-switch actions can pull the live buffer. */
export interface EditorHandle {
  getValue: () => string;
  focus: () => void;
}

export interface MatchInfo {
  current: number;
  total: number;
}

export interface FindOptions {
  wholeWord: boolean;
  caseSensitive: boolean;
}

/** Per-view find driver registered by the currently rendered document view. */
export interface FindController {
  setQuery: (query: string, opts: FindOptions) => MatchInfo | Promise<MatchInfo>;
  /** Reapply an already-open query without moving a restored selection. */
  restoreQuery?: (query: string, opts: FindOptions) => MatchInfo | Promise<MatchInfo>;
  next: () => MatchInfo | Promise<MatchInfo>;
  prev: () => MatchInfo | Promise<MatchInfo>;
  close: () => void;
}
