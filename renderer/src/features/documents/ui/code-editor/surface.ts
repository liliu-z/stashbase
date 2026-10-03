import type { Extension } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
} from '@codemirror/view';

import { codeSyntaxHighlighting } from '@/shared/styling/code-highlight';

export { codeSyntaxHighlighting };

const codeSurfaceTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    fontSize: 'var(--fs-body, 13px)',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  // The current line marks where typing lands, so it is painted only while
  // the editor has focus; an unfocused editor would otherwise show a second
  // caret line beside the one the reader is actually typing in.
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine, &.cm-focused .cm-activeLineGutter': {
    backgroundColor: 'var(--hover)',
  },
  '.cm-content': {
    caretColor: 'var(--foreground)',
    fontFamily: 'var(--code-font, var(--font-mono))',
    lineHeight: '1.55',
    padding: '12px 0 64px',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: '0',
    color: 'var(--muted-foreground)',
  },
  '.cm-line': { padding: '0 6px', position: 'relative' },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '2.5ch',
    padding: '0 4px',
    textAlign: 'right',
  },
  '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selected) !important' },
});

export const codeSurfaceExtensions: Extension = [
  lineNumbers(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  EditorView.lineWrapping,
  codeSurfaceTheme,
];
