import { ArrowLeft } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { GalleryPersona } from '@/features/gallery/domain/persona';
import { cn } from '@/lib/utils';
import { lazySurface } from '@/shared/runtime/lazy-surface';
import { personaIcon } from '@/shared/ui/persona-icon';

/* The Markdown renderer is the Agent transcript's weight; the shop opens
 * without it and fetches it only once a persona page is read. */
const SampleMarkdown = lazySurface(() => import('./sample-markdown'));

function Section({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h4 className="m-0 text-caption font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </h4>
      {children}
    </section>
  );
}

/**
 * One persona's page: what it writes, then what it is told.
 *
 * The sample comes first because it answers the question a reader brings,
 * which is how this voice sounds; the request above it is the same for every
 * persona, so moving between pages compares voices rather than topics. The
 * prompt follows for a reader who wants to see exactly what the Agent is
 * given. Adding copies it into the reader's own library, where it can be
 * edited like any other.
 */
export function GalleryPersonaPage({
  added,
  adding,
  persona,
  onAdd,
  onBack,
}: {
  added: boolean;
  adding: boolean;
  persona: GalleryPersona;
  onAdd(persona: GalleryPersona): void;
  onBack(): void;
}) {
  const Icon = personaIcon(persona.icon);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          'grid min-h-0 flex-1 gap-8 overflow-y-auto',
          '@2xl:grid-cols-[minmax(0,1.3fr)_minmax(18rem,1fr)] @2xl:overflow-hidden',
        )}
      >
        <div className="scroll-fade flex min-h-0 min-w-0 flex-col gap-5 [--scroll-fade-size:1.25rem] @2xl:overflow-y-auto">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
              <h3 className="m-0 text-title font-semibold tracking-tight text-foreground">
                {persona.name}
              </h3>
              <Badge color="gray" size="compact">
                {persona.category}
              </Badge>
            </div>
            <p className="m-0 mt-1.5 text-body leading-relaxed text-muted-foreground">
              {persona.description}
            </p>
          </div>
          <Section label="Sample">
            {persona.sample ? (
              <div className="flex flex-col gap-3">
                <p className="m-0 text-body leading-relaxed text-muted-foreground">
                  {persona.sample.request}
                </p>
                <SampleMarkdown markdown={persona.sample.reply} />
              </div>
            ) : (
              <p className="m-0 text-body leading-relaxed text-muted-foreground">
                A sample for this persona isn’t published yet.
              </p>
            )}
          </Section>
        </div>
        <div className="min-h-0 min-w-0 @2xl:overflow-y-auto">
          <Section label="Persona">
            <p className="m-0 text-body leading-relaxed whitespace-pre-line text-foreground">
              {persona.prompt}
            </p>
          </Section>
        </div>
      </div>

      <div className="mt-4 flex shrink-0 items-center justify-between gap-4 border-t border-border pt-4">
        <Button
          className="-ml-3 shrink-0"
          leadingIcon={ArrowLeft}
          onClick={onBack}
          size="compact"
          variant="ghost"
        >
          All personas
        </Button>
        <Button
          className="shrink-0"
          disabled={added}
          loading={adding}
          onClick={() => onAdd(persona)}
          variant="primary"
        >
          {added ? 'Added to your personas' : 'Add to my personas'}
        </Button>
      </div>
    </div>
  );
}
