/** Pure state for the composer's session-scope pill (the Cursor-style
 * scope picker). Kept free of React so default/lock/follow-window
 * semantics stay covered without a browser harness, mirroring
 * `modelState.ts`.
 *
 * Scope model: a chat is explicitly scoped either to one library folder
 * or to the whole library. A missing choice is NOT a scope — the
 * default resolves to the window's current folder when one exists, else
 * to the library.
 *
 * Semantics:
 * - A tab with no started session follows the window's current folder
 *   until the user explicitly picks a scope (a folder or "Library").
 * - Once the session has content (or is resumed), the binding is fixed:
 *   the pill keeps showing the scope the session connected with, and a
 *   later window-folder switch must not rebind it.
 * - A tab with unsent draft text or attachments freezes its scope at
 *   what the user saw instead of silently following the window.
 */

import { blankTabToReuse } from '@/store/lib/chatTabPlan';
import { folderScope, LIBRARY_SCOPE, type LibraryScope } from '@/common/lib/libraryScope';

/** The scope a NEW session would bind: the explicit pick, else the
 * window's current folder, else the whole library. An explicit folder
 * pick that has left library membership (folder removed) is ignored so
 * the picker cannot bind a dead folder. */
export function nextSessionScope(
  picked: LibraryScope | undefined,
  windowFolder: string,
  memberPaths: readonly string[],
): LibraryScope {
  if (picked?.kind === 'library') return LIBRARY_SCOPE;
  if (picked?.kind === 'folder' && memberPaths.includes(picked.path)) return picked;
  return windowFolder ? folderScope(windowFolder) : LIBRARY_SCOPE;
}

/** The scope a brand-new chat entry point (the sidebar's New Chat) binds:
 * the window's current folder when one exists, else the whole library. */
export function newChatScope(windowFolder: string): LibraryScope {
  return windowFolder ? folderScope(windowFolder) : LIBRARY_SCOPE;
}

/** The scope the pill displays: the live session's binding once one is
 * connected, else the scope the next session would use. */
export function chatScopePill(options: {
  connectedScope: LibraryScope | null;
  picked: LibraryScope | undefined;
  windowFolder: string;
  memberPaths: readonly string[];
}): LibraryScope {
  return options.connectedScope
    ?? nextSessionScope(options.picked, options.windowFolder, options.memberPaths);
}

/** True when `scope` is exactly what an unpicked tab would resolve to for
 * this window folder — i.e. there is nothing to follow or freeze. */
function scopeIsWindowDefault(scope: LibraryScope, windowFolder: string): boolean {
  return windowFolder
    ? scope.kind === 'folder' && scope.path === windowFolder
    : scope.kind === 'library';
}

export type WindowFolderSwitchPlan = 'follow' | 'freeze' | 'keep';

/** What an existing tab does when the window's folder changes.
 *
 * - `'follow'` — an unbound, completely idle tab reconnects its next
 *   (still empty) session to the new window default.
 * - `'freeze'` — the tab would follow, but it holds unsent draft text or
 *   attachments: promote its connected scope to an explicit pick so the
 *   draft keeps the scope the user saw. Never reconnect.
 * - `'keep'` — everything else: content, a running turn, an explicit
 *   pick, or a resumed session keeps its binding untouched.
 */
export function windowFolderSwitchPlan(options: {
  connectedScope: LibraryScope | null;
  picked: LibraryScope | undefined;
  resumedSession: boolean;
  hasContent: boolean;
  turnActive: boolean;
  hasDraft: boolean;
  windowFolder: string;
}): WindowFolderSwitchPlan {
  const unbound = Boolean(options.windowFolder)
    && !options.picked
    && !options.resumedSession
    && !options.hasContent
    && !options.turnActive
    && options.connectedScope != null
    && !scopeIsWindowDefault(options.connectedScope, options.windowFolder);
  if (!unbound) return 'keep';
  return options.hasDraft ? 'freeze' : 'follow';
}

/** True when an unbound, still-empty, draft-free tab should follow a
 * window-folder switch by reconnecting its next session. */
export function shouldFollowWindowFolder(options: {
  connectedScope: LibraryScope | null;
  picked: LibraryScope | undefined;
  resumedSession: boolean;
  hasContent: boolean;
  turnActive: boolean;
  hasDraft: boolean;
  windowFolder: string;
}): boolean {
  return windowFolderSwitchPlan(options) === 'follow';
}

/** Whether a chat tab is COMPLETELY blank — reusable as the welcome tab
 * for a new scope. Blank requires: no transcript, no active turn, not
 * resumed, no picked scope override, no draft text, and no attachments.
 * A tab with any of those is user work and must never be rebound. */
export function isBlankChatTab(options: {
  hasContent: boolean;
  turnActive: boolean;
  resumedSession: boolean;
  picked: LibraryScope | undefined;
  hasDraftText: boolean;
  attachmentCount: number;
}): boolean {
  return !options.hasContent
    && !options.turnActive
    && !options.resumedSession
    && !options.picked
    && !options.hasDraftText
    && options.attachmentCount === 0;
}

/** Whether a newly entered window scope needs its one blank Chat entry.
 * Kept separate from Agent readiness: opening this surface must not install
 * a runtime until the user explicitly presses New Chat. */
export function shouldOpenInitialChatOnWindowEntry(
  booted: boolean,
  windowFolder: string,
  chatTabCount: number,
  previousWindowFolder: string | null,
): boolean {
  return chatTabCount === 0
    && previousWindowFolder !== windowFolder
    && (booted || Boolean(windowFolder));
}

/** What the chat panel does when the WINDOW's folder switches:
 * - the ACTIVE tab is already bound to the new folder → nothing. The
 *   conversation the user is looking at IS the working entry for that
 *   folder (create_project auto-select, or clicking back to a chat's own
 *   folder) — spawning a welcome tab over it would be hostile.
 * - a completely blank tab exists → activate it (it follows the window
 *   default on its next connect).
 * - otherwise → create a fresh welcome tab.
 */
export type SwitchWelcomeTabPlan =
  | { kind: 'none' }
  | { kind: 'activate'; id: string }
  | { kind: 'new' };

export function switchWelcomeTabPlan(
  tabs: readonly { id: string; agent: string; blank?: boolean; boundFolder?: string | null }[],
  activeTabId: string | null,
  newFolderPath: string,
  preferredAgent: string,
): SwitchWelcomeTabPlan {
  const active = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : undefined;
  if (active && active.boundFolder === newFolderPath) return { kind: 'none' };
  const reuse = blankTabToReuse(tabs, preferredAgent);
  if (reuse) return { kind: 'activate', id: reuse };
  return { kind: 'new' };
}

/** The file listing that feeds `@` mentions and folder-file attachment
 * validation for a scope:
 * - folder scope → an explicit, server-filtered folder listing;
 * - library scope → mentions disabled (no single folder listing exists).
 */
export type MentionListingPlan =
  | { kind: 'folder'; root: string }
  | { kind: 'disabled' };

export function mentionListingPlan(scope: LibraryScope): MentionListingPlan {
  if (scope.kind === 'library') return { kind: 'disabled' };
  return { kind: 'folder', root: scope.path };
}

/** Locked exactly like the model menu — a transcript (including a resumed
 * one) or an active turn means the conversation is bound to its scope. */
export function folderMenuLocked(hasTranscript: boolean, turnActive: boolean, resumedSession: boolean): boolean {
  return hasTranscript || turnActive || resumedSession;
}
