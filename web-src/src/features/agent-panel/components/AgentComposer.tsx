/**
 * The chat input surface: draft text, attachment chips, the send/stop
 * action, and the bar of session pills under it.
 *
 * The two self-contained widgets it hosts live beside it — the `@`/`/`
 * suggestion popup in `MentionSuggestions.tsx` and the session pills
 * (model/effort settings and permission mode) in `ComposerPills.tsx` — so
 * what remains here is the composer's own
 * state (draft, selected skill, attachment preview) and the one rule that
 * decides whether that state can be sent.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/common/components/ui/button';
import { ArrowUpIcon, PlusIcon, StopIcon } from '@/common/components/icons';
import { cn } from '@/common/lib/utils';
import { AttachmentChip, AttachmentLightbox } from '@/features/agent-panel/components/AttachmentChip';
import {
  scopePillAriaLabel,
  type LibraryScope,
  type LibraryFolderOption,
} from '@/common/lib/libraryScope';
import { ScopeMenu } from '@/common/components/ScopeMenu';
import { MentionComposer, type MentionComposerHandle } from '@/features/agent-panel/components/MentionComposer';
import { SimilaritySearchControl } from '@/features/agent-panel/components/SimilaritySearchControl';
import {
  ModelEffortMenu, ModeMenu, nextPermMode,
  type ComposerEffortControl, type ComposerModeControl, type ComposerModelControl,
} from '@/features/agent-panel/components/ComposerPills';
import {
  MentionSuggestions, useMentionSuggestions,
  type ComposerMentionSources, type ComposerSkillSource,
} from '@/features/agent-panel/components/MentionSuggestions';
import type { AgentSkill, Attachment } from '@/features/agent-panel/lib/types';

/* The composer's prop contract stays readable from one place even though
 * the pill and mention halves are owned by the modules that render them. */
export type {
  ComposerEffortControl, ComposerModeControl, ComposerModelControl,
} from '@/features/agent-panel/components/ComposerPills';
export type {
  ComposerMentionSources, ComposerSkillSource,
} from '@/features/agent-panel/components/MentionSuggestions';

/**
 * The terminal action on the composer bar. One control with two states, so
 * it is one component: the three class strings it replaced described a
 * single button whose shape was stated once and whose two skins were
 * stated apart from it, which is exactly the split that lets one drift.
 *
 * Neutral by default — accent only on hover-when-ready (VSCode-style). The
 * Button primitive (variant `ghost`, size `icon-sm`) already owns the 28px
 * box, the focus halo, and the icon sizing; what stays here is the one
 * thing no variant expresses: a circle that tints ACCENT on hover rather
 * than muted. Circular, not squircular: a true circle is the one shape
 * that reads as a button rather than as a smaller copy of the composer
 * around it. `rounded-full` also opts out of the app-wide squircle (see
 * globals.css), which is what keeps it a circle instead of a bulged
 * superellipse. Stop holds its red under the pointer — the ghost variant's
 * muted hover would read as the button going inert mid-turn.
 */
function SendButton({ turnActive, disabled, onStop, onSend }: {
  turnActive: boolean;
  disabled: boolean;
  onStop: () => void;
  onSend: () => void;
}) {
  if (turnActive) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-full border-destructive bg-destructive text-primary-foreground hover:bg-destructive hover:text-primary-foreground"
        aria-label="Stop agent"
        onClick={onStop}
      >
        <StopIcon />
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="rounded-full border-border bg-muted text-foreground enabled:hover:border-accent enabled:hover:bg-accent enabled:hover:text-primary-foreground disabled:opacity-40"
      aria-label="Send message"
      disabled={disabled}
      onClick={onSend}
    >
      <ArrowUpIcon />
    </Button>
  );
}

/** The scope this tab's session is (or will be) bound to. */
export interface ComposerScopeControl {
  current: LibraryScope;
  entries: LibraryFolderOption[];
  homeDir: string;
  locked: boolean;
  onSet: (scope: LibraryScope) => void;
}

/** StashBase's retrieval policy for the mounted session. It rides the
 * composer bar's context half with scope rather than the Agent's run
 * settings, and stays owned by AgentView because the live session — not
 * the composer — holds the policy. */
export interface ComposerSimilaritySearch {
  enabled: boolean;
  availabilityKnown: boolean;
  onChange: (enabled: boolean) => void;
}

/** Context attachments — owned by AgentView so panel drops, the `+`
 * picker, and the send path share one list. */
export interface ComposerAttachments {
  enabled: boolean;
  items: Attachment[];
  uploading: boolean;
  onPick: (files: File[]) => void;
  onPasteImages: (files: File[]) => void;
  onRemove: (path: string) => void;
}

export function AgentComposer({
  phase, disabled, turnActive, active, agentShortName, hero,
  mode, effort, model, scope, similaritySearch, mentions, skills, attachments,
  closedPlaceholder, onDraftChange, onFocusChange, onSend, onStop,
}: {
  phase: 'connecting' | 'live' | 'closed';
  disabled: boolean;
  turnActive: boolean;
  active: boolean;
  agentShortName: string;
  /** Empty-chat PRESENTATION only — the resting height and the one
   * sanctioned shadow. Width is deliberately NOT part of it: both layouts
   * mount the same instance at the same measure. */
  hero?: boolean;
  /** A terminal state can be expected and non-reconnectable (folder scope
   * retirement). Keep its composer draft visible, but do not tell the user
   * to reconnect to a scope that no longer exists. */
  closedPlaceholder?: string;
  mode: ComposerModeControl;
  effort: ComposerEffortControl;
  model: ComposerModelControl;
  scope: ComposerScopeControl;
  similaritySearch: ComposerSimilaritySearch;
  mentions: ComposerMentionSources;
  skills: ComposerSkillSource;
  attachments: ComposerAttachments;
  /** Reports whether the composer holds unsent draft text, so the tab
   * model can freeze a drafted tab's scope and exclude it from blank-tab
   * reuse. */
  onDraftChange?: (hasText: boolean) => void;
  onFocusChange: (focused: boolean) => void;
  onSend: (text: string, skill?: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const composerRef = useRef<MentionComposerHandle>(null);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<AgentSkill>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const suggestions = useMentionSuggestions({
    composerRef,
    mentions,
    skills: skills.list,
    onSkillPicked: (skill) => setSelectedSkill(skill),
  });

  useEffect(() => { if (active) composerRef.current?.focus(); }, [active]);

  function cycleMode() {
    mode.onSet(nextPermMode(mode.value));
  }

  // "Explore with", not "Message": the agent here is pointed at the
  // user's own library, and the generic chat-app phrasing said nothing
  // about that. Kept as one line so the wording is easy to revisit.
  const placeholder = phase === 'connecting'
    ? 'Connecting…'
    : phase === 'closed'
      ? closedPlaceholder ?? 'Reconnect to continue…'
      : turnActive
        ? 'Ask for follow-up changes'
        : `Explore with ${agentShortName}…`;

  /** Whether the given draft is sendable. The send button and `submit`
   *  below are the two places that ask, and they must never drift: the
   *  button reads the draft state, `submit` reads the text CodeMirror
   *  hands it, and a skill or an attachment makes an empty draft valid. */
  function canSend(draft: string): boolean {
    if (disabled || attachments.uploading) return false;
    return Boolean(draft.trim()) || attachments.items.length > 0 || Boolean(selectedSkill);
  }

  function submit(t: string) {
    if (!canSend(t)) return false;
    onSend(t.trim(), selectedSkill?.id);
    setSelectedSkill(undefined);
    suggestions.dismiss();
    return true;
  }

  return (
    // ONE geometry in both states, so sending the first message cannot
    // resize the thing you just typed into. The empty chat sets the
    // composer's width; the transcript then matches that card rather than
    // the other way round (see `.agent-messages`). This is also what
    // renderer-styling's width rule already asks for — transcript and
    // composer share the `-md` measure — which the old chat-primary hook
    // (a 944px wrapper around a 920px card) had drifted away from.
    <div
      className="relative mx-auto w-measure-md p-2"
      data-draft-empty={text.trim() ? 'false' : 'true'}
    >
      <MentionSuggestions state={suggestions} skills={skills} />
      <div className={cn(
        // No focus treatment on the CARD: the caret already says where
        // typing goes, and an accent ring around a box this large was the
        // loudest thing on screen for the app's most common state — the
        // composer is focused nearly all the time.
        // The hero corner — one step past every overlay in the app. The
        // composer is the surface the eye rests on, and the extra radius
        // is what makes it read as the anchor rather than another panel.
        'flex flex-col gap-1.5 rounded-2xl border border-border bg-background px-2 pt-2 pb-1.5',
        // Hero (empty-state) presentation: the composer is the visual
        // anchor of an otherwise bare pane, so it earns a taller resting
        // input and the one sanctioned non-overlay shadow. Docked mode
        // stays flat and compact beside a document.
        // 56px ≈ two and a half lines: a shade taller than the docked
        // composer's two, which is all the extra presence the empty
        // pane's anchor needs. Four lines read as a form to fill in.
        hero && 'shadow-raised [--composer-min-h:56px]',
      )}>
        {(attachments.items.length > 0 || attachments.uploading) && (
          <div className="flex flex-wrap items-center gap-1">
            {attachments.items.map((a) => (
              <AttachmentChip
                key={a.path}
                attachment={a}
                onPreview={() => setPreviewAttachment(a)}
                onRemove={() => {
                  if (previewAttachment?.path === a.path) setPreviewAttachment(null);
                  attachments.onRemove(a.path);
                }}
              />
            ))}
            {attachments.uploading && <span className="text-xs text-muted-foreground">Uploading…</span>}
          </div>
        )}
        <MentionComposer
          ref={composerRef}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(next) => {
            setText(next);
            // Lift draft presence to the tab model: unsent text freezes the
            // tab's scope and disqualifies it from blank-tab reuse.
            onDraftChange?.(Boolean(next.trim()));
          }}
          onMentionChange={suggestions.onQueryChange}
          onMentionNavigate={suggestions.move}
          onMentionAccept={suggestions.accept}
          onMentionDismiss={suggestions.dismiss}
          onSkillMarkerRemoved={() => setSelectedSkill(undefined)}
          onShiftTab={() => {
            if (!mode.show || disabled) return false;
            cycleMode();
            return true;
          }}
          onSubmit={submit}
          onPasteImages={attachments.enabled ? attachments.onPasteImages : undefined}
          onFocusChange={onFocusChange}
          mentionOpen={suggestions.open}
          mentionListboxId={suggestions.composerListboxId}
          mentionActiveOptionId={suggestions.composerActiveOptionId}
        />
        {/* NOT the `Input` primitive: this is a hidden file picker with no
          * rendered surface at all — the `+` button below opens it. A text
          * field's box treatment would be dead weight, and `Input` is typed
          * for Base UI's text input, not `type="file"`. */}
        {attachments.enabled && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              attachments.onPick(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        )}
        {/* Action bar under the input. The negative side margins bleed the
          * top rule past the box padding so it spans edge to edge. */}
        {/* No divider above the controls: the composer reads as ONE input
          * surface (Cursor/ChatGPT register) — spacing and the controls'
          * muted styling carry the separation, and a mid-card hairline
          * would double up with the card's own border. */}
        <div className="flex items-center gap-1 pt-0.5">
          {attachments.enabled && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={attachments.uploading ? 'Uploading files' : 'Upload local files'}
              disabled={attachments.uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              <PlusIcon />
            </Button>
          )}
          {/* The bar splits by ownership, not by control type: what
            * StashBase supplies as library context — the attach control and
            * the scope — reads left; the Agent's own run settings (model,
            * mode) group right next to send. Retrieval mode is library
            * context too, but it rides INSIDE the scope popup rather than
            * beside it: scope is what a lookup may reach and matching is
            * how it compares. Durable Agent Instructions live in the panel
            * toolbar rather than this conversation-control popup. Only the
            * scope itself is worth the docked bar's width. */}
          <ScopeMenu
            scope={scope.current}
            entries={scope.entries}
            homeDir={scope.homeDir}
            heading="Session scope"
            libraryDetail="Chat across your whole library"
            ariaLabel={scopePillAriaLabel(scope.current, scope.locked)}
            locked={scope.locked}
            disabled={disabled}
            footer={(
              <SimilaritySearchControl
                enabled={similaritySearch.enabled}
                availabilityKnown={similaritySearch.availabilityKnown}
                onChange={similaritySearch.onChange}
              />
            )}
            onSetScope={scope.onSet}
          />
          <span className="flex-1" />
          {(model.show || effort.show) && <ModelEffortMenu model={model} effort={effort} disabled={disabled} />}
          {mode.show && <ModeMenu mode={mode} disabled={disabled} />}
          <SendButton
            turnActive={turnActive}
            disabled={!canSend(text)}
            onStop={onStop}
            onSend={() => composerRef.current?.submit()}
          />
        </div>
        {model.notice && <div className="pt-1.5 text-xs leading-snug text-muted-foreground" role="status">{model.notice}</div>}
      </div>
      <AttachmentLightbox attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
    </div>
  );
}
