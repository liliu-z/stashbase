/**
 * The composer bar's session pills — the model/effort settings pill and
 * the permission-mode pill — plus the menus behind them.
 *
 * Each is a pure function of the control object AgentComposer hands it: no
 * draft text, no attachments, no mention state, nothing else in the
 * composer. They live here so `AgentComposer.tsx` is the input surface and
 * its send path, not also a stack of menus.
 *
 * Two pills, split by how often each setting changes and who needs to see
 * it. Mode is the agent's permission state: it must read without opening
 * anything, it flips mid-conversation, and its labels are four characters
 * at their longest — it stays its own pill. Model and effort are set-once
 * session settings, and the docked-beside-a-document panel is the
 * composer's common width: as three sibling pills they all truncated to
 * ellipses there, with "Effort: Default" spending the row's tightest
 * pixels saying nothing. They share one pill over a two-level menu — the
 * parent is a value row per setting, each opening a single-list flyout —
 * so the current values read back one click deep and a default effort
 * claims no bar space at all.
 */
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  AGENTS, AGENT_META, wikiAgentLauncherDetail, type AgentKind,
} from '@/common/lib/agentCatalog';
import {
  accountSignedInSnapshot, subscribeAccountSignedIn,
} from '@/common/lib/accountEvents';
import {
  Menu, MenuPopup, MenuPortal, MenuPositioner, MenuTrigger,
} from '@/common/components/ui/menu';
import {
  MenuGroupLabel, MenuRadioGroup, MenuRadioItem,
} from '@/common/components/ui/menu-radio';
import { MenuSubmenu, MenuSubmenuTrigger } from '@/common/components/ui/menu-submenu';
import {
  BoltIcon, ClipboardListIcon, CodeIcon, HandIcon,
} from '@/common/components/icons';
import { MenuOptionContent } from '@/common/components/ui/menu-option';
import { Pill } from '@/common/components/ui/pill';
import { cn } from '@/common/lib/utils';
import { effortLabel, effortOptions } from '@/features/agent-panel/lib/effortMenuState';
import type { AgentModel, EffortLevel, PermMode } from '@/features/agent-panel/lib/types';
import { modelMenuLabel, type ModelMenuLockReason } from '@/features/agent-panel/lib/modelState';

const MODES: { id: PermMode; label: string; desc: string; Icon: typeof HandIcon }[] = [
  { id: 'default', label: 'Ask', desc: 'Ask before edits or higher-risk actions', Icon: HandIcon },
  { id: 'acceptEdits', label: 'Edit', desc: 'Apply file edits without asking each time', Icon: CodeIcon },
  { id: 'plan', label: 'Plan', desc: 'Explore and propose a plan before changing files', Icon: ClipboardListIcon },
  { id: 'auto', label: 'Auto', desc: 'Let the agent decide when approval is needed', Icon: BoltIcon },
];

/** The next mode in the bar's cycle order, for the composer's Shift-Tab
 *  shortcut. An unrecognized current mode restarts the cycle. */
export function nextPermMode(current: PermMode): PermMode {
  const index = MODES.findIndex((m) => m.id === current);
  return MODES[(index + 1) % MODES.length].id;
}

/* Upward menus anchored to the pills. The surface itself (card, border,
 * radius, shadow, entry motion) comes from MenuPopup; only the sizing is
 * local, so a tall list (a long model catalog) scrolls INSIDE the card
 * instead of spilling rows past its clipped background. */
const menuPopupClass =
  'max-h-overlay-lg w-80 max-w-overlay-fit overflow-y-auto overscroll-contain p-1.5 scrollbar-quiet';

/* The radio value standing in for "no override". A radio group needs a
 * value for every row, and `undefined` is the absence of one. */
const DEFAULT_VALUE = '__default__';

/** Permission-mode control for the composer bar's Mode pill. */
export interface ComposerModeControl {
  show: boolean;
  value: PermMode;
  onSet: (mode: PermMode) => void;
}

/** Thinking-effort control behind its half of the settings pill. */
export interface ComposerEffortControl {
  show: boolean;
  /** Explicit override; undefined preserves the runtime default. */
  level?: EffortLevel;
  /** The resumed session carries a non-default effort the user never
   * picked here (reads on the Default row). */
  inherited: boolean;
  locked: boolean;
  /** Effort ids the effective model supports; undefined means all. */
  supported?: string[];
  onSet: (level?: EffortLevel) => void;
}

/** Model control behind its half of the settings pill. */
export interface ComposerModelControl {
  show: boolean;
  /** Explicit user intent; null means native Default. */
  selected?: string | null;
  /** Model the runtime says the live session is actually using. */
  active?: string;
  models: AgentModel[];
  locked: boolean;
  lockReason: ModelMenuLockReason;
  notice: string | null;
  resumedSession: boolean;
  onSet: (model?: string) => void;
}

/* A radio group, not a stack of buttons: each row becomes a
 * `menuitemradio` carrying its own checked state, and the check glyph
 * comes from the primitive rather than being drawn per row.
 *
 * The heading lives INSIDE the group: `MenuGroupLabel` reads the group's
 * context to register itself as the group's accessible name, and throws
 * outright when rendered without one — a sibling heading above the group
 * took the whole chat pane to its error boundary the moment a pill
 * opened. */
function ModelRadioGroup({ model, onPicked }: { model: ComposerModelControl; onPicked: () => void }) {
  return (
    <MenuRadioGroup
      value={model.selected ?? DEFAULT_VALUE}
      onValueChange={(value) => {
        model.onSet(value === DEFAULT_VALUE ? undefined : String(value));
        onPicked();
      }}
    >
      <MenuGroupLabel>Model</MenuGroupLabel>
      <MenuRadioItem value={DEFAULT_VALUE}>
        <MenuOptionContent title="Default" description="Use this runtime’s configured model" />
      </MenuRadioItem>
      {model.models.map((entry) => (
        <MenuRadioItem key={entry.id} value={entry.id}>
          <MenuOptionContent title={entry.label} description={entry.description} />
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/** Reasoning effort as a vertical list, the same row idiom as the model
 * list beside it. The Default row (clears any override) leads, then each
 * level the runtime advertises, in its own order. Being data-driven rows,
 * it renders any agent's set — Claude's Low…Max, Codex's Light…Ultra —
 * with no wrapping or layout risk. */
function EffortRadioGroup({ effort, onPicked }: { effort: ComposerEffortControl; onPicked: () => void }) {
  const efforts = effortOptions(effort.supported);
  return (
    <MenuRadioGroup
      value={effort.level ?? DEFAULT_VALUE}
      onValueChange={(value) => {
        effort.onSet(value === DEFAULT_VALUE ? undefined : (value as EffortLevel));
        onPicked();
      }}
    >
      <MenuGroupLabel>Effort</MenuGroupLabel>
      <MenuRadioItem value={DEFAULT_VALUE} className="text-sm">
        <span className={cn('min-w-0 truncate', !effort.level && 'font-medium')}>
          Default
          {/* The session inherited a non-default effort from a resumed
            * transcript; the Default row is where you'd clear it, so it's
            * where the current inherited state reads. */}
          {effort.inherited && !effort.level && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">inherited</span>
          )}
        </span>
      </MenuRadioItem>
      {efforts.map((level) => (
        <MenuRadioItem key={level} value={level} className="text-sm">
          <span className={cn('min-w-0 truncate', effort.level === level && 'font-medium')}>
            {effortLabel(level)}
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/** The parent menu's row for one setting: its name, its current value,
 * and the flyout holding that setting's list. The row doubles as the
 * settings' read-back — what the bar no longer spells, one click shows. */
function SettingRow({ name, value, locked, lockNote, children }: {
  name: string;
  value: string;
  locked: boolean;
  lockNote: string;
  children: ReactNode;
}) {
  return (
    <MenuSubmenu>
      <MenuSubmenuTrigger
        disabled={locked}
        title={locked ? `${name} — ${value} (${lockNote})` : undefined}
      >
        <span className="flex-1 text-sm font-medium">{name}</span>
        <span className="min-w-0 truncate text-sm text-muted-foreground">{value}</span>
      </MenuSubmenuTrigger>
      <MenuPortal>
        <MenuPositioner>
          <MenuPopup className={cn(menuPopupClass, 'max-h-overlay-sm')}>
            {children}
          </MenuPopup>
        </MenuPositioner>
      </MenuPortal>
    </MenuSubmenu>
  );
}

const EFFORT_LOCK_NOTE = 'fixed for this conversation';

/** The settings pill — model and effort behind one trigger.
 *
 * The trigger names the model; an explicit effort override is the only
 * other state worth bar space and rides along as a suffix ("GPT-5.6 Sol ·
 * High"). An inherited effort stays off the bar — it is the session's own
 * default, and the Default row inside the menu is where it reads.
 *
 * Locking degrades at the smallest surface that cannot act: a pinned
 * model dims its own row — still naming its value and why — while effort
 * stays adjustable, and the pill itself goes inert only when everything
 * behind it is pinned. When a runtime advertises only one of the two
 * settings, the pill opens that list directly: a one-row parent menu
 * would be a hop that buys nothing. */
export function ModelEffortMenu({ model, effort, disabled }: {
  model: ComposerModelControl;
  effort: ComposerEffortControl;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const bothShow = model.show && effort.show;
  const modelLabel = modelMenuLabel(model.models, model.selected, model.active, model.resumedSession);
  const effortName = effort.level ? effortLabel(effort.level) : effort.inherited ? 'Inherited' : 'Default';
  const allLocked = (!model.show || model.locked) && (!effort.show || effort.locked);
  const lockNote = (model.show && model.lockReason) || EFFORT_LOCK_NOTE;

  const pillLabel = model.show
    ? (modelLabel === 'Default' ? 'Model: Default' : modelLabel)
      + (bothShow && effort.level ? ` · ${effortLabel(effort.level)}` : '')
    : effortName === 'Default' ? 'Effort: Default' : effortName;
  const ariaLabel = bothShow
    ? `Model and effort: ${modelLabel}, ${effortName}${allLocked ? ` — ${lockNote}` : ''}`
    : model.show
      ? `Model: ${modelLabel}${model.locked && model.lockReason ? ` — ${model.lockReason}` : ''}`
      : `Reasoning effort: ${effortName}${effort.locked ? ` — ${EFFORT_LOCK_NOTE}` : ''}`;
  const title = (bothShow
    ? `Model — ${modelLabel} · Effort — ${effortName}`
    : model.show ? `Model — ${modelLabel}` : `Effort — ${effortName}`)
    + (allLocked ? ` (${lockNote})` : '');

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={<Pill locked={allLocked} className="max-w-48" />}
        disabled={disabled || allLocked}
        aria-label={ariaLabel}
        title={title}
      >
        {pillLabel}
      </MenuTrigger>
      <MenuPortal>
        <MenuPositioner side="top" align="end" sideOffset={6}>
          {bothShow ? (
            <MenuPopup className="w-60">
              <SettingRow
                name="Model"
                value={modelLabel}
                locked={model.locked}
                lockNote={model.lockReason ?? EFFORT_LOCK_NOTE}
              >
                <ModelRadioGroup model={model} onPicked={close} />
              </SettingRow>
              <SettingRow name="Effort" value={effortName} locked={effort.locked} lockNote={EFFORT_LOCK_NOTE}>
                <EffortRadioGroup effort={effort} onPicked={close} />
              </SettingRow>
            </MenuPopup>
          ) : (
            <MenuPopup className={cn(menuPopupClass, model.show && 'max-h-overlay-sm')}>
              {model.show
                ? <ModelRadioGroup model={model} onPicked={close} />
                : <EffortRadioGroup effort={effort} onPicked={close} />}
            </MenuPopup>
          )}
        </MenuPositioner>
      </MenuPortal>
    </Menu>
  );
}

/** Mode pill — the permission-mode list, and nothing else.
 *
 * Mode stays OUTSIDE the settings pill: it is the panel's permission
 * state, so it must read without opening a menu; it is the one session
 * setting that flips mid-conversation (plan → edit); and Shift-Tab cycles
 * it, a shortcut whose effect has to land somewhere visible. The earlier
 * one-popup design showed the other half of the argument — stacking
 * effort under the mode list made a panel tall enough to scroll, read as
 * two menus in one card, and left the trigger naming two values at once —
 * which is why the settings pill keeps each of its lists in its own
 * flyout instead. */
export function ModeMenu({ mode, disabled }: {
  mode: ComposerModeControl;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const activeMode = MODES.find((m) => m.id === mode.value) ?? MODES[0];
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={<Pill className="max-w-40" />}
        disabled={disabled}
        aria-label={`Permission mode: ${activeMode.label} — ${activeMode.desc}`}
        title={`Permission mode — ${activeMode.label}`}
      >
        {activeMode.label}
      </MenuTrigger>
      <MenuPortal>
        <MenuPositioner side="top" align="end" sideOffset={6}>
          <MenuPopup className={menuPopupClass}>
            <MenuRadioGroup
              value={mode.value}
              onValueChange={(value) => { mode.onSet(value as PermMode); setOpen(false); }}
            >
              <MenuGroupLabel>Mode</MenuGroupLabel>
              {MODES.map((m) => (
                <MenuRadioItem key={m.id} value={m.id}>
                  <MenuOptionContent icon={m.Icon} title={m.label} description={m.desc} />
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </MenuPositioner>
      </MenuPortal>
    </Menu>
  );
}

/** Agent control for the composer bar's leading pill — which agent this
 *  not-yet-started chat talks to. Only a blank chat shows it: a started
 *  conversation belongs to its agent, so the pill leaves the bar rather
 *  than sit disabled forever. Picking rebinds the CURRENT tab (the
 *  choice is visible at the point of use, unlike the old sidebar picker
 *  that silently set "the next chat"). */
export interface ComposerAgentControl {
  show: boolean;
  current: AgentKind;
  onPick: (agent: AgentKind) => void;
}

export function AgentMenu({ agentPick, disabled }: {
  agentPick: ComposerAgentControl;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const accountSignedIn = useSyncExternalStore(
    subscribeAccountSignedIn,
    accountSignedInSnapshot,
    accountSignedInSnapshot,
  );
  const current = AGENT_META[agentPick.current];

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={<Pill className="max-w-40" />}
        disabled={disabled}
        aria-label={`Agent: ${current.launcherLabel}`}
        title="Choose the agent for this chat"
      >
        {current.launcherLabel}
      </MenuTrigger>
      <MenuPortal>
        <MenuPositioner side="top" align="start" sideOffset={6}>
          <MenuPopup className="w-72">
            <MenuRadioGroup
              value={agentPick.current}
              onValueChange={(value) => {
                agentPick.onPick(value as AgentKind);
                setOpen(false);
              }}
            >
              <MenuGroupLabel>Agent</MenuGroupLabel>
              {AGENTS.map((agent) => (
                <MenuRadioItem key={agent.id} value={agent.id}>
                  <MenuOptionContent
                    icon={agent.Icon}
                    title={agent.launcherLabel}
                    description={agent.id === 'stashbase' ? wikiAgentLauncherDetail(accountSignedIn) : undefined}
                  />
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </MenuPositioner>
      </MenuPortal>
    </Menu>
  );
}
