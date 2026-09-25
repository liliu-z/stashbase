import type { AppearanceSurface } from '@/shared/domain/appearance';

type AppearanceTheme = 'system' | 'light' | 'dark';
type AppearanceScale = 'small' | 'default' | 'large';
type ReadingFont = 'serif' | 'sans';

export interface AppearancePreferences {
  readonly theme: AppearanceTheme;
  readonly uiScale: AppearanceScale;
  readonly readingTextSize: AppearanceScale;
  readonly readingFont: ReadingFont;
}

export type AppearanceField = keyof AppearancePreferences;

/** One field at a time, so one row's change is one field on the wire. */
export type AppearanceChange =
  | { readonly theme: AppearanceTheme }
  | { readonly uiScale: AppearanceScale }
  | { readonly readingTextSize: AppearanceScale }
  | { readonly readingFont: ReadingFont };

/** Both scale rows, and the document's reading menu, offer the same three
 *  steps, so the steps are one vocabulary rather than a choice each row makes
 *  for itself. */
export const SCALE_CHOICES: readonly { readonly label: string; readonly value: AppearanceScale }[] =
  [
    { label: 'Small', value: 'small' },
    { label: 'Default', value: 'default' },
    { label: 'Large', value: 'large' },
  ];

/** Shared by the Appearance row and the document's own reading-font menu, so
 *  both offer the same presets under the same names. */
export const READING_FONT_CHOICES: readonly {
  readonly label: string;
  readonly value: ReadingFont;
}[] = [
  { label: 'Serif', value: 'serif' },
  { label: 'Sans', value: 'sans' },
];

/** Parameterised by field so a row's choices cannot carry a value the field
 *  does not accept. */
interface AppearanceRowFor<Field extends AppearanceField> {
  readonly choices: readonly {
    readonly label: string;
    readonly value: AppearancePreferences[Field];
  }[];
  readonly detail: string;
  readonly field: Field;
  readonly title: string;
}

export type AppearanceRow =
  | AppearanceRowFor<'theme'>
  | AppearanceRowFor<'uiScale'>
  | AppearanceRowFor<'readingTextSize'>
  | AppearanceRowFor<'readingFont'>;

/** This one table drives every row and is the only list of labels, so a
 *  panel holds no per-preference branch. */
export const APPEARANCE_ROWS: readonly AppearanceRow[] = [
  {
    choices: [
      { label: 'Match system', value: 'system' },
      { label: 'Light', value: 'light' },
      { label: 'Dark', value: 'dark' },
    ],
    detail: 'Use a light or dark theme, or match your system.',
    field: 'theme',
    title: 'Theme',
  },
  {
    choices: SCALE_CHOICES,
    detail: 'Text size for menus, controls, and code editors.',
    field: 'uiScale',
    title: 'Interface size',
  },
  {
    choices: SCALE_CHOICES,
    detail: 'Text size for reading and editing Markdown.',
    field: 'readingTextSize',
    title: 'Reading text size',
  },
  {
    choices: READING_FONT_CHOICES,
    detail: 'Serif suits prose; Sans suits documents full of code.',
    field: 'readingFont',
    title: 'Reading font',
  },
];

function chosen<Field extends AppearanceField>(
  row: AppearanceRowFor<Field>,
  value: string,
  change: (value: AppearancePreferences[Field]) => AppearanceChange,
): AppearanceChange | null {
  const choice = row.choices.find((candidate) => candidate.value === value);
  return choice ? change(choice.value) : null;
}

/** The DOM returns a radio's value as a string, so the table that names a
 *  field's choices is also what turns one back into a typed change. */
export function appearanceChange(field: AppearanceField, value: string): AppearanceChange | null {
  const row = APPEARANCE_ROWS.find((candidate) => candidate.field === field);
  if (!row) return null;
  switch (row.field) {
    case 'theme':
      return chosen(row, value, (theme) => ({ theme }));
    case 'uiScale':
      return chosen(row, value, (uiScale) => ({ uiScale }));
    case 'readingTextSize':
      return chosen(row, value, (readingTextSize) => ({ readingTextSize }));
    case 'readingFont':
      return chosen(row, value, (readingFont) => ({ readingFont }));
  }
}

export function appearanceSurface(preferences: AppearancePreferences): AppearanceSurface {
  return {
    themeClass: preferences.theme === 'system' ? null : preferences.theme,
    uiScale: preferences.uiScale,
    readingTextSize: preferences.readingTextSize,
    readingFont: preferences.readingFont,
  };
}
