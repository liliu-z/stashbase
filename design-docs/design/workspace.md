# Workspace

## User Outcome

People work directly in ordinary local folders, moving between files, Chat,
and windows without adopting a StashBase-specific storage model.

## Scope and Non-goals

This area owns library membership, folder navigation, the Files sidebar,
tabs, window behavior, and explicit source-file operations. Together with the
Documents area, it forms the Document Workbench. It does not own format
rendering, preparation correctness, retrieval ranking, or Agent session
protocols.

StashBase is not a database-first knowledge base, a block editor, a project
manager, or a primary graph-navigation tool.

## Current Experience

- A new window opens directly into the workspace with no folder selected and
  one expanded, reusable blank library Chat. It never silently restores a
  folder or installs an Agent runtime.
- On first launch with a brand-new empty default folder home, StashBase seeds
  the ordinary local **👋 Start Here** folder and adds it to the library
  without automatically opening it. An existing folder home is never modified,
  and deleting the seeded folder does not recreate it.
- Files exposes Chat, the active folder tree, and account utilities without
  making sign-in a condition of local work. With no active folder, the
  workspace distinguishes an empty library from an existing library awaiting
  selection.
- Packaged builds check the official stable release channel when the default-on
  preference permits it. An available update replaces the secondary Discord
  and bug-report shortcuts beside the account control with one compact Update
  action; Settings remains visible as the recovery and preference surface, and
  native **Help → Report a Bug…** preserves deliberate report entry.
- Users can open or create a local folder, switch folders in place, favorite a
  member, open it in another window, sync it, or remove it from the library.
  A created folder is an ordinary directory. Removing membership clears only
  StashBase-owned state.
- The titlebar folder switcher keeps the window's current folder identity
  visible and offers the full library membership. Folder-level actions remain
  attributable to the active folder.
- Multiple windows share one library and runtime services while retaining
  independent active folders, tabs, search presentation, and Chat tabs.
- Folder switches reset folder-scoped documents but preserve library search
  state and scope-pinned chats. A blank welcome chat may follow the new folder;
  started work and unsent drafts never silently rebind.
- Files declared previewable in the
  [Documents format matrix](documents.md#format-capability-matrix) open in
  persistent tabs with Quick Open, Command Palette, history, and
  platform-appropriate shortcuts.
- Search or Agent links to a file in another member folder open a read-only
  out-of-folder tab without switching the current folder. The user can open
  that folder in another window for full editing.
- File create, rename, move, import, and delete are explicit. Destructive
  operations confirm intent. Agent instruction files remain visible and
  user-owned; hidden tool infrastructure and derived data do not surface as
  workspace content.
- Durable folder purpose, organization guidance, and Agent working rules live
  in the visible, user-owned `AGENTS.md`, not separate Library metadata.
- Current folder entry makes one create-only exception to explicit mutation:
  it seeds `AGENTS.md` when missing. This accepted Shipping behavior is tracked
  as an invasive-design
  [Known Gap](../../code-review/file-transactions.md#known-gap--instruction-seeding-on-folder-entry),
  not as precedent for other automatic source writes.

## Experience Contract

- Folder entry is navigation first; listing, preparation, and indexing continue
  in the background.
- Closing a window either makes its live edit durable or leaves the window open
  with an actionable failure. Closing one window never tears down another.
- Folder removal never deletes user files. Every affected window saves first,
  leaves the removed folder, and cannot silently re-add it during recovery.
  StashBase commits membership removal only after preparation, derived data,
  index rows, ordering, and folder-bound runtime state have finished cleanup.
- Folder membership and favorites never replace unreadable settings with
  fallback defaults. A durable library change fails instead, preserving the
  user's existing configuration for recovery.
- Source and derived state remain distinguishable. The tree and tabs show
  source files, not generated representations.
- Chat visibility is explicit after initialization. Closing the last document
  expands an open Chat; hiding Chat stays respected until the user reopens it.
- Keyboard focus, overlay dismissal, splitters, and reduced-motion behavior are
  consistent across supported platforms.
- Quick Open stays active-folder navigation. Command Palette exposes existing
  safe actions; neither surface becomes search, Agent permission, or hidden
  destructive automation.
- Update discovery is quiet and never blocks local work. One explicit Update
  action consents to download, installation, and relaunch; every open renderer
  crosses the normal save barrier before an installer may retire the
  application. Linux package installs may also require system administrator
  approval.

## Cross-area Seams

- [Documents](documents.md) owns the surface inside a source tab.
- [Preparation](preparation.md) owns background derivation and readiness.
- [Search](search.md) owns cross-library evidence and out-of-folder result
  behavior.
- [Agent Panel](agent-panel.md) owns Chat tabs and scope-pinned sessions.
- Window retirement and file mutation details live in
  [Window Lifecycle](../../code-review/window-lifecycle.md) and
  [File Transactions](../../code-review/file-transactions.md).

## Contribution Direction

### Next

- Clarify loading, empty, and operation-failure states.
- Improve tree and tab behavior for large folders.
- Improve creation, rename, move, import, and attachment workflows.

### Coordinate First

- Folder membership, filesystem safety, deletion, or Agent file permissions.
- What appears in the tree or what a result opens.
- New workspace, synchronization, or storage models.

### Not Planned

- Requiring files to be copied into a managed workspace.
- Database-first or block-first source ownership.
- A graph view as the primary navigation surface.

## Related Journeys and Contracts

Journeys: [J01](../user-journeys.md#j01-complete-onboarding-and-reach-first-value),
[J02](../user-journeys.md#j02-add-and-open-a-folder), and
[J03](../user-journeys.md#j03-read-and-edit-source-documents). The core loop is
[J10](../user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work).
Cross-area
routes also include [J05](../user-journeys.md#j05-search-and-open-source-evidence)
and [J08](../user-journeys.md#j08-connect-an-external-agent-through-mcp).
Chat-first project entry is
[J11](../user-journeys.md#j11-turn-a-conversation-into-a-project).

Contracts: [Architecture](../../code-review/architecture.md),
[Renderer Workspace](../../code-review/renderer-workspace.md),
[Window Lifecycle](../../code-review/window-lifecycle.md),
[File Transactions](../../code-review/file-transactions.md),
[Data Lifecycle](../../code-review/data-lifecycle.md), and
[Settings and Config](../../code-review/settings-config.md).
