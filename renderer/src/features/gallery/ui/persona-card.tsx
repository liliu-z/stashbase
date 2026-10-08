import type { GalleryPersona } from '@/features/gallery/domain/persona';
import { focusRing } from '@/lib/focus-ring';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import { personaIcon } from '@/shared/ui/persona-icon';

/** The opening of a reply as plain text: Markdown marks read as noise in a
 *  four-line excerpt, and the page renders the reply properly. */
function excerpt(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/^>\s?/gmu, '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gmu, '')
    .replace(/\*\*|__|`/gu, '');
}

/**
 * One ready-made persona on the shelf.
 *
 * A persona has no picture, so its card is the opening of its own sample
 * reply: what the voice sounds like is the reason to want it. Like a Wiki
 * card the whole card opens the entry page, and adding is a decision that
 * page asks for.
 */
export function GalleryPersonaCard({
  added,
  persona,
  onOpen,
}: {
  added: boolean;
  persona: GalleryPersona;
  onOpen(persona: GalleryPersona): void;
}) {
  const shape = useShape();
  const Icon = personaIcon(persona.icon);
  return (
    <button
      className={cn(
        'group flex h-full min-h-44 w-full cursor-pointer flex-col gap-3 border border-border bg-surface-2 p-4 text-left shadow-surface-2 transition-colors duration-fast outline-none hover:border-foreground/25',
        shape.card,
        focusRing(),
      )}
      onClick={() => onOpen(persona)}
      type="button"
    >
      <span className="flex items-center gap-2">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-body font-medium text-foreground">
          {persona.name}
        </span>
        <span className="ml-auto shrink-0 text-caption text-muted-foreground">
          {added ? 'Added' : <span className="capitalize">{persona.category}</span>}
        </span>
      </span>
      <span className="text-caption text-muted-foreground">{persona.description}</span>
      {persona.sample && (
        <span className="line-clamp-4 text-caption leading-relaxed whitespace-pre-line text-foreground/80">
          {excerpt(persona.sample.reply)}
        </span>
      )}
    </button>
  );
}
