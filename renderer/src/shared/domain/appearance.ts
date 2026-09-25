/** The CSS-facing shape of the appearance preferences: what a window
 *  stamps on its document root, with no wire or feature vocabulary attached. */
export interface AppearanceSurface {
  /** null follows the operating system. */
  readonly themeClass: 'light' | 'dark' | null;
  readonly uiScale: 'small' | 'default' | 'large';
  readonly readingTextSize: 'small' | 'default' | 'large';
  readonly readingFont: 'serif' | 'sans';
}
