/**
 * The color themes StashBase offers: each is a published palette from its
 * own project, never one StashBase composed. A theme names the handful of
 * roles every palette publishes (the page ground, a raised surface, an
 * overlay, text, subdued text, an accent, and red/green/yellow), and one
 * mapping turns those roles into the renderer's semantic tokens. The mapping
 * derives in-between steps by mixing a palette's own colors and never
 * introduces a hue the palette does not have.
 *
 * The two StashBase themes have no palette here: they are the hand-tuned
 * defaults in `renderer/src/globals.css`, which every other theme overrides.
 *
 * Sources, all MIT-licensed:
 * - Catppuccin: https://github.com/catppuccin/palette
 * - Tokyo Night: https://github.com/folke/tokyonight.nvim
 * - Rosé Pine: https://github.com/rose-pine/palette
 * - Gruvbox: https://github.com/morhetz/gruvbox
 * - Nord: https://github.com/nordtheme/nord
 */

type ThemeMode = 'light' | 'dark';

interface ThemePalette {
  /** The page ground: the canvas behind everything else. */
  readonly ground: string;
  /** Cards, popovers, and the other surfaces lifted off the ground. */
  readonly raised: string;
  /** The palette's overlay or highlight step: hover fills and the top of the
   *  surface ladder. */
  readonly overlay: string;
  readonly text: string;
  readonly subtext: string;
  /** Focus rings, switches, selection tint, links. */
  readonly accent: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
}

interface ThemeDefinition {
  readonly family: string;
  readonly label: string;
  readonly mode: ThemeMode;
  /** Null for the StashBase defaults, which the stylesheet owns. */
  readonly palette: ThemePalette | null;
}

const STASHBASE_BACKGROUND = { dark: '#171717', light: '#fafafa' } as const;

export const LIGHT_THEMES = {
  'stashbase-light': { family: 'StashBase', label: 'StashBase Light', mode: 'light', palette: null },
  'catppuccin-latte': {
    family: 'Catppuccin',
    label: 'Catppuccin Latte',
    mode: 'light',
    palette: {
      ground: '#e6e9ef',
      raised: '#eff1f5',
      overlay: '#ccd0da',
      text: '#4c4f69',
      subtext: '#5c5f77',
      accent: '#1e66f5',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
    },
  },
  'tokyo-night-day': {
    family: 'Tokyo Night',
    label: 'Tokyo Night Day',
    mode: 'light',
    palette: {
      ground: '#e1e2e7',
      raised: '#e9e9ed',
      overlay: '#c4c8da',
      text: '#3760bf',
      subtext: '#6172b0',
      accent: '#2e7de9',
      red: '#f52a65',
      green: '#587539',
      yellow: '#8c6c3e',
    },
  },
  'rose-pine-dawn': {
    family: 'Rosé Pine',
    label: 'Rosé Pine Dawn',
    mode: 'light',
    palette: {
      ground: '#faf4ed',
      raised: '#fffaf3',
      overlay: '#dfdad9',
      text: '#575279',
      subtext: '#797593',
      accent: '#286983',
      red: '#b4637a',
      green: '#56949f',
      yellow: '#ea9d34',
    },
  },
  'gruvbox-light': {
    family: 'Gruvbox',
    label: 'Gruvbox Light',
    mode: 'light',
    palette: {
      ground: '#fbf1c7',
      raised: '#f9f5d7',
      overlay: '#d5c4a1',
      text: '#3c3836',
      subtext: '#7c6f64',
      accent: '#076678',
      red: '#9d0006',
      green: '#79740e',
      yellow: '#b57614',
    },
  },
} as const satisfies Record<string, ThemeDefinition>;

export const DARK_THEMES = {
  'stashbase-dark': { family: 'StashBase', label: 'StashBase Dark', mode: 'dark', palette: null },
  'catppuccin-frappe': {
    family: 'Catppuccin',
    label: 'Catppuccin Frappé',
    mode: 'dark',
    palette: {
      ground: '#303446',
      raised: '#414559',
      overlay: '#626880',
      text: '#c6d0f5',
      subtext: '#a5adce',
      accent: '#8caaee',
      red: '#e78284',
      green: '#a6d189',
      yellow: '#e5c890',
    },
  },
  'catppuccin-macchiato': {
    family: 'Catppuccin',
    label: 'Catppuccin Macchiato',
    mode: 'dark',
    palette: {
      ground: '#24273a',
      raised: '#363a4f',
      overlay: '#5b6078',
      text: '#cad3f5',
      subtext: '#a5adcb',
      accent: '#8aadf4',
      red: '#ed8796',
      green: '#a6da95',
      yellow: '#eed49f',
    },
  },
  'catppuccin-mocha': {
    family: 'Catppuccin',
    label: 'Catppuccin Mocha',
    mode: 'dark',
    palette: {
      ground: '#1e1e2e',
      raised: '#313244',
      overlay: '#585b70',
      text: '#cdd6f4',
      subtext: '#a6adc8',
      accent: '#89b4fa',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
    },
  },
  'tokyo-night': {
    family: 'Tokyo Night',
    label: 'Tokyo Night',
    mode: 'dark',
    palette: {
      ground: '#1a1b26',
      raised: '#292e42',
      overlay: '#414868',
      text: '#c0caf5',
      subtext: '#a9b1d6',
      accent: '#7aa2f7',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
    },
  },
  'tokyo-night-storm': {
    family: 'Tokyo Night',
    label: 'Tokyo Night Storm',
    mode: 'dark',
    palette: {
      ground: '#24283b',
      raised: '#292e42',
      overlay: '#414868',
      text: '#c0caf5',
      subtext: '#a9b1d6',
      accent: '#7aa2f7',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
    },
  },
  'tokyo-night-moon': {
    family: 'Tokyo Night',
    label: 'Tokyo Night Moon',
    mode: 'dark',
    palette: {
      ground: '#222436',
      raised: '#2f334d',
      overlay: '#444a73',
      text: '#c8d3f5',
      subtext: '#828bb8',
      accent: '#82aaff',
      red: '#ff757f',
      green: '#c3e88d',
      yellow: '#ffc777',
    },
  },
  'rose-pine': {
    family: 'Rosé Pine',
    label: 'Rosé Pine',
    mode: 'dark',
    palette: {
      ground: '#191724',
      raised: '#1f1d2e',
      overlay: '#403d52',
      text: '#e0def4',
      subtext: '#908caa',
      accent: '#c4a7e7',
      red: '#eb6f92',
      green: '#9ccfd8',
      yellow: '#f6c177',
    },
  },
  'rose-pine-moon': {
    family: 'Rosé Pine',
    label: 'Rosé Pine Moon',
    mode: 'dark',
    palette: {
      ground: '#232136',
      raised: '#2a273f',
      overlay: '#44415a',
      text: '#e0def4',
      subtext: '#908caa',
      accent: '#c4a7e7',
      red: '#eb6f92',
      green: '#9ccfd8',
      yellow: '#f6c177',
    },
  },
  'gruvbox-dark': {
    family: 'Gruvbox',
    label: 'Gruvbox Dark',
    mode: 'dark',
    palette: {
      ground: '#282828',
      raised: '#3c3836',
      overlay: '#504945',
      text: '#ebdbb2',
      subtext: '#a89984',
      accent: '#83a598',
      red: '#fb4934',
      green: '#b8bb26',
      yellow: '#fabd2f',
    },
  },
  nord: {
    family: 'Nord',
    label: 'Nord',
    mode: 'dark',
    palette: {
      ground: '#2e3440',
      raised: '#3b4252',
      overlay: '#4c566a',
      text: '#eceff4',
      subtext: '#d8dee9',
      accent: '#88c0d0',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
    },
  },
} as const satisfies Record<string, ThemeDefinition>;

export type LightThemeId = keyof typeof LIGHT_THEMES;
export type DarkThemeId = keyof typeof DARK_THEMES;

export const LIGHT_THEME_IDS = Object.keys(LIGHT_THEMES) as [LightThemeId, ...LightThemeId[]];
export const DARK_THEME_IDS = Object.keys(DARK_THEMES) as [DarkThemeId, ...DarkThemeId[]];

/** The semantic tokens a theme sets, named as in `globals.css` without the
 *  leading dashes. A theme writes each as `--light-<token>` or
 *  `--dark-<token>`, and the stylesheet's `light-dark()` picks the side. */
export const THEME_TOKENS = [
  'surface-1',
  'surface-2',
  'surface-3',
  'surface-4',
  'surface-5',
  'surface-6',
  'surface-7',
  'surface-8',
  'foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'selected',
  'destructive',
  'destructive-light',
  'decision',
  'diff-add',
  'diff-remove',
  'focus-ring',
  'control-on',
  'control-on-hover',
  'code-chip',
  'prose-accent',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** `amount` of `to` over `from`, in sRGB: 0 is `from`, 1 is `to`. */
export function mixHex(from: string, to: string, amount: number): string {
  const [ar, ag, ab] = parseHex(from);
  const [br, bg, bb] = parseHex(to);
  return toHex([ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount]);
}

function luminance(hex: string): number {
  const channels = parseHex(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG 2 contrast ratio between two opaque colors. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** Text readable on every ground it sits on. Body copy reaches AA (4.5:1);
 *  a palette color that falls short is moved toward black (light themes) or
 *  white (dark themes) until it does, which keeps its hue distinct from the
 *  body text instead of collapsing into it. */
const READABLE = 4.5;

function readableOn(color: string, toward: string, grounds: readonly string[]): string {
  for (let step = 0; step <= 20; step += 1) {
    const candidate = mixHex(color, toward, step / 20);
    if (grounds.every((ground) => contrastRatio(candidate, ground) >= READABLE)) return candidate;
  }
  return toward;
}

export function themePaletteTokens(
  palette: ThemePalette,
  mode: ThemeMode,
): Record<ThemeToken, string> {
  const { ground, raised, overlay } = palette;
  const surfaces =
    mode === 'light'
      ? // Light themes keep the StashBase recipe: a floor, one step toward the
        // raised color, then flat raised surfaces whose shadows do the work.
        [ground, mixHex(ground, raised, 0.5), raised, raised, raised, raised, raised, raised]
      : [
          ground,
          mixHex(ground, raised, 0.5),
          raised,
          mixHex(raised, overlay, 0.25),
          mixHex(raised, overlay, 0.5),
          mixHex(raised, overlay, 0.75),
          overlay,
          mixHex(overlay, palette.text, 0.08),
        ];
  const muted = mode === 'light' ? mixHex(ground, overlay, 0.35) : surfaces[1]!;
  const grounds = [surfaces[0]!, surfaces[1]!, surfaces[2]!, muted];
  const extreme = mode === 'light' ? '#000000' : '#ffffff';
  const foreground = readableOn(palette.text, extreme, grounds);
  return {
    'surface-1': surfaces[0]!,
    'surface-2': surfaces[1]!,
    'surface-3': surfaces[2]!,
    'surface-4': surfaces[3]!,
    'surface-5': surfaces[4]!,
    'surface-6': surfaces[5]!,
    'surface-7': surfaces[6]!,
    'surface-8': surfaces[7]!,
    foreground,
    muted,
    'muted-foreground': readableOn(palette.subtext, extreme, grounds),
    accent: mode === 'light' ? mixHex(raised, overlay, 0.6) : overlay,
    'accent-foreground': foreground,
    selected: mixHex(ground, palette.accent, mode === 'light' ? 0.22 : 0.32),
    destructive: palette.red,
    'destructive-light': mixHex(ground, palette.red, 0.14),
    decision: palette.yellow,
    'diff-add': palette.green,
    'diff-remove': palette.red,
    'focus-ring': palette.accent,
    'control-on': palette.accent,
    'control-on-hover': mixHex(palette.accent, foreground, 0.15),
    'code-chip': mode === 'light' ? mixHex(ground, overlay, 0.5) : surfaces[3]!,
    'prose-accent': readableOn(palette.accent, extreme, grounds),
  };
}

export function lightThemeTokens(id: LightThemeId): Record<ThemeToken, string> | null {
  const { palette } = LIGHT_THEMES[id];
  return palette ? themePaletteTokens(palette, 'light') : null;
}

export function darkThemeTokens(id: DarkThemeId): Record<ThemeToken, string> | null {
  const { palette } = DARK_THEMES[id];
  return palette ? themePaletteTokens(palette, 'dark') : null;
}

/** The ground a window paints before its page does, per side. */
export function themeBackgrounds(
  light: LightThemeId,
  dark: DarkThemeId,
): { readonly light: string; readonly dark: string } {
  return {
    light: LIGHT_THEMES[light].palette?.ground ?? STASHBASE_BACKGROUND.light,
    dark: DARK_THEMES[dark].palette?.ground ?? STASHBASE_BACKGROUND.dark,
  };
}
