/** Sample controls used by the document's appearance panel. */
import { ChevronDown, Plus } from 'lucide-react';
import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { Tooltip } from '@/components/ui/tooltip';
import type { SystemTextPort } from '@/features/settings/application/ports';
import {
  PAGE_COLORS,
  pageColorSwatch,
  PRESET_ROWS,
  READING_FONT_CHOICES,
  textureSwatch,
  type AppearancePreferences,
  type SwatchSide,
} from '@/features/settings/domain/appearance';
import type { AppearanceViewModel } from '@/features/settings/hooks/use-appearance';
import { useSystemText } from '@/features/settings/hooks/use-system-text';
import { DocumentFontPicker } from '@/features/settings/ui/appearance/document-font-picker';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';

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

export function FontChoices({
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

export function PageColorChoices({ appearance }: { appearance: AppearanceViewModel }) {
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
export function TextureChoices({ appearance }: { appearance: AppearanceViewModel }) {
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
