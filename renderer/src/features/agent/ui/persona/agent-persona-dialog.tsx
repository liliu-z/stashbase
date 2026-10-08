/**
 * The persona editor: writes a new persona or edits one in the library.
 */
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AgentPersona } from '@/features/agent/application/ports';
import type { AgentPersonaPicker } from '@/features/agent/hooks/use-agent-persona';
import { focusRing } from '@/lib/focus-ring';
import { shapeTokens } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import {
  DEFAULT_PERSONA_ICON,
  PERSONA_ICON_NAMES,
  type PersonaIconName,
} from '@/shared/domain/persona-icon';
import { FailureNotice } from '@/shared/ui/failure-notice';
import { PERSONA_ICONS } from '@/shared/ui/persona-icon';
import { textFieldClass } from '@/shared/ui/text-field';

/* Fields sit one step above the dialog rather than on `background`, which on
 * a light panel reads as a hole punched through it. The prompt takes the
 * reading face: a persona is prose a writer writes about a voice. */
const LINE_CLASS = textFieldClass('bg-surface-3 text-body text-foreground', shapeTokens.panel);
const PROMPT_CLASS = textFieldClass(
  'h-[min(36vh,18rem)] resize-none overflow-auto bg-surface-3 text-body leading-relaxed text-foreground',
  shapeTokens.panel,
);
const LABEL_CLASS = 'text-caption text-muted-foreground';

export interface AgentPersonaDialogProps {
  onClose(): void;
  open: boolean;
  /** The persona in edit, or null to write a new one. */
  persona: AgentPersona | null;
  picker: AgentPersonaPicker;
}

/**
 * Writes a new persona or edits one in the library.
 *
 * Saving a new persona also runs it in this Chat, since writing one is how a
 * reader asks for it. Saving an edit changes it everywhere it is chosen, from
 * each Chat's next message. Delete asks once more in place rather than over
 * a second dialog.
 */
export function AgentPersonaDialog({ onClose, open, persona, picker }: AgentPersonaDialogProps) {
  // The caller remounts the dialog for each opening, so every opening starts
  // from what is stored and an abandoned draft is not kept.
  const [name, setName] = useState(persona?.name ?? '');
  const [description, setDescription] = useState(persona?.description ?? '');
  const [icon, setIcon] = useState<PersonaIconName>(persona?.icon ?? DEFAULT_PERSONA_ICON);
  const [prompt, setPrompt] = useState(persona?.prompt ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const ids = { description: useId(), icon: useId(), name: useId(), prompt: useId() };

  const ready = name.trim() !== '' && prompt.trim() !== '';
  const changed =
    !persona ||
    name.trim() !== persona.name ||
    description.trim() !== persona.description ||
    icon !== persona.icon ||
    prompt.trim() !== persona.prompt;

  const save = async () => {
    const input = {
      description,
      gallery: persona?.gallery ?? null,
      icon,
      name,
      prompt,
    };
    if (await picker.save(persona?.id ?? null, input)) onClose();
  };
  const remove = async () => {
    if (!persona) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    if (await picker.remove(persona.id)) onClose();
  };

  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      <DialogContent width="wide">
        <DialogHeader>
          <DialogTitle>{persona ? 'Edit persona' : 'New persona'}</DialogTitle>
          <DialogDescription className="text-muted-foreground/70">
            How the Agent talks and writes. Applies from your next message.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <label className="flex min-w-0 flex-col gap-1" htmlFor={ids.name}>
              <span className={LABEL_CLASS}>Name</span>
              <input
                className={LINE_CLASS}
                disabled={picker.saving}
                id={ids.name}
                onChange={(event) => setName(event.target.value)}
                placeholder="My newsletter voice"
                value={name}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1" htmlFor={ids.description}>
              <span className={LABEL_CLASS}>Description</span>
              <input
                className={LINE_CLASS}
                disabled={picker.saving}
                id={ids.description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Optional. One line in the picker"
                value={description}
              />
            </label>
          </div>
          <div className="flex flex-col gap-1">
            <span className={LABEL_CLASS} id={ids.icon}>
              Icon
            </span>
            <div aria-labelledby={ids.icon} className="flex flex-wrap gap-1" role="radiogroup">
              {PERSONA_ICON_NAMES.map((glyph) => {
                const Glyph = PERSONA_ICONS[glyph];
                const selected = glyph === icon;
                return (
                  <button
                    aria-checked={selected}
                    aria-label={glyph.replace(/-/gu, ' ')}
                    className={cn(
                      'flex size-8 cursor-pointer items-center justify-center text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground',
                      shapeTokens.item,
                      selected && 'bg-hover text-foreground',
                      focusRing(),
                    )}
                    disabled={picker.saving}
                    key={glyph}
                    onClick={() => setIcon(glyph)}
                    role="radio"
                    type="button"
                  >
                    <Glyph aria-hidden className="size-4" />
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex flex-col gap-1" htmlFor={ids.prompt}>
            <span className={LABEL_CLASS}>Persona</span>
            <textarea
              className={PROMPT_CLASS}
              disabled={picker.saving}
              id={ids.prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Who is the Agent? How does it talk, and how does it write?"
              value={prompt}
            />
          </label>
        </div>
        {picker.failure && <FailureNotice className="m-0" failure={picker.failure} />}
        <DialogFooter>
          {persona && (
            <Button
              className="mr-auto"
              disabled={picker.saving}
              onClick={() => void remove()}
              variant="ghost"
            >
              {confirmingDelete ? 'Delete for good' : 'Delete'}
            </Button>
          )}
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!ready || !changed || picker.saving}
            loading={picker.saving}
            onClick={() => void save()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
