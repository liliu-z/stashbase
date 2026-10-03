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
  readonly readingTextSize: Scale;
  /** The included reading font; an installed `writingFont` overrides it. */
  readonly readingFont: 'serif' | 'sans';
  /** Null keeps the bundled default: Inter for writing, Geist Mono for code. */
  readonly writingFont: string | null;
  readonly codeFont: string | null;
  readonly lineSpacing: 'compact' | 'default' | 'relaxed';
  readonly lineWidth: 'narrow' | 'default' | 'wide' | 'full';
  readonly reduceMotion: 'system' | 'on';
  readonly spellcheck: boolean;
  /** Null follows the system language. */
  readonly spellcheckLanguage: string | null;
  readonly focusMode: boolean;
  readonly typewriterScrolling: boolean;
  readonly wordCount: boolean;
}
