# Local File Workspace

Product design for StashBase's Obsidian-like local file workspace.

## Entry / Library

- [Implemented] The Welcome screen shows added local folders.
- [Implemented] Users can open an existing folder.
- [Implemented] Users can create or add a new local folder.
- [Implemented] Users can remove a folder from the library; this removes StashBase-owned state but does not delete user files.
- [Implemented] One window primarily works around one current folder.
- [Implemented] Opening a folder is navigation-first; file listing, ordering, and index status can load afterward.
- [Planned] Welcome and folder list states can show readiness or failure more clearly.

## File Tree

- [Implemented] The left file tree shows files and subfolders in the current folder.
- [Implemented] Users can open files.
- [Implemented] Users can create files and folders.
- [Implemented] Users can rename files and folders.
- [Implemented] Users can delete files and folders with explicit confirmation.
- [Implemented] Users can expand and collapse folders.
- [Implemented] StashBase-owned derived artifacts are hidden.
- [Implemented] `AGENTS.md` and `CLAUDE.md` appear as ordinary Markdown files that can be viewed and edited.
- [Planned] File tree and file operations can further reduce waiting ambiguity and unclear error states.

## Tabs / Main Pane

- [Implemented] Opened files are managed as tabs.
- [Implemented] Clicking a file in the tree opens or activates the corresponding tab.
- [Implemented] The same file should not open as duplicate ordinary tabs.
- [Implemented] Users can close tabs.
- [Implemented] Local file links from search results or agent output can open the matching file.
- [Implemented] Users can find within the current file.
- [Planned] The default relationship between tabs, preview, and edit mode can be simplified.

## Preview

- [Implemented] Markdown is shown as document preview.
- [Implemented] Markdown preview uses source content, not a derived representation.
- [Implemented] Markdown preview supports common GFM content such as tables, task lists, links, images, and code blocks.
- [Implemented] Markdown preview supports heading anchors, footnotes, frontmatter handling, and GitHub alerts.
- [Implemented] Local Markdown / HTML links in Markdown preview can open inside StashBase.
- [Implemented] External links open in the system browser.
- [Implemented] Images in Markdown preview can be opened in a lightbox.
- [Implemented] PDFs show the original PDF.
- [Implemented] PDF preview supports page display and page jumping.
- [Implemented] DOCX shows a readable preview generated from the source file.
- [Implemented] Images show the original image.
- [Implemented] Markdown preview supports syntax highlighting for fenced code blocks.
- [Planned] Markdown preview can add offline KaTeX math.
- [Planned] Markdown preview can improve narrow-window behavior for tables, long URLs, inline code, and task lists.
- [Planned] Mermaid or diagrams should only be considered if they do not weaken the preview trust boundary.

## Edit

- [Implemented] Markdown can be edited.
- [Implemented] Markdown edits save back to the source file.
- [Implemented] Users can switch between Preview and Edit.
- [Implemented] Leaving Edit for Preview saves pending changes first.
- [Implemented] Markdown source is the source of truth for editing and indexing.
- [Planned] Markdown editing should feel more like a knowledge-base writing surface.
- [Planned] Line numbers, gutters, and active-line code-editor cues should be hidden or reduced.
- [Planned] Editor typography should move closer to preview typography.
- [Planned] Support live-preview style Markdown editing.
- [Planned] Improve writing flows for headings, lists, links, and images.
- [Planned] Improve image and attachment insertion.

## Folder-Level Agent Files

- [Implemented] A newly opened folder can have a root-level `AGENTS.md`.
- [Implemented] `AGENTS.md` records durable agent instructions for that folder.
- [Implemented] Claude compatibility can use a `CLAUDE.md` bridge pointing to `AGENTS.md`.
- [Implemented] `AGENTS.md` and `CLAUDE.md` are visible, editable, deletable user files.
- [Implemented] StashBase does not overwrite existing user content when creating these files.

## Not In Scope

- [Not planned] Block editor.
- [Not planned] Database-first or table-first knowledge base.
- [Not planned] Complex graph view.
- [Not planned] Requiring users to migrate files into a StashBase-specific format.
