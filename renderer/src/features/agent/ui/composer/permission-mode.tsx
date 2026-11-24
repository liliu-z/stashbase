/** Shared mode labels with descriptions of the selected runtime's policy. */
import { Bolt, Compass, FilePenLine, MessageCircleQuestion } from 'lucide-react';

import { DropdownContent, DropdownMenu } from '@/components/ui/dropdown';
import { MenuItem } from '@/components/ui/menu-item';
import { AGENT_ACCESS_MODES, type AgentAccessMode } from '@/features/agent/domain/access';
import type { AgentId } from '@/features/agent/domain/session';

import { ComposerMenuTrigger } from './menu-trigger';
import { NARROW_LABEL, NARROW_TRIGGER } from './narrow';

const MODE_LABELS = { default: 'Ask', plan: 'Plan', acceptEdits: 'Edit', auto: 'Auto' } as const;

const MODE_DESCRIPTIONS = {
  stashbase: {
    default: 'Asks before changes, commands, web fetches and outside access',
    plan: 'Reads and explores; refuses changes and commands',
    acceptEdits: 'Allows ordinary project document writes; asks for other actions',
    auto: 'Allows project document writes; AI reviews commands, web fetches and outside reads. Uncertain reviews ask you',
  },
  claude: {
    default: 'Claude asks when its permission rules require approval',
    plan: 'Claude plans and explores; requests outside its plan rules may still ask',
    acceptEdits: 'Claude allows edits and some file commands; its permission rules still apply',
    auto: 'Claude reviews actions using its own rules and AI reviewer; some requests still ask and others may be denied',
  },
  codex: {
    default: 'Runs within the sandbox; asks when Codex requires additional approval',
    plan: 'Uses a read-only sandbox; additional access may still ask',
    acceptEdits:
      'Runs within the sandbox and allows project document writes; additional access asks',
    auto: 'Runs within the sandbox; Codex reviews additional access. Some requests still ask and denied actions stay blocked',
  },
  antigravity: {
    default: 'Allows reads; asks before changes, commands and web access',
    plan: 'Allows reads; refuses changes and commands. Web access asks',
    acceptEdits: 'Allows ordinary project writes; commands, web access and other changes ask',
    auto: 'Allows project writes, recognized read commands, searches and query-free page reads; other actions ask',
  },
} satisfies Record<AgentId, Record<AgentAccessMode, string>>;

// Plan explores, so it wears the compass.
const MODE_ICONS = {
  default: MessageCircleQuestion,
  plan: Compass,
  acceptEdits: FilePenLine,
  auto: Bolt,
} satisfies Record<AgentAccessMode, typeof MessageCircleQuestion>;

export function AgentPermissionMode({
  agent,
  disabled,
  mode,
  modes,
  onChange,
}: {
  agent: AgentId;
  disabled?: boolean;
  mode: AgentAccessMode;
  /** The modes supported by this runtime. */
  modes: readonly AgentAccessMode[];
  onChange(mode: AgentAccessMode): void;
}) {
  const descriptions = MODE_DESCRIPTIONS[agent];
  const offered = AGENT_ACCESS_MODES.filter((entry) => modes.includes(entry));
  return (
    <DropdownMenu>
      <ComposerMenuTrigger
        className={NARROW_TRIGGER}
        description={descriptions[mode]}
        disabled={disabled ?? false}
        icon={MODE_ICONS[mode]}
        label={`Permission mode: ${MODE_LABELS[mode]}`}
      >
        <span className={NARROW_LABEL}>{MODE_LABELS[mode]}</span>
      </ComposerMenuTrigger>
      <DropdownContent align="end" className="w-80" selectionAppearance="none" side="top">
        {offered.map((entry) => (
          <MenuItem
            checked={entry === mode}
            description={descriptions[entry]}
            icon={MODE_ICONS[entry]}
            key={entry}
            label={MODE_LABELS[entry]}
            onSelect={() => onChange(entry)}
          />
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}
