/** Binds the visible request, source context, uploads, and queue to its session. */
import { Paperclip } from 'lucide-react';
import {
  useId,
  useMemo,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import {
  InputMessage,
  type InputMessageEditorContext,
  type QueuedMessage,
} from '@/components/ui/input-message';
import { Tooltip } from '@/components/ui/tooltip';
import type { AgentSessionRuntime } from '@/features/agent/application/session-runtime';
import {
  contextItemKey,
  removeMentionText,
  segmentFileMentions,
  validateContext,
  type AgentContextItem,
  type AgentScopeEnvironment,
  type ContextStatus,
} from '@/features/agent/domain/context';
import { fileContextItem, isDraftTile } from '@/features/agent/domain/draft-context';
import { agentSkills } from '@/features/agent/domain/session';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import { isExternalSource } from '@/shared/domain/external-source';
import type { SourceReference } from '@/shared/domain/source-reference';
import { FailureLine } from '@/shared/ui/failure-notice';
import { dragCarriesSource, readSourceDrag } from '@/shared/utils/source-drag';

import { MentionRowsListbox, useMentionRows } from './context-rows';
import { DraftSourceTiles, isVisualSource } from './context-tiles';
import { useComposerFocusRequest } from './focus';
import { MentionEditor, type MentionEditorHandle, type MentionEditorProps } from './mention-editor';
import { useComposerUploads } from './use-composer-uploads';
import { useCurrentSource } from './use-current-source';

/** Native picker hint for an Agent that accepts transient local files. The
 * selected runtime decides what it can interpret after the file is attached;
 * the composer must not silently narrow that capability to images and PDFs. */
const ATTACH_ACCEPT = '';

export interface AgentContextComposerProps {
  attachments: boolean;
  environment: AgentScopeEnvironment | null;
  leftSlot?: ReactNode;
  maxRows?: number;
  minRows?: number;
  onQueueChange: (queue: QueuedMessage[]) => void;
  onOpenSource?:
    | ((source: SourceReference, phrase: string | null, quoteFormat?: 'markdown') => void)
    | undefined;
  onReprocess?: ((source: SourceReference) => void) | undefined;
  onRefreshSkills: () => void;
  onSkillChange: (skill: string | null) => void;
  onStop: () => void;
  onSend?: (text: string, options?: { queuedId?: string }) => void;
  /** Present when the runtime can take a follow-up into the running turn. */
  onSteer?: ((text: string) => void) | undefined;
  placeholder: string;
  placeholderIsPrompt?: boolean;
  queue: QueuedMessage[];
  rightSlot?: ReactNode;
  sendable?: boolean;
  session: AgentSessionRuntime;
  skills: boolean;
  status: 'idle' | 'streaming';
}

function onDragOverCapture(event: DragEvent<HTMLDivElement>) {
  if (!dragCarriesSource(event.dataTransfer)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
}

function attachSlot(attachments: boolean, leftSlot: ReactNode) {
  return ({ openFilePicker }: { openFilePicker: () => void }) => (
    <>
      {attachments && (
        <Tooltip content="Attach files" side="top">
          <Button
            aria-label="Attach files"
            onClick={() => openFilePicker()}
            size="icon-compact"
            variant="ghost"
          >
            <Paperclip />
          </Button>
        </Tooltip>
      )}
      {leftSlot}
    </>
  );
}

function mentionEditorSlot(
  props: Omit<MentionEditorProps, 'ctx'> & { ref: Ref<MentionEditorHandle> },
) {
  return (ctx: InputMessageEditorContext) => <MentionEditor {...props} ctx={ctx} />;
}

export function AgentContextComposer({
  attachments,
  environment,
  leftSlot,
  maxRows = 6,
  minRows = 3,
  onQueueChange,
  onOpenSource,
  onRefreshSkills,
  onReprocess,
  onSkillChange,
  onStop,
  onSend,
  onSteer,
  placeholder,
  placeholderIsPrompt = false,
  queue,
  rightSlot,
  sendable = true,
  session,
  skills,
  status,
}: AgentContextComposerProps) {
  const shape = useShape();
  const { context, contextIssue, draft, queuedPrompts, scope, skill, skillCatalog } = useStore(
    session.store,
    useShallow((state) => ({
      context: state.context,
      contextIssue: state.contextIssue,
      draft: state.draft,
      queuedPrompts: state.queuedPrompts,
      scope: state.scope,
      skill: state.skill,
      skillCatalog: state.skillCatalog,
    })),
  );
  const editorRef = useRef<MentionEditorHandle>(null);
  const listboxId = useId();

  useComposerFocusRequest(session, editorRef);

  const scoped =
    environment && scope.kind === 'folder' && environment.folderPath === scope.path
      ? environment
      : null;
  const currentSource = useCurrentSource(scoped, context, session);
  const currentItem = currentSource.item;
  const validations = useMemo(
    () =>
      validateContext(currentItem ? [...context, currentItem] : context, {
        listing: scoped?.listing ?? null,
        readiness: scoped?.readiness ?? {},
        scope,
        versions: scoped?.versions,
        hasUpload: (path) => Boolean(session.fileForTransient(path)),
      }),
    [context, currentItem, scope, scoped, session],
  );
  const issue = contextIssue ?? validations.find((item) => item.status === 'stale')?.reason;
  const chipPaths = useMemo(
    () => context.flatMap((item) => (item.kind === 'source' ? [item.source.path] : [])),
    [context],
  );
  const statuses = useMemo(() => {
    const next: Record<string, ContextStatus> = {};
    for (const validation of validations) {
      if (validation.item.kind === 'source' && validation.status !== 'ready') {
        next[validation.item.source.path] = validation.status;
      }
    }
    return next;
  }, [validations]);
  const mentioned = useMemo(
    () =>
      new Set(
        segmentFileMentions(draft).flatMap((segment) =>
          segment.kind === 'mention' ? [segment.path] : [],
        ),
      ),
    [draft],
  );
  const tileValidations = validations.filter((validation) => isDraftTile(validation, mentioned));

  const { syncUploads, uploads } = useComposerUploads(session, context, queuedPrompts);

  const armedSkill = useMemo(
    () => agentSkills(skillCatalog).find((entry) => entry.id === skill) ?? null,
    [skill, skillCatalog],
  );
  const panel = useMentionRows({
    editorRef,
    listboxId,
    onRefreshSkills,
    onSkillChange,
    scoped,
    skillCatalog,
  });

  const bindSource = (source: SourceReference) => {
    const listed = scoped?.listing.files.find((file) => file.path === source.path);
    session.addContext({
      boundVersion: scoped?.versions[source.path] ?? null,
      format: listed?.format ?? 'generic',
      kind: 'source',
      source,
    });
  };

  const onMentionAdded = (path: string) => {
    if (scope.kind !== 'folder') return;
    if (!scoped?.listing.files.some((file) => file.path === path)) return;
    bindSource({ folderPath: scope.path, path });
  };
  const onMentionRemoved = (path: string) => {
    const bound = context.find((item) => item.kind === 'source' && item.source.path === path);
    if (bound?.kind === 'source') {
      currentSource.dismiss(bound.source);
      session.removeContext(contextItemKey(bound));
    }
  };

  const removeTile = (item: AgentContextItem) => {
    if (item.kind === 'source') currentSource.dismiss(item.source);
    session.removeContext(contextItemKey(item));
    if (item.kind === 'source') session.setDraft(removeMentionText(draft, item.source.path));
  };

  const attachSource = (source: SourceReference) => {
    // An external file has no listing entry or project name to mention; it
    // binds by its own path, as the chip it was offered as.
    if (isExternalSource(source)) {
      session.addContext(fileContextItem(source));
      return;
    }
    const listed = scoped?.listing.files.find((file) => file.path === source.path);
    const visual =
      listed !== undefined &&
      isVisualSource({ boundVersion: null, format: listed.format, kind: 'source', source });
    if (visual || listed?.format === 'generic') {
      bindSource(source);
      return;
    }
    // A non-visual source lives inline; the chip binds it on insertion, and
    // a source outside the listing is still bound explicitly.
    editorRef.current?.insertMention(source.path);
    bindSource(source);
  };

  const onDropCapture = (event: DragEvent<HTMLDivElement>) => {
    if (!dragCarriesSource(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const source = readSourceDrag(event.dataTransfer);
    if (source) attachSource(source);
  };

  const onPasteCapture = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!attachments) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void session.attachFiles(files);
  };

  return (
    <div
      // This wrapper owns the card surface; InputMessage stays transparent.
      className={cn('relative flex flex-col bg-surface-3 shadow-surface-3', shape.card)}
      onDragOverCapture={onDragOverCapture}
      onDropCapture={onDropCapture}
      onPasteCapture={onPasteCapture}
    >
      <MentionRowsListbox id={listboxId} panel={panel} />
      {!attachments && uploads.length > 0 && (
        <FailureLine className="m-0 px-3 pt-2" tone="input">
          This agent cannot use these uploads. Remove them or choose another agent.
        </FailureLine>
      )}
      {issue && (
        <FailureLine className="m-0 px-3 pt-2" tone="input">
          {issue}
        </FailureLine>
      )}
      <InputMessage
        accept={ATTACH_ACCEPT}
        // A row dragged from the tree or a tab is taken by `onDropCapture`
        // above; the box lights for it as it does for a desktop file.
        acceptsDrag={dragCarriesSource}
        // The card above carries the surface and the focus ring; the inner
        // component must not draw its own edge, including its inline one.
        className="bg-transparent shadow-none!"
        files={uploads}
        onFilesChange={syncUploads}
        onEditQueued={session.editQueued}
        editor={mentionEditorSlot({
          chipPaths,
          listbox: panel.binding,
          onMentionAdded,
          onMentionRemoved,
          onQueryChange: panel.onQueryChange,
          onSkillRemoved: () => onSkillChange(null),
          ref: editorRef,
          skill: armedSkill,
          skillsEnabled: skills,
          statuses,
        })}
        leftSlot={attachSlot(attachments, leftSlot)}
        maxRows={maxRows}
        minRows={minRows}
        onQueueChange={(next) => {
          const existing = session.store.getState().queuedPrompts;
          if (next.some((item) => !existing.some((queued) => queued.id === item.id)))
            currentSource.capture();
          onQueueChange(next);
        }}
        onSend={(text, _files, meta) => {
          if (!meta?.queuedId) currentSource.capture();
          void (onSend ?? session.sendPrompt)(
            text,
            meta?.queuedId ? { queuedId: meta.queuedId } : undefined,
          );
        }}
        onSteer={
          onSteer &&
          ((text) => {
            currentSource.capture();
            onSteer(text);
          })
        }
        onStop={onStop}
        onValueChange={session.setDraft}
        placeholder={placeholder}
        placeholderIsPrompt={placeholderIsPrompt}
        previewSlot={
          tileValidations.length > 0 ? (
            <div aria-label="Attached context" className="contents" role="list">
              <DraftSourceTiles
                onOpenSource={onOpenSource}
                onRemove={removeTile}
                onReprocess={onReprocess}
                size={80}
                validations={tileValidations}
              />
            </div>
          ) : undefined
        }
        queue={queue}
        rightSlot={rightSlot}
        sendable={
          sendable &&
          (attachments || uploads.length === 0) &&
          !validations.some((item) => item.status === 'stale')
        }
        // A skill or a bound tile is a sendable prompt on its own.
        sendableWithoutText={armedSkill !== null || context.length > 0}
        status={status}
        value={draft}
      />
    </div>
  );
}
