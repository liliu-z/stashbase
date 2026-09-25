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
import { isDraftTile } from '@/features/agent/domain/draft-context';
import { agentSkills } from '@/features/agent/domain/session';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import type { SourceReference } from '@/shared/domain/source-reference';
import { FailureLine } from '@/shared/ui/failure-notice';
import { dragCarriesSource, readSourceDrag } from '@/shared/utils/source-drag';

import { useMentionRows } from './context-rows';
import { DraftSourceTiles, isVisualSource } from './context-tiles';
import { useComposerFocusRequest } from './focus';
import { MentionEditor, type MentionEditorHandle, type MentionEditorProps } from './mention-editor';
import { MentionListbox } from './mention-listbox';
import { SuggestedSourceChip } from './suggested-source-chip';
import { useSuggestedSource } from './use-suggested-source';

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
  onReprocess?: ((source: SourceReference) => void) | undefined;
  onRefreshSkills: () => void;
  onSkillChange: (skill: string | null) => void;
  onStop: () => void;
  onSend?: (text: string, options?: { queuedId?: string }) => void;
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
  onRefreshSkills,
  onReprocess,
  onSkillChange,
  onStop,
  onSend,
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
  const validations = useMemo(
    () =>
      validateContext(context, {
        listing: scoped?.listing ?? null,
        readiness: scoped?.readiness ?? {},
        scope,
        versions: scoped?.versions,
        hasUpload: (path) => Boolean(session.fileForTransient(path)),
      }),
    [context, scope, scoped, session],
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

  const suggestion = useSuggestedSource(scoped, context);

  // Uploads render as the shared composer's own tiles, so the File behind
  // each bound upload is handed back to it.
  const uploads = useMemo(
    () =>
      context.flatMap((item) =>
        item.kind === 'transient' ? (session.fileForTransient(item.path) ?? []) : [],
      ),
    [context, session],
  );
  const knownUpload = (file: File): AgentContextItem | undefined => {
    for (const item of [...context, ...queuedPrompts.flatMap((prompt) => prompt.context)]) {
      if (item.kind === 'transient' && session.fileForTransient(item.path) === file) return item;
    }
    return undefined;
  };
  const syncUploads = (next: File[]) => {
    for (const item of context) {
      if (item.kind !== 'transient') continue;
      const file = session.fileForTransient(item.path);
      if (file && !next.includes(file)) session.removeContext(contextItemKey(item));
    }
    const fresh: File[] = [];
    for (const file of next) {
      if (uploads.includes(file)) continue;
      const known = knownUpload(file);
      if (known) session.addContext(known);
      else fresh.push(file);
    }
    if (fresh.length > 0) void session.attachFiles(fresh);
  };

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
    if (scope.kind !== 'folder') return;
    session.removeContext(`source:${scope.path}/${path}`);
  };

  const removeTile = (item: AgentContextItem) => {
    session.removeContext(contextItemKey(item));
    if (item.kind === 'source') session.setDraft(removeMentionText(draft, item.source.path));
  };

  const attachSource = (source: SourceReference) => {
    const listed = scoped?.listing.files.find((file) => file.path === source.path);
    const visual =
      listed !== undefined &&
      isVisualSource({ boundVersion: null, format: listed.format, kind: 'source', source });
    if (visual) {
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
      // The Chat composer is a card-sized surface, so it takes that role
      // rather than the fixed radius it used to spell out — the frame the
      // reader sees around the editor is this wrapper, not the InputMessage
      // inside it, and the two were drawing different corners.
      className={cn('relative flex flex-col bg-surface-3 shadow-surface-3', shape.card)}
      onDragOverCapture={onDragOverCapture}
      onDropCapture={onDropCapture}
      onPasteCapture={onPasteCapture}
    >
      {panel.open && (
        <MentionListbox
          activeIndex={panel.activeRow}
          id={listboxId}
          label={panel.label}
          notice={panel.notice}
          onHover={panel.onHover}
          onPick={panel.onPick}
          rows={panel.rows}
        />
      )}
      {!attachments && uploads.length > 0 && (
        <FailureLine className="m-0 px-3 pt-2" tone="input">
          This Agent cannot use these uploads. Remove them or choose another Agent.
        </FailureLine>
      )}
      {issue && (
        <FailureLine className="m-0 px-3 pt-2" tone="input">
          {issue}
        </FailureLine>
      )}
      <InputMessage
        accept={ATTACH_ACCEPT}
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
        onQueueChange={onQueueChange}
        onSend={(text, _files, meta) =>
          void (onSend ?? session.sendPrompt)(
            text,
            meta?.queuedId ? { queuedId: meta.queuedId } : undefined,
          )
        }
        onStop={onStop}
        onValueChange={session.setDraft}
        placeholder={placeholder}
        placeholderIsPrompt={placeholderIsPrompt}
        previewSlot={
          tileValidations.length > 0 || suggestion.source ? (
            <>
              {tileValidations.length > 0 && (
                <div aria-label="Attached context" className="contents" role="list">
                  <DraftSourceTiles
                    onRemove={removeTile}
                    onReprocess={onReprocess}
                    size={80}
                    validations={tileValidations}
                  />
                </div>
              )}
              {suggestion.source && (
                <SuggestedSourceChip
                  onAttach={() => suggestion.source && attachSource(suggestion.source)}
                  onDismiss={suggestion.dismiss}
                  source={suggestion.source}
                />
              )}
            </>
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
