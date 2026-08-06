import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, ListBox, ListBoxItem, Menu, MenuItem, MenuTrigger, Popover, VisuallyHidden } from 'react-aria-components';
import {
  ArrowUpIcon, BoltIcon, CheckIcon, ChevronDownIcon, ClipboardListIcon, CodeIcon, DumbbellIcon,
  FileGenericIcon, FolderIcon, HandIcon, PlusIcon, StopIcon,
} from '../../icons';
import { useApp } from '../../store/AppContext';
import { ImageLightbox } from '../ImageLightbox';
import {
  Menu as SharedMenu,
  MenuItem as SharedMenuItem,
  MenuPopup as SharedMenuPopup,
  MenuPortal as SharedMenuPortal,
  MenuPositioner as SharedMenuPositioner,
  MenuTrigger as SharedMenuTrigger,
} from '../ui/menu';
import { baseName } from './attachments';
import { changedEffortSelection, effortLabel, effortMenuState, effortOptions } from './effortMenuState';
import { MentionComposer, type MentionComposerHandle, type MentionQuery } from './MentionComposer';
import { rankMentionSuggestions } from './mentionRanking';
import type { AgentModel, AgentSkill, Attachment, EffortLevel, PermMode } from './types';
import { skillMenuState } from './skillMenuState';
import { modelMenuLabel } from './modelState';

const MODES: { id: PermMode; label: string; desc: string; Icon: typeof HandIcon }[] = [
  { id: 'default', label: 'Ask', desc: 'Ask before edits or higher-risk actions', Icon: HandIcon },
  { id: 'acceptEdits', label: 'Edit', desc: 'Apply file edits without asking each time', Icon: CodeIcon },
  { id: 'plan', label: 'Plan', desc: 'Explore and propose a plan before changing files', Icon: ClipboardListIcon },
  { id: 'auto', label: 'Auto', desc: 'Let the agent decide when approval is needed', Icon: BoltIcon },
];

function AccessMenu({
  mode, open, disabled, onOpenChange, onPick,
}: {
  mode: PermMode;
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (m: PermMode) => void;
}) {
  const active = MODES.find((m) => m.id === mode) ?? MODES[0];
  const ActiveIcon = active.Icon;
  return (
    <MenuTrigger isOpen={open} onOpenChange={onOpenChange}>
      <Button className="agent-mode-btn" isDisabled={disabled}>
        <ActiveIcon className="agent-mode-icon" />
        {active.label}
        <ChevronDownIcon className="agent-mode-chevron" />
      </Button>
      <Popover className="agent-mode-menu" placement="top end">
        <div className="agent-mode-menu-head">
          <span>Access</span>
        </div>
        <Menu aria-label="Access level" selectionMode="single" selectedKeys={[mode]} onAction={(key) => onPick(key as PermMode)}>
          {MODES.map((m) => {
            const Icon = m.Icon;
            return (
              <MenuItem
                key={m.id}
                id={m.id}
                className={({ isSelected }) => 'agent-mode-opt' + (isSelected ? ' active' : '')}
                textValue={m.label}
              >
                <Icon className="agent-mode-opt-icon" />
                <span className="agent-mode-opt-text">
                  <span className="agent-mode-opt-title">{m.label}</span>
                  <span className="agent-mode-opt-desc">{m.desc}</span>
                </span>
                {m.id === mode && <CheckIcon className="agent-mode-opt-check" />}
              </MenuItem>
            );
          })}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

function EffortBar({ effort, efforts, onSet }: { effort?: EffortLevel; efforts: EffortLevel[]; onSet: (l?: EffortLevel) => void }) {
  return (
    <div className="agent-effort">
      <DumbbellIcon className="agent-effort-icon" />
      <span className="agent-effort-label">
        Effort <span className="agent-effort-level">({effort ? effortLabel(effort) : 'Default'})</span>
      </span>
      <ListBox
        className="agent-effort-track"
        aria-label="Effort"
        selectionMode="single"
        selectedKeys={[effort ?? '__default__']}
        onSelectionChange={(keys) => {
          const next = changedEffortSelection(keys, effort, efforts);
          if (next !== null) onSet(next);
        }}
      >
        <ListBoxItem id="__default__" className={({ isSelected }) => 'agent-effort-choice' + (isSelected ? ' cur' : '')} textValue="Default">
          Default
        </ListBoxItem>
        {efforts.map((lv) => (
          <ListBoxItem
            key={lv}
            id={lv}
            className={({ isSelected }) =>
              'agent-effort-choice'
              + (isSelected ? ' cur' : '')
              + (lv === 'max' ? ' max' : '')
            }
            aria-label={effortLabel(lv)}
            textValue={effortLabel(lv)}
          >
            {effortLabel(lv)}
          </ListBoxItem>
        ))}
      </ListBox>
    </div>
  );
}

function EffortMenu({
  effort, efforts, open, disabled, locked, onOpenChange, onSetEffort,
}: {
  effort?: EffortLevel;
  efforts: EffortLevel[];
  open: boolean;
  disabled: boolean;
  locked: boolean;
  onOpenChange: (open: boolean) => void;
  onSetEffort: (level?: EffortLevel) => void;
}) {
  const state = effortMenuState({ open, disabled, locked });
  return (
    <MenuTrigger isOpen={state.isOpen} onOpenChange={onOpenChange}>
      <Button
        className={'agent-mode-btn agent-effort-btn' + (locked ? ' is-locked' : '')}
        isDisabled={state.triggerDisabled}
      >
        <DumbbellIcon className="agent-mode-icon" />
        {effort ? effortLabel(effort) : 'Default'}
        <ChevronDownIcon className="agent-mode-chevron" />
      </Button>
      <Popover className="agent-mode-menu effort-only" placement="top end">
        <div>
          <EffortBar effort={effort} efforts={efforts} onSet={onSetEffort} />
        </div>
      </Popover>
    </MenuTrigger>
  );
}

function ModelMenu({ selectedModel, activeModel, models, locked, disabled, resumedSession, onSetModel }: {
  selectedModel?: string;
  activeModel?: string;
  models: AgentModel[];
  locked: boolean;
  disabled: boolean;
  resumedSession: boolean;
  onSetModel: (model?: string) => void;
}) {
  const defaultSelected = !selectedModel;
  return (
    <SharedMenu>
      <SharedMenuTrigger className={'agent-mode-btn agent-model-btn' + (locked ? ' is-locked' : '')} disabled={disabled || locked}>
        {modelMenuLabel(models, selectedModel, activeModel, resumedSession)}
        <ChevronDownIcon className="agent-mode-chevron" />
      </SharedMenuTrigger>
      <SharedMenuPortal>
        <SharedMenuPositioner side="top" align="end" sideOffset={6} collisionPadding={8}>
          <SharedMenuPopup className="agent-mode-menu agent-model-menu" aria-label="Model">
            <div className="agent-mode-menu-head"><span>Model</span></div>
            <SharedMenuItem label="Default" className={'agent-mode-opt' + (defaultSelected ? ' active' : '')} onClick={() => onSetModel(undefined)}>
            <span className="agent-mode-opt-text"><span className="agent-mode-opt-title">Default</span><span className="agent-mode-opt-desc">Use this runtime’s configured model</span></span>
            {defaultSelected && <CheckIcon className="agent-mode-opt-check" />}
            </SharedMenuItem>
            {models.map((entry) => (
              <SharedMenuItem key={entry.id} label={entry.label} className={'agent-mode-opt' + (selectedModel === entry.id ? ' active' : '')} onClick={() => onSetModel(entry.id)}>
              <span className="agent-mode-opt-text"><span className="agent-mode-opt-title">{entry.label}</span>{entry.description && <span className="agent-mode-opt-desc">{entry.description}</span>}</span>
              {selectedModel === entry.id && <CheckIcon className="agent-mode-opt-check" />}
              </SharedMenuItem>
            ))}
          </SharedMenuPopup>
        </SharedMenuPositioner>
      </SharedMenuPortal>
    </SharedMenu>
  );
}

function SkillsMenu({ skills, selected, loading, error, disabled, onPick, onClear, onRefresh }: { skills: AgentSkill[]; selected: AgentSkill | null; loading: boolean; error: string | null; disabled: boolean; onPick: (skill: AgentSkill) => void; onClear: () => void; onRefresh: () => void }) {
  const [open, setOpen] = useState(false); const state = skillMenuState({ loading, skills, error });
  return <MenuTrigger isOpen={open} onOpenChange={setOpen}><Button className="agent-mode-btn" isDisabled={disabled}><ClipboardListIcon className="agent-mode-icon" />{selected?.name ?? 'Skills'}<ChevronDownIcon className="agent-mode-chevron" /></Button><Popover className="agent-mode-menu" placement="top end"><div className="agent-mode-menu-head"><span>Skills</span></div>{state.kind !== 'ready' ? <div className="agent-skills-state" role="status"><span>{state.message}</span>{state.kind !== 'loading' && <Button onPress={onRefresh}>Refresh</Button>}</div> : <Menu aria-label="Available skills" onAction={(key) => { const skill = skills.find((item) => item.id === String(key)); if (skill) { onPick(skill); setOpen(false); } }}>{skills.map((skill) => <MenuItem key={skill.id} id={skill.id} className="agent-mode-opt" textValue={skill.name}><span className="agent-mode-opt-text"><span className="agent-mode-opt-title">{skill.name}</span><span className="agent-mode-opt-desc">{skill.description}</span></span>{selected?.id === skill.id && <CheckIcon className="agent-mode-opt-check" />}</MenuItem>)}</Menu>}{selected && <Button onPress={() => { onClear(); setOpen(false); }}>Clear selected skill</Button>}</Popover></MenuTrigger>;
}

export function AgentComposer({
  phase, disabled, turnActive, active, mode, onSetMode, effort, onSetEffort,
  effortLocked, supportedEfforts, selectedModel, activeModel, models, modelLocked, modelNotice, resumedSession, onSetModel, skills, selectedSkill, skillsLoading, skillsError, onPickSkill, onClearSkill, onRefreshSkills, attachments, uploading, agentShortName, showModeMenu, showEffortMenu, showModelMenu, onPickFiles, onPasteImages, onFocusChange, onRemoveAttachment, onSend, onStop,
}: {
  phase: 'connecting' | 'live' | 'closed';
  disabled: boolean;
  turnActive: boolean;
  active: boolean;
  mode: PermMode;
  onSetMode: (mode: PermMode) => void;
  effort?: EffortLevel;
  onSetEffort: (level?: EffortLevel) => void;
  effortLocked: boolean;
  supportedEfforts?: string[];
  selectedModel?: string;
  activeModel?: string;
  models: AgentModel[];
  modelLocked: boolean;
  modelNotice: string | null;
  resumedSession: boolean;
  onSetModel: (model?: string) => void;
  skills: AgentSkill[]; selectedSkill: AgentSkill | null; skillsLoading: boolean; skillsError: string | null; onPickSkill: (skill: AgentSkill) => void; onClearSkill: () => void; onRefreshSkills: () => void;
  attachments: Attachment[];
  uploading: boolean;
  agentShortName: string;
  showModeMenu: boolean;
  showEffortMenu: boolean;
  showModelMenu: boolean;
  onPickFiles: (files: File[]) => void;
  onPasteImages: (files: File[]) => void;
  onFocusChange: (focused: boolean) => void;
  onRemoveAttachment: (path: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const composerRef = useRef<MentionComposerHandle>(null);
  const mentionListboxId = useId();
  const { state } = useApp();
  const [mention, setMention] = useState<MentionQuery>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [modeOpen, setModeOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeMentionRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (active) composerRef.current?.focus(); }, [active]);

  useEffect(() => {
    if (effortLocked) setEffortOpen(false);
  }, [effortLocked]);

  function cycleMode() {
    const i = MODES.findIndex((m) => m.id === mode);
    onSetMode(MODES[(i + 1) % MODES.length].id);
  }

  const suggestions = useMemo(() => {
    if (!mention) return [];
    return rankMentionSuggestions(state.files, state.folders, mention.q);
  }, [mention, state.files, state.folders]);

  const activeSuggestionIndex = Math.min(activeMentionIndex, Math.max(suggestions.length - 1, 0));
  const compatibleEfforts = effortOptions(supportedEfforts);

  useEffect(() => {
    activeMentionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeSuggestionIndex]);

  const placeholder = phase === 'connecting'
    ? 'Connecting…'
    : phase === 'closed'
      ? 'Reconnect to continue…'
      : turnActive
        ? 'Ask for follow-up changes'
        : `Message ${agentShortName}…`;

  function pickMention(path: string) {
    if (!mention) return;
    composerRef.current?.insertMention(path, mention);
    setMention(null);
  }

  function submit(t: string) {
    const trimmed = t.trim();
    if ((!trimmed && attachments.length === 0) || disabled || uploading) return false;
    onSend(trimmed);
    setMention(null);
    return true;
  }

  function moveMention(direction: 1 | -1) {
    if (!suggestions.length) return;
    setActiveMentionIndex((index) => (index + direction + suggestions.length) % suggestions.length);
  }

  return (
    <div className="agent-composer">
      {mention && suggestions.length > 0 && (
        <div className="agent-mention">
          <div className="agent-mention-head">
            <span>Files and folders</span>
            <span>↑↓ navigate · Enter select · Esc dismiss</span>
          </div>
          <VisuallyHidden>
            <div role="status">
              {`${baseName(suggestions[activeSuggestionIndex].path)}, ${activeSuggestionIndex + 1} of ${suggestions.length}`}
            </div>
          </VisuallyHidden>
          <ListBox
            id={mentionListboxId}
            className="agent-mention-list"
            aria-label="Matching library files and folders"
            selectionMode="single"
            selectedKeys={[suggestions[activeSuggestionIndex].path]}
            onAction={(key) => pickMention(String(key))}
          >
            {suggestions.map((suggestion, index) => (
              <ListBoxItem
                key={suggestion.path}
                ref={index === activeSuggestionIndex ? activeMentionRef : null}
                id={suggestion.path}
                className={({ isSelected }) => 'agent-mention-item' + (isSelected ? ' active' : '')}
                textValue={suggestion.path}
              >
                {suggestion.kind === 'folder'
                  ? <FolderIcon className="agent-mention-icon" />
                  : <FileGenericIcon className="agent-mention-icon" />}
                <span className="agent-mention-text">
                  <span className="agent-mention-name">{baseName(suggestion.path)}</span>
                  <span className="agent-mention-path">{suggestion.path}</span>
                </span>
              </ListBoxItem>
            ))}
          </ListBox>
        </div>
      )}
      <div className="agent-composer-box">
        {(attachments.length > 0 || uploading) && (
          <div className="agent-attachments">
            {attachments.map((a) => a.previewUrl ? (
              <span key={a.path} className="agent-attach-image-chip">
                <button
                  type="button"
                  className="agent-attach-image-preview"
                  aria-label={`Preview ${a.name}`}
                  onClick={() => setPreviewAttachment(a)}
                >
                  <img src={a.previewUrl} alt="" />
                </button>
                <Button
                  className="agent-attach-x"
                  aria-label={`Remove ${a.name}`}
                  onPress={() => {
                    if (previewAttachment?.path === a.path) setPreviewAttachment(null);
                    onRemoveAttachment(a.path);
                  }}
                >
                  <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                    <path d="m2.25 2.25 7.5 7.5M9.75 2.25l-7.5 7.5" />
                  </svg>
                </Button>
              </span>
            ) : (
              <span key={a.path} className="agent-attach-chip" title={a.path}>
                <FileGenericIcon className="agent-attach-icon" />
                <span className="agent-attach-name">{a.name}</span>
                <Button className="agent-attach-x" aria-label={`Remove ${a.name}`} onPress={() => onRemoveAttachment(a.path)}>×</Button>
              </span>
            ))}
            {uploading && <span className="agent-attach-loading">Uploading…</span>}
          </div>
        )}
        <MentionComposer
          ref={composerRef}
          placeholder={placeholder}
          disabled={disabled}
          onChange={setText}
          onMentionChange={(next) => {
            setMention(next);
            setActiveMentionIndex(0);
          }}
          onMentionNavigate={moveMention}
          onMentionAccept={() => {
            if (!suggestions.length) return false;
            pickMention(suggestions[activeSuggestionIndex].path);
            return true;
          }}
          onMentionDismiss={() => setMention(null)}
          onShiftTab={() => {
            if (!showModeMenu || disabled) return false;
            cycleMode();
            return true;
          }}
          onSubmit={submit}
          onPasteImages={onPasteImages}
          onFocusChange={onFocusChange}
          mentionOpen={Boolean(mention && suggestions.length)}
          mentionListboxId={mention && suggestions.length ? mentionListboxId : undefined}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            onPickFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <div className="agent-composer-bar">
          <Button
            className="agent-bar-btn"
            aria-label={uploading ? 'Uploading files' : 'Upload local files'}
            isDisabled={uploading}
            onPress={() => fileInputRef.current?.click()}
          >
            <PlusIcon />
          </Button>
          <span className="agent-bar-spacer" />
          {showModelMenu && <ModelMenu selectedModel={selectedModel} activeModel={activeModel} models={models} locked={modelLocked} disabled={disabled} resumedSession={resumedSession} onSetModel={onSetModel} />}
          {showModeMenu && (
            <AccessMenu
              mode={mode}
              open={modeOpen}
              disabled={disabled}
              onOpenChange={(open) => { setModeOpen(open); if (open) setEffortOpen(false); }}
              onPick={(m) => { onSetMode(m); setModeOpen(false); }}
            />
          )}
          {showEffortMenu && (
            <EffortMenu
              effort={effort}
              open={effortOpen}
              disabled={disabled}
              locked={effortLocked}
              efforts={compatibleEfforts}
              onOpenChange={(open) => { setEffortOpen(open); if (open) setModeOpen(false); }}
              onSetEffort={onSetEffort}
            />
          )}
          <SkillsMenu skills={skills} selected={selectedSkill} loading={skillsLoading} error={skillsError} disabled={disabled} onPick={onPickSkill} onClear={onClearSkill} onRefresh={onRefreshSkills} />
          {turnActive ? (
            <Button className="agent-send stop" aria-label="Stop agent" onPress={onStop}>
              <StopIcon />
            </Button>
          ) : (
            <Button
              className="agent-send"
              aria-label="Send message"
              isDisabled={disabled || uploading || (!text.trim() && attachments.length === 0)}
              onPress={() => composerRef.current?.submit()}
            >
              <ArrowUpIcon />
            </Button>
          )}
        </div>
        {modelNotice && <div className="agent-model-notice" role="status">{modelNotice}</div>}
      </div>
      {previewAttachment?.previewUrl && (
        <ImageLightbox
          src={previewAttachment.previewUrl}
          alt={previewAttachment.name}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </div>
  );
}
