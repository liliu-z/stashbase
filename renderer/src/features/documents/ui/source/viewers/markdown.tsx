import type { RevisionReview } from '@/features/documents/domain/revision';
import { MarkdownDocument } from '@/features/documents/ui/markdown/document';
import { TextSurface } from '@/features/documents/ui/source/text';
import type { DocumentViewerProps } from '@/features/documents/ui/source/viewer';

export default function MarkdownViewer({
  active,
  humanizeApi,
  name,
  navigation,
  onAskAgent,
  onNavigate,
  onOpenExternal,
  runtime,
  sourceApi,
  status,
}: DocumentViewerProps<
  'humanizeApi' | 'navigation' | 'onAskAgent' | 'onNavigate' | 'onOpenExternal' | 'sourceApi'
>) {
  // Read live, not captured: the request outlives any one render and must
  // see the buffer as it is when the rewrite lands.
  const humanize = humanizeApi
    ? {
        api: humanizeApi,
        editor: () => runtime.store.getState().editor,
        reviewOpen: () => runtime.store.getState().revision.kind !== 'idle',
        start: (review: RevisionReview, currentBody: string) =>
          runtime.startRevision(review, currentBody),
      }
    : undefined;
  return (
    <TextSurface
      active={active}
      editorLabel="Markdown editor"
      name={name}
      runtime={runtime}
      sourceApi={sourceApi}
      status={status}
    >
      {({ access, editor, markdownMode, onChange, readOnly, revision, value }) => (
        <MarkdownDocument
          // Milkdown refuses outside text while the document is dirty, which is
          // right for a refetch and wrong for a restored draft; a restore remounts.
          active={active}
          canChangeMode={access === 'editable' && editor !== null}
          dirty={editor !== null && editor.value !== editor.baseline}
          humanize={humanize}
          mode={markdownMode}
          name={name}
          navigation={navigation}
          onAskAgent={onAskAgent}
          onChange={onChange}
          onModeChange={(mode) => runtime.setMarkdownMode(mode)}
          onNavigate={onNavigate}
          onOpenExternal={onOpenExternal}
          readOnly={readOnly || markdownMode === 'reading'}
          revision={{
            onControls: runtime.bindRevisionControls,
            onPending: runtime.publishRevisionCount,
            state: revision,
          }}
          source={runtime.scope.source}
          tabId={runtime.scope.id}
          value={value}
        />
      )}
    </TextSurface>
  );
}
