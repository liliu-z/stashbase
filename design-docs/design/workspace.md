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
  folder, installs an Agent runtime, or opens account sign-in or setup for
  search by meaning.
- On first launch with a brand-new empty default folder home, StashBase seeds
  the ordinary local **👋 Start Here** folder and adds it to the library
  without automatically opening it. Its `00 Welcome.html` is the human entry;
  the remaining guides use a stable numbered order while the Agent-discovery
  file remains `AGENTS.md`. Detailed user-owned Markdown makes grounded
  product, workflow, capability, comparison, and recovery context available to
  Library-scoped Agent retrieval. An existing folder home is never modified,
  deleting the seeded folder does not recreate it, and application updates
  never overwrite the user's copy.
- Files exposes Chat, the active folder tree, and account utilities without
  making sign-in a condition of local work. A bare window boots with the
  Templates gallery open in the main pane — the product leads with what it
  does, cards disabled until a folder opens — while the SIDEBAR's launcher
  column owns getting one open with the fewest rows that can: Open Folder…
  and New Folder… as quiet command rows (the same flows the titlebar
  switcher menu serves). The launcher deliberately lists no membership, no
  scope explainer, and no GitHub import row — browsing members and the
  import flow belong to the titlebar Library switcher. Closing the
  boot-opened gallery tab sticks; boot never reopens it over restored tabs
  or an open folder.
- Packaged builds check the official stable release channel when the default-on
  preference permits it. An available update floats a dismissible announcement
  above the account row with one explicit Update action; the Settings utility
  keeps its place beneath it (Discord and bug reporting live inside Settings →
  General, under Community and support). Dismissing
  hides that announcement only — a newer release, or a download becoming ready
  to install, announces again, and Settings remains the standing update and
  preference surface.
- A signed-in account is recognizable by its Google display name and avatar in
  Files, with the full email retained in the account menu. Missing or failed
  profile display data falls back without changing account controls; **Sign
  in** names the complete signed-out local-workspace state and its optional
  route to Wiki Agent and search by meaning.
- Users can open or create a local folder, import a public GitHub repository
  directly into the default folder home, switch folders in place, favorite a
  member, open it in another window, sync it, or remove it from the library.
  A created folder or imported repository is an ordinary directory. Removing
  membership clears only StashBase-owned state.
- The titlebar folder switcher keeps the window's current folder identity
  visible and offers the full library membership alongside pinned "New Folder…",
  "Import from GitHub…", and "Open Folder…" actions. The sidebar's active
  folder header offers **Change Folder…** at the top of its ⋯ menu, opening
  that same membership menu — with a folder open, the sidebar is where
  people look for "switch", and the titlebar trigger alone proved
  undiscoverable; a standing icon beside the name crowded it. A name wider than the
  sidebar column truncates within that column instead of crossing onto the
  document tab strip. Folder-level actions remain attributable to the active
  folder.
- The document tab strip can also hold the singleton **Templates** tab — the
  gallery of preset wiki activations, opened from its sidebar row under New
  Chat. It closes like any tab; reopening focuses the existing one, and
  opening a file while it is active lands in a fresh tab, never inside it.
- Multiple windows share one library and runtime services while retaining
  independent active folders, tabs, search presentation, and Chat tabs.
- Folder switches reset folder-scoped documents but preserve library search
  state and scope-pinned chats. A blank welcome chat may follow the new folder;
  started work, unsent drafts, and a pending Build Wiki intent never silently
  rebind.
- Removing a member preserves Chat tabs. A completely blank Chat returns to
  Library without interruption; a Chat containing user work stays readable in
  its retired folder scope and offers a separate **New Library Chat**.
- The active folder tree truthfully reports ordinary source entries rather
  than filtering unknown formats. Generic files are muted with one stable
  explanation—Search and automatic Chat context do not consume them—and still
  open through Quick Open or their tree row. Ordinary user dotfiles remain
  visible, while dot-notes retain the established hidden-note namespace;
  exact app-derived artifacts, bundle resources, junk metadata, and
  dot-directories remain infrastructure rather than workspace content by
  default.
- The Files panel menu offers a checkable **Show Hidden Files** action. It is
  an application-level preference: every window applies the same durable
  value, and a missing or invalid stored value recovers to the safe default
  view. When enabled, eligible user-owned dot-directories such as `.github`
  and `.vscode` and their descendants join the tree and Quick Open with
  normal capability, distinguished by a subtle italic rather than a disabled
  style. VCS databases such as `.git`, StashBase-owned `.stashbase` and
  `.stashbase-*` state, other derived state, dot-notes,
  bundle resources, and junk metadata never surface in either mode, and
  hidden excluded caches keep their bounded non-expandable rows. Turning the
  option off removes hidden rows from the tree, keyboard order, selection,
  and Quick Open without closing open tabs. Visibility here is a Workbench
  choice only: hidden-directory content stays outside Preparation, indexing,
  Search, automatic Chat context, and Agent/MCP discovery.
- Dependency caches and generated build directories such as `node_modules`
  appear as non-expandable excluded-folder rows. StashBase does not recurse
  into them, so a project can explain their presence without paying the cost
  of rendering or indexing their contents. These rows are never presented as
  dead: row hover or keyboard focus reveals an external-action arrow whose
  delayed tooltip says **Show in Finder / File Explorer**. Row activation and
  the context menu provide the same system-file-manager exit.
- Files use the surface declared in the
  [Documents format matrix](documents.md#format-capability-matrix) and open in
  persistent tabs with Quick Open, Command Palette, history, and
  platform-appropriate shortcuts. Symlinks and special or unavailable entries
  are shown but never followed; their only file action is reveal.
- Search or Agent links to a file in another member folder open a read-only
  out-of-folder tab without switching the current folder. The user can open
  that folder in another window for full editing.
- File create, rename, move, import, and delete are explicit. Organization
  gestures are not pointer-only: moving a file works by drag or through the
  file row's **Move to…** folder picker, and document tabs reorder by drag or
  by keyboard. Destructive operations confirm intent. Library-removal
  confirmation names the complete
  home-shortened member path that remains on disk. Runtime-native instruction
  files such as `AGENTS.md` and `CLAUDE.md` remain visible and user-owned;
  hidden tool infrastructure and derived data do not surface as workspace
  content.
- Durable guidance for StashBase Chats lives in the Agent panel's **Agent
  Instructions** editor as working-folder application metadata. Library-wide
  Chats use the packaged default and expose no Library-wide editor. Opening a
  folder never creates, migrates, or edits instruction files in the user's
  source tree.

## Experience Contract

- Folder entry is navigation first; listing, preparation, and indexing continue
  in the background. Code-heavy project infrastructure that cannot surface in
  the Workbench does not make those background scans hold navigation closed.
- GitHub import accepts one public repository URL and one portable folder-home
  child name. Import fields remain locked while Git runs; cancellation leaves
  no partial published folder. A completed clone is retained and its local path
  stays actionable if the later folder-open transition fails.
- Closing a window either makes its live edit durable or leaves the window open
  with an actionable failure. Closing one window never tears down another.
- Folder removal never deletes user files. Every affected window saves first
  and leaves the removed folder, and recovery cannot silently re-add it.
  Unfinished indexing is retired without holding the confirmation or removal
  flow open. If retiring the shared index daemon interrupts work for another
  live member, that member resumes reconcile after the replacement is ready.
  Folder-loss and 412 recovery clear document/readiness state but never clear
  Chat tabs; the Agent lifecycle retires only sessions bound to the removed
  member.
  StashBase commits membership removal only after preparation, derived data,
  index rows, ordering, folder-scoped Agent Instructions, and folder-bound
  runtime state have finished cleanup.
- Folder membership and favorites never replace unreadable settings with
  fallback defaults. A durable library change fails instead, preserving the
  user's existing configuration for recovery.
- Source and derived state remain distinguishable. The tree and tabs show
  source files, not generated representations.
- Tree completeness is scoped to user workspace content: excluded directory
  placeholders explain intentionally untraversed infrastructure, while hidden
  product-derived artifacts never surface. A collapsed or excluded directory
  does not create descendant DOM. The hidden-files preference widens only
  Workbench visibility — retrieval, indexing, and Agent discovery scope are
  server-owned policies it never changes.
- Repeated or concurrent navigation to one source focuses its existing
  persistent tab. The same relative path in different Library folders remains
  a distinct source.
- Chat visibility is explicit after initialization. Closing the last document
  expands an open Chat; hiding Chat stays respected until the user reopens it.
- Keyboard focus, overlay dismissal, splitters, and reduced-motion behavior are
  consistent across supported platforms.
- Quick Open covers every file visible in the active tree and preserves the
  same muted retrieval explanation for generic files. It stays active-folder
  navigation. Command Palette exposes existing
  safe actions; neither surface becomes search, Agent permission, or hidden
  destructive automation.
- Update discovery is quiet, dismissible, and never blocks local work. One
  explicit Update action consents to download, installation, and relaunch;
  every open renderer
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
[J11](../user-journeys.md#j11-turn-a-conversation-into-a-project). Folder-first
Wiki Page building is
[J12](../user-journeys.md#j12-build-wiki-pages-from-a-local-folder).

Contracts: [Architecture](../../code-review/architecture.md),
[Renderer Workspace](../../code-review/renderer-workspace.md),
[Window Lifecycle](../../code-review/window-lifecycle.md),
[File Transactions](../../code-review/file-transactions.md),
[Data Lifecycle](../../code-review/data-lifecycle.md), and
[Settings and Config](../../code-review/settings-config.md).
