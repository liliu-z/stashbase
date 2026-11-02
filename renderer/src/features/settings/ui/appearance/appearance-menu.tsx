/** The document's appearance panel, offered on the page the way an e-reader
 *  offers its type panel: the reading font, each set in its own face; the
 *  text size on a slider; the page colour, each a light and a dark theme that
 *  follow the system together; then line width and line spacing. All are the
 *  app-wide Appearance preferences, edited through the same optimistic write
 *  as their Settings rows, so the two can never disagree. The panel stays open
 *  while the reader tries choices; a refused save rolls the choice back and
 *  names the failure inside it. The trigger is a glyph alone, named by its
 *  tooltip, so the bar stays quiet over the page. */
import { Popover } from '@base-ui/react/popover';
import { useId, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Elevated } from '@/components/ui/elevated';
import { Tooltip } from '@/components/ui/tooltip';
import type { AppearancePort } from '@/features/settings/application/ports';
import {
  PAGE_COLORS,
  pageColorSwatch,
  PRESET_ROWS,
  presetChange,
  READING_FONT_CHOICES,
  readingFontChange,
  type PresetRow,
} from '@/features/settings/domain/appearance';
import { useAppearance, type AppearanceViewModel } from '@/features/settings/hooks/use-appearance';
import { PresetChoice } from '@/features/settings/ui/appearance/preset-choice';
import { ReadingSizeSlider } from '@/features/settings/ui/appearance/reading-size-slider';
import { useShape } from '@/lib/shape-context';
import { SizeProvider } from '@/lib/size-context';
import { cn } from '@/lib/utils';
import { FailureNotice } from '@/shared/ui/failure-notice';

/** "Aa" set in the face the document is read in, the way the panel sets each
 *  font in its own face, so the glyph itself shows the current choice.
 *  Faces differ in cap height, so it is sized by its capitals: they stand as
 *  tall as the neighbouring icon in Serif, Sans, or an installed writing font
 *  alike. */
function ReadingTextGlyph() {
  return (
    <span
      aria-hidden
      className="block leading-none [text-box:trim-both_cap_alphabetic]"
      style={{
        fontFamily: 'var(--writing-font, var(--font-reading))',
        fontSize: 14,
        fontSizeAdjust: 'cap-height 0.72',
      }}
    >
      Aa
    </span>
  );
}

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="m-0 text-caption font-normal text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** One choice in a row of large samples: a font or a page colour. Native
 *  radios, as in the segmented picker, give the group its arrow keys and
 *  single tab stop; the chosen sample wears an ink ring. */
function SampleChoice({
  children,
  checked,
  disabled,
  label,
  name,
  onChoose,
}: {
  children: ReactNode;
  checked: boolean;
  disabled: boolean;
  label: string;
  name: string;
  onChoose(): void;
}) {
  const shape = useShape();
  return (
    <label
      className={cn(
        shape.bg,
        'flex min-w-0 flex-1 flex-col items-center gap-1.5 px-1 pt-2 pb-1.5 text-caption transition-colors duration-fast has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[color:var(--focus-ring)]',
        checked ? 'text-foreground ring-1 ring-foreground/70' : 'text-muted-foreground',
        disabled ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-hover',
      )}
    >
      <input
        checked={checked}
        className="sr-only"
        disabled={disabled}
        name={name}
        onChange={onChoose}
        type="radio"
        value={label}
      />
      {children}
      <span className="max-w-full truncate">{label}</span>
    </label>
  );
}

function FontChoices({ appearance }: { appearance: AppearanceViewModel }) {
  const name = useId();
  const preferences = appearance.preferences;
  // An installed writing font, chosen in Settings, stands in for either preset
  // until an included font is chosen here again.
  const installed = preferences?.writingFont ?? null;
  return (
    <div aria-label="Font" className="flex gap-1.5" role="radiogroup">
      {READING_FONT_CHOICES.map((choice) => (
        <SampleChoice
          checked={installed === null && preferences?.readingFont === choice.value}
          disabled={preferences === null}
          key={choice.value}
          label={choice.label}
          name={name}
          onChoose={() => appearance.change(readingFontChange(choice.value))}
        >
          <span
            aria-hidden
            className="text-ui-26 leading-none"
            style={{ fontFamily: choice.fontFamily }}
          >
            Aa
          </span>
        </SampleChoice>
      ))}
      {installed !== null && (
        <SampleChoice
          checked
          disabled={false}
          label={installed}
          name={name}
          onChoose={() => undefined}
        >
          <span
            aria-hidden
            className="text-ui-26 leading-none"
            style={{ fontFamily: `"${installed}"` }}
          >
            Aa
          </span>
        </SampleChoice>
      )}
    </div>
  );
}

function PageColorChoices({ appearance }: { appearance: AppearanceViewModel }) {
  const name = useId();
  const preferences = appearance.preferences;
  return (
    <div aria-label="Page color" className="flex gap-1.5" role="radiogroup">
      {PAGE_COLORS.map((color) => {
        const swatch = pageColorSwatch(color);
        return (
          <SampleChoice
            checked={
              preferences?.lightTheme === color.light && preferences.darkTheme === color.dark
            }
            disabled={preferences === null}
            key={color.label}
            label={color.label}
            name={name}
            onChoose={() => appearance.change({ lightTheme: color.light, darkTheme: color.dark })}
          >
            {/* Light half and dark half: the pair the system switches between. */}
            <span
              aria-hidden
              className="size-7 rounded-full ring-1 ring-foreground/15"
              style={{
                background: `linear-gradient(90deg, ${swatch.light} 50%, ${swatch.dark} 50%)`,
              }}
            />
          </SampleChoice>
        );
      })}
    </div>
  );
}

function PresetSection({
  appearance,
  row,
  title,
}: {
  appearance: AppearanceViewModel;
  row: PresetRow;
  title: string;
}) {
  const preferences = appearance.preferences;
  return (
    <Section title={title}>
      <PresetChoice
        choices={row.choices}
        disabled={preferences === null}
        fill
        label={title}
        onChoose={(value) => {
          const change = presetChange(row, value);
          if (change) appearance.change(change);
        }}
        value={preferences ? String(preferences[row.field]) : null}
      />
    </Section>
  );
}

export function AppearanceMenu({ appearanceApi }: { appearanceApi: AppearancePort }) {
  const appearance = useAppearance(appearanceApi);
  const shape = useShape();
  const preferences = appearance.preferences;
  return (
    <Popover.Root>
      <Tooltip content="Appearance" side="bottom">
        <Popover.Trigger
          render={
            <Button
              aria-label="Appearance"
              disabled={preferences === null}
              size="icon-compact"
              variant="ghost"
            >
              <ReadingTextGlyph />
            </Button>
          }
        />
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner
          align="start"
          className="z-50 outline-none"
          side="bottom"
          sideOffset={6}
        >
          <Popover.Popup
            aria-label="Appearance"
            className={cn(
              'flex w-76 max-w-[calc(100vw-16px)] flex-col gap-4 p-4 outline-none',
              shape.container,
            )}
            render={<Elevated offset={2} shadowLevel={3} />}
          >
            <SizeProvider size="compact">
              <Section title="Font">
                <FontChoices appearance={appearance} />
              </Section>
              <Section title="Text size">
                <ReadingSizeSlider appearance={appearance} />
              </Section>
              <Section title="Page color">
                <PageColorChoices appearance={appearance} />
                {/* Sized to its labels, track included: three equal segments
                 *  would wrap "Match system" at this width. */}
                <div className="flex">
                  <PresetChoice
                    choices={PRESET_ROWS.theme.choices}
                    disabled={preferences === null}
                    label={PRESET_ROWS.theme.title}
                    onChoose={(value) => {
                      const change = presetChange(PRESET_ROWS.theme, value);
                      if (change) appearance.change(change);
                    }}
                    value={preferences?.theme ?? null}
                  />
                </div>
              </Section>
              <PresetSection
                appearance={appearance}
                row={PRESET_ROWS.lineWidth}
                title="Line width"
              />
              <PresetSection
                appearance={appearance}
                row={PRESET_ROWS.lineSpacing}
                title="Line spacing"
              />
            </SizeProvider>
            {appearance.failure && (
              <FailureNotice className="text-caption" failure={appearance.failure} />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
