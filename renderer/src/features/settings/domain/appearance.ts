/**
 * The Appearance settings as the panel lists them: which rows exist, the
 * presets each offers and their labels, the theme lists, the bundled fonts,
 * and the editor toggles. One table per kind of row, so the panel renders
 * rows rather than knowing any preference by name.
 */
import { DARK_THEMES, LIGHT_THEMES } from '@/contracts/appearance-themes';
import type { AppearanceSurface } from '@/shared/domain/appearance';

/** The saved appearance is exactly what a window applies. */
export type AppearancePreferences = AppearanceSurface;

export type AppearanceField = keyof AppearancePreferences;

/** What one row changes: usually one field, and the fields that move together
 *  when choosing one retires another (an included reading font clears an
 *  installed writing font). */
export type AppearanceChange = Partial<AppearancePreferences>;

export function appearanceChange<Field extends AppearanceField>(
  field: Field,
  value: AppearancePreferences[Field],
): AppearanceChange {
  return { [field]: value } as Pick<AppearancePreferences, Field>;
}

interface Choice<Value extends string> {
  readonly label: string;
  readonly value: Value;
}

/** Fields a segmented control can carry: a handful of string presets. */
export type PresetField =
  | 'theme'
  | 'uiScale'
  | 'readingTextSize'
  | 'lineSpacing'
  | 'lineWidth'
  | 'reduceMotion';

/** Parameterised by field so a row's choices cannot carry a value the field
 *  does not accept. */
interface PresetRowFor<Field extends PresetField> {
  readonly choices: readonly Choice<AppearancePreferences[Field]>[];
  readonly detail: string;
  readonly field: Field;
  readonly title: string;
}

export type PresetRow = { [Field in PresetField]: PresetRowFor<Field> }[PresetField];

/** Both scale rows, and the document's reading menu, offer the same three
 *  steps, so the steps are one vocabulary rather than a choice each row makes
 *  for itself. */
export const SCALE_CHOICES = [
  { label: 'Small', value: 'small' },
  { label: 'Default', value: 'default' },
  { label: 'Large', value: 'large' },
] as const;

type ReadingFont = AppearancePreferences['readingFont'];

/** The two reading fonts StashBase ships, shared by the Settings font picker
 *  and the document's own reading menu so both use the same names. */
export const READING_FONT_CHOICES: readonly {
  readonly fontFamily: string;
  readonly label: string;
  readonly value: ReadingFont;
}[] = [
  { fontFamily: 'var(--font-reading-serif)', label: 'Serif', value: 'serif' },
  { fontFamily: 'var(--font-reading-sans)', label: 'Sans', value: 'sans' },
];

export function isReadingFont(value: string): value is ReadingFont {
  return READING_FONT_CHOICES.some((choice) => choice.value === value);
}

/** Choosing an included reading font retires an installed writing font, or
 *  the choice would not show. */
export function readingFontChange(readingFont: ReadingFont): AppearanceChange {
  return { readingFont, writingFont: null };
}

/** Every segmented row, and the only list of their labels, so a panel holds
 *  no per-preference branch. */
export const PRESET_ROWS = {
  theme: {
    choices: [
      { label: 'Match system', value: 'system' },
      { label: 'Light', value: 'light' },
      { label: 'Dark', value: 'dark' },
    ],
    detail: 'Use the light or dark theme below, or match your system.',
    field: 'theme',
    title: 'Mode',
  },
  uiScale: {
    choices: SCALE_CHOICES,
    detail: 'Text size for menus, controls, and panels.',
    field: 'uiScale',
    title: 'Interface size',
  },
  reduceMotion: {
    choices: [
      { label: 'Match system', value: 'system' },
      { label: 'On', value: 'on' },
    ],
    detail: 'Settle animations and transitions instantly.',
    field: 'reduceMotion',
    title: 'Reduce motion',
  },
  readingTextSize: {
    choices: SCALE_CHOICES,
    detail: 'Text size in documents.',
    field: 'readingTextSize',
    title: 'Text size',
  },
  lineSpacing: {
    choices: [
      { label: 'Compact', value: 'compact' },
      { label: 'Default', value: 'default' },
      { label: 'Relaxed', value: 'relaxed' },
    ],
    detail: 'Space between lines of text.',
    field: 'lineSpacing',
    title: 'Line spacing',
  },
  lineWidth: {
    choices: [
      { label: 'Narrow', value: 'narrow' },
      { label: 'Default', value: 'default' },
      { label: 'Wide', value: 'wide' },
      { label: 'Full', value: 'full' },
    ],
    detail: 'How wide a line of text runs before it wraps.',
    field: 'lineWidth',
    title: 'Line width',
  },
} as const satisfies { [Field in PresetField]: PresetRowFor<Field> };

/** The DOM hands a radio's value back as a string; the row that listed the
 *  choices is what turns it into a typed change. */
export function presetChange(row: PresetRow, value: string): AppearanceChange | null {
  const choice = (row.choices as readonly Choice<string>[]).find(
    (candidate) => candidate.value === value,
  );
  return choice ? { [row.field]: choice.value } : null;
}

export const LIGHT_THEME_CHOICES = Object.entries(LIGHT_THEMES).map(([value, theme]) => ({
  label: theme.label,
  value,
}));

export const DARK_THEME_CHOICES = Object.entries(DARK_THEMES).map(([value, theme]) => ({
  label: theme.label,
  value,
}));

export function isLightTheme(value: string): value is AppearancePreferences['lightTheme'] {
  return Object.hasOwn(LIGHT_THEMES, value);
}

export function isDarkTheme(value: string): value is AppearancePreferences['darkTheme'] {
  return Object.hasOwn(DARK_THEMES, value);
}

/** A font installed on this computer, as the font picker lists it. */
export interface SystemFont {
  readonly family: string;
  readonly monospace: boolean;
}

/** A font StashBase ships, listed ahead of the installed ones so a choice that
 *  looks the same on every computer is always at hand. */
export interface IncludedFont {
  /** The CSS family list its sample is drawn in. */
  readonly fontFamily: string;
  readonly label: string;
  readonly value: string;
}

export const INCLUDED_CODE_FONTS: readonly IncludedFont[] = [
  { fontFamily: 'var(--font-mono)', label: 'Geist Mono', value: 'geist-mono' },
];

/** The toggles, in the order the Editor group lists them. */
export const EDITOR_TOGGLES = [
  {
    detail: 'Underline misspelled words and suggest corrections.',
    field: 'spellcheck',
    title: 'Check spelling',
  },
  {
    detail: 'Dim everything but the paragraph you are writing.',
    field: 'focusMode',
    title: 'Focus mode',
  },
  {
    detail: 'Keep the line you are typing in the middle of the window.',
    field: 'typewriterScrolling',
    title: 'Typewriter scrolling',
  },
  {
    detail: "Show the document's word count in the corner.",
    field: 'wordCount',
    title: 'Word count',
  },
] as const satisfies readonly {
  detail: string;
  field: 'spellcheck' | 'focusMode' | 'typewriterScrolling' | 'wordCount';
  title: string;
}[];

const languageNames =
  typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { languageDisplay: 'standard', type: 'language' })
    : null;

/** "English (United States)" for `en-US`; the code itself where the runtime
 *  cannot name it. */
export function spellcheckLanguageLabel(code: string): string {
  try {
    return languageNames?.of(code) ?? code;
  } catch {
    return code;
  }
}
