import { MarkdownDocument } from '@/features/documents/ui/markdown/document';
import { TextSurface } from '@/features/documents/ui/source/text';
import type { DocumentViewerProps } from '@/features/documents/ui/source/viewer';

export default function MarkdownViewer({
  active,
  name,
  navigation,
  onAskAgent,
  onNavigate,
  onOpenExternal,
  renderReadingControl,
  runtime,
  sourceApi,
  status,
}: DocumentViewerProps<
  | 'navigation'
  | 'onAskAgent'
  | 'onNavigate'
  | 'onOpenExternal'
  | 'renderReadingControl'
  | 'sourceApi'
>) {
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
          mode={markdownMode}
          name={name}
          navigation={navigation}
          onAskAgent={onAskAgent}
          onChange={onChange}
          onModeChange={(mode) => runtime.setMarkdownMode(mode)}
          onNavigate={onNavigate}
          onOpenExternal={onOpenExternal}
          readingControl={renderReadingControl?.()}
          readOnly={readOnly || markdownMode === 'reading'}
          revision={{
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
