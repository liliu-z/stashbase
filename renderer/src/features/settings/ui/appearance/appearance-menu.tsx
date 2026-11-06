/** The document's appearance panel, offered on the page the way an e-reader
 *  offers its type panel: the reading font, each set in its own face, and a
 *  custom one from the computer's own fonts; the text size on a slider; the
 *  page colour, each a light and a dark theme that follow the system
 *  together; the page texture; then line width and line spacing. All are the
 *  app-wide Appearance preferences, edited through the same optimistic write
 *  as their Settings rows, so the two can never disagree. The panel stays
 *  open while the reader tries choices; a refused save rolls the choice back
 *  and names the failure inside it. The trigger is a glyph alone, named by
 *  its tooltip, so the bar stays quiet over the page. */
import { Popover } from '@base-ui/react/popover';
import { ChevronDown, Plus } from 'lucide-react';
import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import { Elevated } from '@/components/ui/elevated';
import { Tooltip } from '@/components/ui/tooltip';
import type { AppearancePort, SystemTextPort } from '@/features/settings/application/ports';
import {
  PAGE_COLORS,
  pageColorSwatch,
  PRESET_ROWS,
  presetChange,
  READING_FONT_CHOICES,
  textureSwatch,
  type AppearancePreferences,
  type PresetRow,
  type SwatchSide,
} from '@/features/settings/domain/appearance';
import { useAppearance, type AppearanceViewModel } from '@/features/settings/hooks/use-appearance';
import { useSystemText } from '@/features/settings/hooks/use-system-text';
import { DocumentFontPicker } from '@/features/settings/ui/appearance/document-font-picker';
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

/** The frame every large sample shares, a choice or the empty custom font:
 *  the chosen one wears an ink ring. */
function sampleFrame(shapeBg: string, checked: boolean, disabled: boolean) {
  return cn(
    shapeBg,
    'flex min-w-0 flex-1 flex-col items-center gap-1.5 px-1 pt-2 pb-1.5 text-caption transition-colors duration-fast has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[color:var(--focus-ring)]',
    checked ? 'text-foreground ring-1 ring-foreground/70' : 'text-muted-foreground',
    disabled ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-hover',
  );
}

/** One choice in a row of large samples: a font or a page colour. Native
 *  radios, as in the segmented picker, give the group its arrow keys and
 *  single tab stop. */
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
    <label className={sampleFrame(shape.bg, checked, disabled)}>
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

const sampleText = 'text-ui-26 leading-none';

/** The custom font: a family from those installed on this computer, a
 *  handwriting face among them, as the row's third sample. Serif and Sans are
 *  chosen where they stand; this one always opens the list, which its
 *  chevron says, with its family first so going back to it is one more
 *  click. It wears the ring while in use and keeps its family while Serif or
 *  Sans is. Outside the desktop app there is nothing installed to list, so
 *  it is not offered. */
function CustomFont({
  appearance,
  systemTextApi,
}: {
  appearance: AppearanceViewModel;
  systemTextApi: SystemTextPort;
}) {
  const shape = useShape();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const system = useSystemText(systemTextApi);
  const preferences = appearance.preferences;
  const family = preferences?.writingFont ?? null;
  const inUse = preferences?.readingFont === 'custom';
  const tile = (
    <button
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={family ? `Custom font: ${family}${inUse ? ', in use' : ''}` : 'Custom font'}
      className={sampleFrame(shape.bg, inUse, preferences === null)}
      disabled={preferences === null}
      onClick={() => setOpen(true)}
      ref={anchor}
      type="button"
    >
      {family ? (
        <span
          aria-hidden
          className={sampleText}
          style={{ fontFamily: `"${family}", var(--font-sans)` }}
        >
          Aa
        </span>
      ) : (
        <Plus aria-hidden className="size-6.5" strokeWidth={1.5} />
      )}
      <span className="flex max-w-full items-center gap-0.5">
        <span className="truncate">{family ?? 'Custom'}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0" />
      </span>
    </button>
  );
  return (
    <>
      {/* A long family truncates on the tile; the tooltip names it whole. */}
      {family ? (
        <Tooltip content={family} side="top">
          {tile}
        </Tooltip>
      ) : (
        tile
      )}
      {/* The list is the tile's sibling, never its child: React carries a
          click in the portaled list up its own tree, and through the tile it
          would reopen the list it just closed. */}
      <DocumentFontPicker
        appearance={appearance}
        control={{ anchor, onOpenChange: setOpen, open }}
        system={system}
      />
    </>
  );
}

function FontChoices({
  appearance,
  systemTextApi,
}: {
  appearance: AppearanceViewModel;
  systemTextApi: SystemTextPort | undefined;
}) {
  const name = useId();
  const preferences = appearance.preferences;
  // The custom font opens a list rather than being chosen in place, so it
  // stands beside the radio group rather than in it.
  return (
    <div className="flex gap-1.5">
      <div aria-label="Font" className="flex min-w-0 flex-[2] gap-1.5" role="radiogroup">
        {READING_FONT_CHOICES.map((choice) => (
          <SampleChoice
            checked={preferences?.readingFont === choice.value}
            disabled={preferences === null}
            key={choice.value}
            label={choice.label}
            name={name}
            onChoose={() => appearance.change({ readingFont: choice.value })}
          >
            <span aria-hidden className={sampleText} style={{ fontFamily: choice.fontFamily }}>
              Aa
            </span>
          </SampleChoice>
        ))}
      </div>
      {systemTextApi && (
        <div className="flex min-w-0 flex-1">
          <CustomFont appearance={appearance} systemTextApi={systemTextApi} />
        </div>
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

type PageTexture = AppearancePreferences['pageTexture'];

const DARK_SCHEME = '(prefers-color-scheme: dark)';

function subscribeToScheme(listener: () => void) {
  const query = globalThis.matchMedia?.(DARK_SCHEME);
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
}

const systemIsDark = () => globalThis.matchMedia?.(DARK_SCHEME).matches ?? false;

/** One half of a texture swatch, in its own page and ink, at a scale a
 *  28px circle can show: dots seven pixels apart so both halves keep one
 *  grid, and grain stacked until its fibres read. A dark half never carries
 *  grain, which is how the swatch says grain belongs to a light page. */
function textureHalf(texture: PageTexture, side: SwatchSide, light: boolean): CSSProperties {
  if (texture === 'dots') {
    return {
      backgroundColor: side.page,
      backgroundImage: `radial-gradient(circle, color-mix(in oklab, ${side.ink} 50%, transparent) 0 1px, transparent 1.4px)`,
      backgroundSize: '7px 7px',
    };
  }
  if (texture === 'grain' && light) {
    return {
      backgroundColor: side.page,
      backgroundImage: `var(--paper-grain), var(--paper-grain), var(--paper-grain), radial-gradient(circle at 100% 50%, transparent 40%, color-mix(in oklab, ${side.ink} 16%, transparent))`,
      backgroundSize: '110px 110px, 110px 110px, 110px 110px, auto',
    };
  }
  return { backgroundColor: side.page };
}

/** The textures drawn rather than named, each over the reader's own light
 *  and dark page like the page colours above them; and why a chosen grain is
 *  not showing, since a dark page says so rather than appearing not to work. */
function TextureChoices({ appearance }: { appearance: AppearanceViewModel }) {
  const name = useId();
  const systemDark = useSyncExternalStore(subscribeToScheme, systemIsDark, () => false);
  const preferences = appearance.preferences;
  const swatch = textureSwatch(
    preferences ?? { darkTheme: 'stashbase-dark', lightTheme: 'stashbase-light' },
  );
  const darkPage = preferences?.theme === 'dark' || (preferences?.theme === 'system' && systemDark);
  return (
    <>
      <div aria-label="Page texture" className="flex gap-1.5" role="radiogroup">
        {PRESET_ROWS.pageTexture.choices.map((choice) => (
          <SampleChoice
            checked={preferences?.pageTexture === choice.value}
            disabled={preferences === null}
            key={choice.value}
            label={choice.label}
            name={name}
            onChoose={() => appearance.change({ pageTexture: choice.value })}
          >
            <span
              aria-hidden
              className="flex size-7 overflow-hidden rounded-full ring-1 ring-foreground/15"
            >
              <span className="flex-1" style={textureHalf(choice.value, swatch.light, true)} />
              <span className="flex-1" style={textureHalf(choice.value, swatch.dark, false)} />
            </span>
          </SampleChoice>
        ))}
      </div>
      {darkPage && preferences?.pageTexture === 'grain' && (
        <p className="m-0 text-caption text-muted-foreground">Grain shows on light pages.</p>
      )}
    </>
  );
}

export function AppearanceMenu({
  appearanceApi,
  systemTextApi,
}: {
  appearanceApi: AppearancePort;
  systemTextApi?: SystemTextPort | undefined;
}) {
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
                <FontChoices appearance={appearance} systemTextApi={systemTextApi} />
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
              <Section title="Page texture">
                <TextureChoices appearance={appearance} />
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
