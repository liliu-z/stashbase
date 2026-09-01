/**
 * Durable user preferences the server persists to `~/.stashbase/config.json`
 * and the renderer edits in Settings.
 *
 * Appearance is deliberately a small set of presets rather than free-form
 * customization: the renderer applies each value as a document-level class,
 * so an unbounded value would have no styling to select. Capture and update
 * preferences are opt-in switches for behavior that would otherwise act on
 * the user's data or network without being asked. Onboarding records which
 * one-time notices a user has already seen, versioned so a later revision of
 * a notice can show again without reusing a dismissed flag.
 */

export type AppearanceTheme = 'system' | 'light' | 'dark';

export type AppearanceScale = 'small' | 'default' | 'large';

export interface AppearancePreferences {
  theme: AppearanceTheme;
  uiScale: AppearanceScale;
  readingTextSize: AppearanceScale;
}

export interface CapturePreferences {
  /** Offer focused-window clipboard images for explicit library import. */
  clipboardImageImport: boolean;
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

export interface OnboardingPreferences {
  sourceCodeNoticeVersion?: number;
}
