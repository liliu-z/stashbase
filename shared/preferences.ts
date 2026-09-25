/**
 * Durable user preferences the server persists to `~/.stashbase/config.json`
 * and the renderer edits in Settings.
 *
 * Appearance is deliberately a small set of presets rather than free-form
 * customization: the renderer applies each value as a document-level class,
 * so an unbounded value would have no styling to select. Update preferences
 * control automatic release checks.
 */

export type AppearanceTheme = 'system' | 'light' | 'dark';

export type AppearanceScale = 'small' | 'default' | 'large';

/** The face of Markdown prose: a serif for writing, or the interface sans
 *  for documents that are mostly code. */
export type ReadingFont = 'serif' | 'sans';

export interface AppearancePreferences {
  theme: AppearanceTheme;
  uiScale: AppearanceScale;
  readingTextSize: AppearanceScale;
  readingFont: ReadingFont;
}

export interface WorkspacePreferences {
  /** Include eligible user-owned hidden dot-directories (`.github`,
   *  `.vscode`, …) in the Files tree and Quick Open. A Workbench visibility
   *  preference only: it never widens indexing, Search, Chat context, or
   *  Agent/MCP discovery, and VCS databases plus StashBase-derived state
   *  stay hidden regardless. Missing or invalid values recover to `false`. */
  showHiddenFiles: boolean;
}

export interface UpdatePreferences {
  /** Check the official desktop release channel after launch and periodically. */
  autoCheck: boolean;
}
