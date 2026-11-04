/**
 * The frame every editable text format shares: load the versioned source,
 * surface a refresh that failed, hand a conflict to the comparison view, and
 * report the save outcome. The format-specific editor is the child, so
 * Markdown, JSON, and plain text differ only in what they render inside.
 */
import { AlertCircle, LockKeyhole, TriangleAlert } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import type { DocumentRuntime } from '@/features/documents/application/document-runtime';
import { DOCUMENT_SOURCE_MESSAGES } from '@/features/documents/application/failure-messages';
import type { DocumentSourcePort } from '@/features/documents/application/ports';
import {
  documentSaveMessage,
  type DocumentAccess,
  type DocumentEditorState,
  type DocumentSaveState,
} from '@/features/documents/domain/document';
import type { DocumentRevision } from '@/features/documents/domain/revision';
import { useDocumentSource } from '@/features/documents/hooks/use-document-source';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import { NoticeStrip } from '@/shared/ui/notice';

import { DocumentPending } from './status';
import type { DocumentViewerStatus } from './viewer';

const DocumentConflict = lazy(async () => {
  const module = await import('./conflict');
  return { default: module.DocumentConflict };
});

/** What the format-specific editor is handed once the source has landed. */
interface TextSurfaceSlot {
  access: DocumentAccess;
  editor: DocumentEditorState | null;
  markdownMode: 'reading' | 'writer';
  onChange(value: string): void;
  readOnly: boolean;
  revision: DocumentRevision;
  value: string;
}

export interface TextSurfaceProps {
  active: boolean;
  children(slot: TextSurfaceSlot): ReactNode;
  editorLabel: string;
  name: string;
  runtime: DocumentRuntime;
  sourceApi: DocumentSourcePort;
  status(status: DocumentViewerStatus): ReactNode;
}

function SaveFeedback({
  restore,
  retry,
  save,
}: {
  restore: () => void;
  retry: () => void;
  save: DocumentSaveState;
}) {
  const shape = useShape();
  if (save.kind !== 'detached' && save.kind !== 'failed' && save.kind !== 'warned') return null;
  // A detached draft reads as a failure because that is what it is: nothing is
  // writing this text anywhere. Autosave has stopped, so the action beside the
  // sentence is the only writer left, and it is the reader's to press. What it
  // offers differs: a failed write can simply be repeated, while a draft whose
  // file is gone needs that file created, which only the reader may ask for.
  const detached = save.kind === 'detached';
  const failed = detached || save.kind === 'failed';
  const text = documentSaveMessage(save) ?? '';

  return (
    <div
      className={cn(
        'absolute right-4 bottom-3 flex max-w-[min(32rem,calc(100%-2rem))] items-center gap-2 border border-border/50 bg-background px-2.5 py-1.5 text-caption shadow-sm',
        shape.item,
      )}
      data-save-state={save.kind}
    >
      {failed ? (
        <AlertCircle
          aria-hidden="true"
          className="size-3.5 shrink-0 text-destructive"
          strokeWidth={1.5}
        />
      ) : (
        <TriangleAlert
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
          strokeWidth={1.5}
        />
      )}
      <span
        className={
          failed ? 'min-w-0 truncate text-destructive' : 'min-w-0 truncate text-muted-foreground'
        }
        role={failed ? 'alert' : 'status'}
        title={text}
      >
        {text}
      </span>
      {failed && (
        <Button onClick={detached ? restore : retry} size="compact" variant="tertiary">
          {detached ? 'Restore file' : 'Retry'}
        </Button>
      )}
    </div>
  );
}

export function TextSurface({
  active,
  children,
  editorLabel,
  name,
  runtime,
  sourceApi,
  status,
}: TextSurfaceProps) {
  const {
    access,
    change,
    editor,
    finishMerge,
    markdownMode,
    mutationPending,
    resolveConflict,
    restoreSource,
    retrySave,
    revision,
    source,
  } = useDocumentSource(runtime, sourceApi, active);

  if (source.isPending && !editor) return <>{status({ name })}</>;
  if (!source.data && !editor) {
    return <>{status({ error: source.error, name, retry: () => void source.refetch() })}</>;
  }
  if (access === 'editable' && !editor) return <>{status({ name })}</>;

  const conflict = editor?.save.kind === 'conflict' ? editor.save.conflict : null;
  if (access === 'editable' && conflict) {
    return (
      <Suspense fallback={<DocumentPending label="Loading conflict comparison" />}>
        <DocumentConflict conflict={conflict} name={name} resolve={resolveConflict} />
      </Suspense>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-document-access={access}>
      {access === 'read-only' && (
        <NoticeStrip className="text-muted-foreground">
          <LockKeyhole aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.5} />
          Read-only source from another project folder
        </NoticeStrip>
      )}
      {/* Always mounted, so a background refresh changes only this text:
          inserting the element shifted the column and relaid out the editor. */}
      <span className="sr-only" role="status">
        {source.isFetching ? `Refreshing ${name}` : ''}
      </span>
      {source.isError && (
        <NoticeStrip action={{ label: 'Retry', onAct: () => void source.refetch() }} role="status">
          {source.error instanceof Error &&
          'kind' in source.error &&
          source.error.kind === 'missing'
            ? DOCUMENT_SOURCE_MESSAGES.missing
            : 'Refresh failed. Showing the last loaded source.'}
        </NoticeStrip>
      )}
      {mutationPending && (
        <NoticeStrip role="status">
          Waiting for the file operation to finish. If it failed, retry it in Files.
        </NoticeStrip>
      )}
      {editor?.save.kind === 'merging' && (
        <NoticeStrip
          action={{
            busy: editor.save.finishing,
            label: 'Finish merge',
            onAct: () => void finishMerge(),
          }}
          role="status"
        >
          {editor.save.message ?? 'Merge in progress. Autosave is paused until you finish.'}
        </NoticeStrip>
      )}
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<DocumentPending label={`Loading ${editorLabel}`} />}>
          {children({
            access,
            editor,
            markdownMode,
            onChange: change,
            readOnly:
              mutationPending ||
              access === 'read-only' ||
              editor === null ||
              (editor.save.kind === 'merging' && editor.save.finishing),
            revision,
            value: editor?.value ?? source.data?.content ?? '',
          })}
        </Suspense>
        {access === 'editable' && editor && (
          <SaveFeedback
            restore={() => void restoreSource()}
            retry={() => void retrySave()}
            save={editor.save}
          />
        )}
      </div>
    </div>
  );
}
