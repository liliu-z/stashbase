import type { DarkThemeId, LightThemeId } from '@/contracts/appearance-themes';

type Scale = 'small' | 'default' | 'large';

/** What a window applies: the whole saved appearance, stamped on its document
 *  root as a theme class, token overrides, font variables, and data
 *  attributes the stylesheet and the editor read. */
export interface AppearanceSurface {
  readonly theme: 'system' | 'light' | 'dark';
  readonly lightTheme: LightThemeId;
  readonly darkTheme: DarkThemeId;
  readonly uiScale: Scale;
  /** A step from 1 to 7; 3 is the reading font's own size. */
  readonly readingTextSize: number;
  /** Serif or Sans, which StashBase ships, or the custom `writingFont`. */
  readonly readingFont: 'serif' | 'sans' | 'custom';
  /** The custom font's installed family, kept while another font is in
   *  use; null until the reader chooses one. */
  readonly writingFont: string | null;
  readonly codeFont: string | null;
  readonly lineSpacing: 'compact' | 'default' | 'relaxed';
  readonly lineWidth: 'narrow' | 'default' | 'wide' | 'full';
  /** Behind Markdown prose; grain shows on a light page only. */
  readonly pageTexture: 'none' | 'dots' | 'grain';
  readonly reduceMotion: 'system' | 'on';
  readonly spellcheck: boolean;
  /** Null follows the system language. */
  readonly spellcheckLanguage: string | null;
  readonly focusMode: boolean;
  readonly typewriterScrolling: boolean;
  readonly wordCount: boolean;
}
