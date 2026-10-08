/**
 * The composer's persona picker: who the Agent is when it talks and writes in
 * this Chat.
 *
 * The list is the reader's own library, shared by every project. Choosing one
 * runs this Chat under it from the next message and makes it the persona the
 * project's next new Chat starts with. A pick keeps the menu open, the way
 * every choice menu in the composer does, so the check can be seen to move
 * and a refused save can be read where it was made. Each row edits on its
 * trailing pencil; the foot of the menu writes a new one or opens the
 * Gallery to add one.
 */
import { ChevronDown, CircleDashed, Drama, LayoutGrid, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownContent,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from '@/components/ui/dropdown';
import { MenuItem } from '@/components/ui/menu-item';
import { Tooltip } from '@/components/ui/tooltip';
import type { AgentPersona } from '@/features/agent/application/ports';
import type { AgentPersonaPicker } from '@/features/agent/hooks/use-agent-persona';
import { NARROW_LABEL, NARROW_TRIGGER } from '@/features/agent/ui/composer/narrow';
import { cn } from '@/lib/utils';
import { FailureNotice } from '@/shared/ui/failure-notice';
import { personaIcon } from '@/shared/ui/persona-icon';

import { AgentPersonaDialog } from './agent-persona-dialog';

export interface AgentPersonaControlProps {
  /** A turn is running; a session's persona is fixed for its run. */
  disabled: boolean;
  picker: AgentPersonaPicker;
  /** Opens the Gallery on its personas; absent hides the row. */
  onBrowse?: (() => void) | undefined;
}

export function AgentPersonaControl({ disabled, onBrowse, picker }: AgentPersonaControlProps) {
  // `undefined` is closed, `null` a new persona, otherwise the one in edit.
  const [editing, setEditing] = useState<AgentPersona | null | undefined>(undefined);
  const [openings, setOpenings] = useState(0);
  const chosen = picker.selected;
  const label = chosen ? `Persona: ${chosen.name}` : 'Persona';
  const locked = disabled || picker.saving;
  const edit = (persona: AgentPersona | null) => {
    picker.dismissFailure();
    setOpenings((count) => count + 1);
    setEditing(persona);
  };

  return (
    <>
      <DropdownMenu
        disabled={locked}
        onOpenChange={(open) => {
          if (open) picker.dismissFailure();
        }}
      >
        <Tooltip content={label} side="top">
          <DropdownTrigger
            render={
              <Button
                aria-label={label}
                className={cn('max-w-44', NARROW_TRIGGER)}
                disabled={locked}
                leadingIcon={chosen ? personaIcon(chosen.icon) : Drama}
                size="compact"
                trailingIcon={ChevronDown}
                variant="ghost"
              >
                <span className={cn('min-w-0 truncate', NARROW_LABEL)}>
                  {chosen?.name ?? 'Persona'}
                </span>
              </Button>
            }
          />
        </Tooltip>
        <DropdownContent
          align="start"
          className="max-h-[min(70vh,32rem)] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto"
          selectionAppearance="none"
          side="top"
        >
          <MenuItem
            checked={chosen === null}
            closeOnClick={false}
            description="The Agent’s own voice"
            icon={CircleDashed}
            label="None"
            onSelect={() => picker.choose(null)}
          />
          {picker.personas.map((persona) => (
            <MenuItem
              checked={chosen?.id === persona.id}
              closeOnClick={false}
              icon={personaIcon(persona.icon)}
              key={persona.id}
              label={persona.name}
              onSelect={() => picker.choose(persona.id)}
              trailingAction={{
                icon: Pencil,
                label: `Edit ${persona.name}`,
                onSelect: () => edit(persona),
              }}
              {...(persona.description ? { description: persona.description } : {})}
            />
          ))}
          <DropdownSeparator />
          <MenuItem icon={Plus} label="New persona…" onSelect={() => edit(null)} />
          {onBrowse && <MenuItem icon={LayoutGrid} label="Browse personas…" onSelect={onBrowse} />}
          {picker.failure && editing === undefined && (
            <FailureNotice className="m-1" failure={picker.failure} />
          )}
        </DropdownContent>
      </DropdownMenu>
      <AgentPersonaDialog
        key={openings}
        onClose={() => setEditing(undefined)}
        open={editing !== undefined}
        persona={editing ?? null}
        picker={picker}
      />
    </>
  );
}
