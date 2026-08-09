# Local File Workspace

StashBase is a workspace for ordinary local folders. It should make existing
files easier to work with and easier to hand to an Agent without asking users
to migrate them into a StashBase-specific storage model.

## Current

- Users can add, create, open, and remove local folders from the library.
- Each window centres on one current folder, with its own file tree, document
  tabs, search state, and Agent panel.
- Users can open multiple windows from the application menu or a folder action
  to keep different folders or working contexts visible side by side. A folder
  action focuses an existing matching window when one is already available.
- Window keyboard behavior follows VS Code: Cmd/Ctrl+Shift+N opens a window;
  macOS uses Cmd+Shift+W to close one, while Windows and Linux use Alt+F4 with
  Ctrl+Shift+W as an alternative. Cmd/Ctrl+W remains the active-tab command.
- Users can create, rename, move, and delete files or folders through explicit
  file operations.
- A folder opens into a chat-first workspace with the Files sidebar still
  visible. Selecting or creating a document reveals the source pane and docks
  the same conversation beside it.
- The main pane opens the source file the user selected; generated artifacts
  stay hidden.
- PDF tabs retain their active reading position (page number) across tab switches during a session. Reusing a preview tab for a different file resets the stored page position.
- Cmd/Ctrl+T opens a new blank tab, the keyboard equivalent of the tab
  strip's `+` button — distinct from Cmd/Ctrl+N, which creates a note file.
- Cmd/Ctrl+O opens a focused Quick Open for visible source files in the active
  folder. It starts with recently used editors, then ranks basename and
  relative-path matches; accepting a result retains normal preview-tab and
  unsaved-work protections. Typing `>` switches that same picker to safe app
  commands; Cmd/Ctrl+Shift+P and F1 open that command mode directly.
- Holding Ctrl and tapping Tab opens Editor History, a VS Code-style
  Alt-Tab switcher over open tabs ordered by most-recent use, independent of
  tab-strip order. A quick tap-release switches straight to the previous
  editor without ever showing the picker; only a deliberate hold (or a
  second Tab tap) reveals it. Once revealed, tapping Tab while Ctrl stays
  down cycles the highlighted entry (Shift reverses); releasing Ctrl
  activates it. Escape cancels. Deliberately the literal Control key on
  every platform, including macOS, since Cmd+Tab is the OS application
  switcher.
- Search results and agent file links return users to those source files.
- Root-level `AGENTS.md` and optional `CLAUDE.md` bridge files are visible,
  editable user files. StashBase only creates missing defaults.

## Experience Contract

- Opening a folder should feel like navigation, not a long preparation task.
- Opening or closing one window must not switch or close another window's
  folder context.
- Window lifecycle shortcuts must not be interpreted as document-tab commands.
- Closing a window must either save the live edit first or leave the window
  open with a visible save failure.
- Opening a folder from one window must not create an avoidable duplicate when
  another window already owns that context.
- Users must be able to tell whether an operation affects source files or only
  StashBase-owned state.
- Removing a library folder removes derived state, never the user's folder.
- Removing a folder that is open elsewhere saves those windows and returns
  them to the library view instead of leaving stale editable state behind.
- Destructive file operations require clear confirmation.
- Blocking dialogs and menus keep keyboard focus inside the active surface,
  dismiss only the topmost eligible surface with Escape, and return focus to
  the invoking control. Pointer context menus first focus their file-tree row,
  so dismissal has the same deterministic return target. Non-blocking feedback
  is announced without stealing focus.
- Sidebar and Agent-panel widths work with pointer input and with
  Arrow/Home/End keys on macOS, Windows, and Linux; reduced-motion users do
  not receive layout movement animation.
- Closing the last document lets an open Chat reclaim the main area. Hiding
  Chat is explicit and leaves a lightweight document/chat launcher instead of
  immediately reopening it.
- The Files sidebar is a calm orientation tool, not a separate knowledge graph
  or project-management surface. It groups the file tree and the active
  Markdown document outline into independently collapsible navigation sections.
- StashBase displays only supported document and media formats in the Files
  panel. Unsupported files are classified into source-code/project files and
  other unsupported formats. Folders containing only unsupported or excluded
  content are pruned, while physically empty folders and paths leading to
  supported files remain visible. Each unseen category gets a first-time
  explanation: cancelling dismisses it for the current folder view, while the
  primary action records only the categories shown. A persistent Files-panel
  callout keeps the hidden-file boundary and Details action available.
- Quick Open is file navigation, not content retrieval: it stays scoped to the
  active folder and does not surface generated artifacts or search evidence.
- Command Palette exposes only safe, context-available actions the app already
  supports. Its recency ordering lasts for the current session only; destructive
  and target-dependent operations keep their explicit flows and confirmations.

## Contribution Map

### Next

- Make loading, empty, and operation-failure states less ambiguous.
- Improve file-tree navigation and tab behaviour at large folder sizes.
- Make source versus derived state more legible without surfacing generated
  files.
- Improve file creation, rename, move, and attachment workflows.

### Coordinate First

- Folder membership, filesystem safety, deletion, or agent file permissions.
- Changes to what appears in the tree or what a search result opens.
- New workspace models, synchronization behaviour, or file storage layers.

### Not Planned

- A database-first or block-first knowledge base.
- Requiring users to copy files into a StashBase-managed workspace.
- A complex graph view as a primary navigation surface.

For Markdown-specific reading and writing, see [Markdown](markdown.md).
