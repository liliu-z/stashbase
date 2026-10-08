/** One Gallery entry's page, and the section frame its spec sheet is built
 *  from. The reasoning behind the order of the page sits on the component. */
import { ArrowLeft } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { GalleryEntry } from '@/features/gallery/domain/entry';
import { cn } from '@/lib/utils';

import { GalleryScreenshot } from './screenshots';

/** Plain text into paragraphs: a blank line is the one separator the index
 *  promises, and a stray run of them is not a third paragraph. Each carries a
 *  key of its own text, numbered on repeat, so a list of them needs no index. */
function paragraphs(text: string): { key: string; text: string }[] {
  const seen = new Map<string, number>();
  return text
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => {
      const repeat = seen.get(paragraph) ?? 0;
      seen.set(paragraph, repeat + 1);
      return { key: repeat === 0 ? paragraph : `${paragraph}#${repeat}`, text: paragraph };
    });
}

/** A section of the spec sheet: one quiet label over one artifact. */
function Section({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-2', className)}>
      <h4 className="m-0 text-caption font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </h4>
      {children}
    </section>
  );
}

/** Details show one cover and the project introduction. Local acquisition
 * and window allocation belong to the shared project-entry flow. */
export function GalleryEntryPage({
  copying,
  entry,
  onBack,
  onCopy,
}: {
  copying: boolean;
  entry: GalleryEntry;
  onBack(): void;
  onCopy(entry: GalleryEntry): void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The website's order: the name across the top, then the cover on the
       * left and the introduction beside it, so one template reads the same
       * in both places. */}
      <div className="mb-6 min-w-0 shrink-0">
        <div className="flex items-center gap-2">
          <h3 className="m-0 text-title font-semibold tracking-tight text-foreground">
            {entry.name}
          </h3>
          {/* The same badge the card carried, so the shelf and the page
           * agree about what this is. */}
          <Badge color="gray" size="compact">
            {entry.category}
          </Badge>
        </div>
        <p className="m-0 mt-1.5 text-body leading-relaxed text-muted-foreground">
          {entry.description}
        </p>
      </div>

      <div
        className={cn(
          'grid min-h-0 flex-1 content-start gap-8 overflow-y-auto',
          '@2xl:grid-cols-[minmax(0,1.3fr)_minmax(18rem,1fr)] @2xl:overflow-hidden',
        )}
      >
        <div className="min-w-0 @2xl:min-h-0">
          <GalleryScreenshot name={entry.name} screenshot={entry.screenshot} />
        </div>

        <div className="scroll-fade flex min-w-0 flex-col gap-5 [--scroll-fade-size:1.25rem] @2xl:min-h-0 @2xl:overflow-y-auto">
          <Section label="About">
            {entry.about ? (
              <div className="flex flex-col gap-2">
                {paragraphs(entry.about).map((paragraph) => (
                  <p
                    className="m-0 text-subtitle leading-relaxed text-foreground"
                    key={paragraph.key}
                  >
                    {paragraph.text}
                  </p>
                ))}
              </div>
            ) : (
              <p className="m-0 text-body leading-relaxed text-muted-foreground">
                The introduction for this project isn’t published yet.
              </p>
            )}
          </Section>
        </div>
      </div>

      <div className="mt-4 flex shrink-0 items-center justify-between gap-4 border-t border-border pt-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            className="-ml-3 shrink-0"
            leadingIcon={ArrowLeft}
            onClick={onBack}
            size="compact"
            variant="ghost"
          >
            Gallery home
          </Button>
        </div>
        <Button
          className="shrink-0"
          loading={copying}
          onClick={() => onCopy(entry)}
          variant="primary"
        >
          Make a copy
        </Button>
      </div>
    </div>
  );
}
