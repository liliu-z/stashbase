/**
 * Durable user preferences the server persists to `~/.stashbase/config.json`
 * and the renderer edits in Settings.
 *
 * Appearance lives with its wire schema in `protocols/http/appearance.ts`,
 * which is also its normalizer. Update preferences control automatic release
 * checks.
 */

export type { AppearancePreferencesWire as AppearancePreferences } from './protocols/http/appearance.ts';

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
