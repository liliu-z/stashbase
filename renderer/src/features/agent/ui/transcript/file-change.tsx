/**
 * The evidence behind a file change: one read-only unified diff per change,
 * in the same mono surface as the code editor, with the runtime's own text
 * on both sides. Added lines read green and removed lines red through the
 * theme's own diff tokens.
 */
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Chunk, unifiedMergeView } from '@codemirror/merge';
import { Compartment, EditorState, Text } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { useEffect, useMemo, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { FileTypeIcon } from '@/components/ui/file-type-icon';
import {
  FILE_CHANGE_ACTION_LABEL,
  fileBasename,
  type AgentFileChange,
} from '@/features/agent/domain/file-change';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import type { SourceReference } from '@/shared/domain/source-reference';
import { codeSyntaxHighlighting } from '@/shared/styling/code-highlight';

// A base theme, not a theme: only base themes may address the merge view's
// own `&light`/`&dark` rules at equal specificity. Base themes mount in
// reverse extension order, so this one sits before the merge extension to
// win the cascade.
const diffTheme = EditorView.baseTheme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    fontSize: '12px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55', overflow: 'visible' },
  '.cm-content': { padding: '4px 0' },
  '.cm-line': { padding: '0 10px 0 8px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: '0',
    color: 'var(--muted-foreground)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '2.5ch',
    padding: '0 4px 0 8px',
    textAlign: 'right',
  },
  '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': {
    backgroundColor: 'var(--diff-add-line)',
  },
  '.cm-deletedChunk': {
    backgroundColor: 'var(--diff-remove-line)',
    paddingLeft: '8px',
  },
  '&light.cm-merge-b .cm-changedText, &dark.cm-merge-b .cm-changedText': {
    background: 'var(--diff-add-token)',
    borderRadius: '2px',
  },
  '&light .cm-deletedChunk .cm-deletedText, &dark .cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText':
    {
      background: 'var(--diff-remove-token)',
      borderRadius: '2px',
    },
  '.cm-changeGutter': { paddingLeft: '1px', width: '3px' },
  '&light.cm-merge-b .cm-changedLineGutter, &dark.cm-merge-b .cm-changedLineGutter': {
    background: 'var(--diff-add)',
  },
  '&light .cm-deletedLineGutter, &dark .cm-deletedLineGutter': {
    background: 'var(--diff-remove)',
  },
  '&light .cm-collapsedLines, &dark .cm-collapsedLines': {
    background: 'var(--hover)',
    color: 'var(--muted-foreground)',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans, inherit)',
    fontSize: '11px',
    padding: '2px 10px',
  },
  '.cm-collapsedLines:before, .cm-collapsedLines:after': { content: '""', margin: '0' },
});

function toDoc(text: string): Text {
  return Text.of(text.split('\n'));
}

function lineSpan(doc: Text, from: number, to: number): number {
  if (to <= from) return 0;
  return doc.lineAt(to - 1).number - doc.lineAt(from).number + 1;
}

/** Added and removed line counts from the same chunking the view draws. */
export function fileChangeCounts(
  before: string,
  after: string,
): { additions: number; deletions: number } {
  const a = toDoc(before);
  const b = toDoc(after);
  let additions = 0;
  let deletions = 0;
  for (const chunk of Chunk.build(a, b)) {
    deletions += lineSpan(a, chunk.fromA, chunk.toA);
    additions += lineSpan(b, chunk.fromB, chunk.toB);
  }
  return { additions, deletions };
}

function UnifiedDiff({
  after,
  before,
  extent,
  label,
  path,
}: {
  after: string;
  before: string;
  extent: 'file' | 'fragment';
  label: string;
  path: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const syntax = new Compartment();
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: after,
        extensions: [
          diffTheme,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          extent === 'file' ? lineNumbers() : [],
          unifiedMergeView({
            collapseUnchanged: { margin: 2, minSize: 4 },
            // Word marks explain an edit; a created or emptied file is all
            // one change, and marking every token would only add noise.
            highlightChanges: before !== '' && after !== '',
            mergeControls: false,
            original: before,
            syntaxHighlightDeletions: true,
          }),
          syntax.of([]),
          EditorView.contentAttributes.of({ 'aria-label': label }),
        ],
      }),
    });
    let destroyed = false;
    const description = LanguageDescription.matchFilename(languages, fileBasename(path));
    if (description) {
      void description.load().then((support) => {
        if (destroyed) return;
        view.dispatch({ effects: syntax.reconfigure([support, codeSyntaxHighlighting]) });
      });
    }
    return () => {
      destroyed = true;
      view.destroy();
    };
  }, [after, before, extent, label, path]);
  return <div className="text-foreground" ref={host} />;
}

/** A unified patch the runtime handed over as text: the same tints, applied
 *  per line by its marker. */
function PatchView({ label, patch }: { label: string; patch: string }) {
  const lines = patch.replace(/\n$/u, '').split('\n');
  // Each line's offset in the patch is its own identity, so the list keys on
  // the data rather than on its position.
  let cursor = 0;
  const rows = lines.map((line) => {
    const row = { line, offset: cursor };
    cursor += line.length + 1;
    return row;
  });
  return (
    <pre
      aria-label={label}
      className="m-0 py-1 font-mono text-[12px] leading-[1.55] break-words whitespace-pre-wrap"
    >
      {rows.map(({ line, offset }) => {
        const header = line.startsWith('+++') || line.startsWith('---');
        const kind = header
          ? 'meta'
          : line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'del'
              : line.startsWith('@@')
                ? 'meta'
                : 'ctx';
        return (
          <span
            className={cn(
              'block px-2',
              kind === 'add' && 'bg-[var(--diff-add-line)]',
              kind === 'del' && 'bg-[var(--diff-remove-line)]',
              kind === 'meta' && 'text-muted-foreground',
            )}
            data-line={kind}
            key={offset}
          >
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span
      aria-label={`${additions} added, ${deletions} removed`}
      className="ml-auto flex shrink-0 gap-1.5 font-mono text-[11px] tabular-nums"
    >
      {additions > 0 && <span className="text-diff-add">+{additions}</span>}
      {deletions > 0 && <span className="text-diff-remove">−{deletions}</span>}
    </span>
  );
}

/** One change as evidence: the file strip, then its diff or patch. */
export function AgentFileChangeView({ change }: { change: AgentFileChange }) {
  const shape = useShape();
  const name = fileBasename(change.path);
  const directory = change.path.slice(0, change.path.length - name.length).replace(/[\\/]$/u, '');
  const counts = useMemo(
    () =>
      change.counts ??
      (change.text ? fileChangeCounts(change.text.before, change.text.after) : null),
    [change],
  );
  const label = `${FILE_CHANGE_ACTION_LABEL[change.action]} ${name}`;
  return (
    <section
      aria-label={label}
      className={cn('overflow-hidden border border-border bg-surface-2', shape.panel)}
    >
      <header className="flex h-7 items-center gap-1.5 border-b border-border px-2.5 text-[12px]">
        <FileTypeIcon
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
          path={change.path}
          size={12}
        />
        <span className="shrink-0 font-medium text-foreground" title={change.path}>
          {name}
        </span>
        {directory && (
          <span className="min-w-0 truncate text-muted-foreground" title={change.path}>
            {directory}
          </span>
        )}
        <span className="shrink-0 text-muted-foreground">
          {FILE_CHANGE_ACTION_LABEL[change.action]}
        </span>
        {counts && <Counts additions={counts.additions} deletions={counts.deletions} />}
      </header>
      <div className="max-h-72 overflow-auto">
        {change.text ? (
          <UnifiedDiff
            after={change.text.after}
            before={change.text.before}
            extent={change.text.extent}
            label={`${label} diff`}
            path={change.path}
          />
        ) : change.patch ? (
          <PatchView label={`${label} patch`} patch={change.patch} />
        ) : null}
      </div>
    </section>
  );
}

/** What a settled activity group left behind: each changed file once, with
 *  an Open that routes through the workspace and never steals focus. */
export function AgentChangedFiles({
  changes,
  onOpenSource,
  sourceFor,
}: {
  changes: readonly AgentFileChange[];
  onOpenSource?: ((source: SourceReference, phrase: string | null) => void) | undefined;
  sourceFor?: ((path: string) => SourceReference | null) | undefined;
}) {
  const shape = useShape();
  if (changes.length === 0) return null;
  return (
    <ul aria-label="Changed files" className="m-0 flex list-none flex-col gap-0.5 p-0">
      {changes.map((change) => {
        const name = fileBasename(change.path);
        const directory = change.path
          .slice(0, change.path.length - name.length)
          .replace(/[\\/]$/u, '');
        const source = onOpenSource && sourceFor ? sourceFor(change.path) : null;
        return (
          <li
            className={cn('flex min-h-8 items-center gap-2 px-2 text-[12px]', shape.item)}
            key={change.path}
          >
            <FileTypeIcon
              aria-hidden="true"
              className="shrink-0 text-muted-foreground"
              path={change.path}
              size={14}
            />
            <span className="shrink-0 font-medium text-foreground" title={change.path}>
              {name}
            </span>
            {directory && (
              <span className="min-w-0 truncate text-muted-foreground" title={change.path}>
                {directory}
              </span>
            )}
            <span className="ml-auto shrink-0 text-muted-foreground">
              {FILE_CHANGE_ACTION_LABEL[change.action]}
            </span>
            {source && (
              <Button
                aria-label={`Open ${name}`}
                className="-my-1"
                onClick={() => onOpenSource?.(source, null)}
                size="compact"
                variant="ghost"
              >
                Open
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
