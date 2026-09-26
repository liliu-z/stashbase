# Using StashBase

Start with [Start Writing](../README.md#start-writing): enter a project,
brainstorm with an Agent, and begin drafting when ready.

## Choose a Folder and an Agent

The first window opens at Welcome. Open an existing folder, create an empty
project, import a public GitHub repository, or choose **Make a copy** in the
Gallery. Chat becomes available inside the project, even if it contains no
files. An entry's **Copy prompt** copies its build request for you to paste;
it does not start a conversation automatically.

Choose Claude or Codex and sign in with your provider account.
A missing runtime waits for **Connect Claude** or **Connect Codex** before
installation. If Claude is too old for the model you chose, the failed turn
offers **Update Claude**. **Settings → Agents** shows each installed runtime's
version with an **Update** that runs the runtime's own updater in place.

If you can't use either, the built-in **Default Agent** provides a fallback
with free credits. Sign in to StashBase from the bottom of the sidebar or
**Settings → Agents**; no separate Agent installation or model API key is required.

Start with an idea or question in the project's Chat. When ready, ask the
Agent to create an outline or draft, or write directly in a new document.
References and search are available when useful; neither a wiki nor a
completed index is required to brainstorm.

For a source-filled project, you can ask your Agent to organize references
into linked wiki pages. Search always targets one project,
and wiki maintenance runs only when requested.

## Read and Work Alongside Chat

Selecting a source opens it alongside the same conversation. The Files sidebar,
persistent tabs, and format-specific viewers let you browse, read, and edit
supported files directly.

- **Cmd/Ctrl+O:** find and open a file in the active folder.
- **Cmd/Ctrl+Shift+P** or **F1:** open the Command Palette.
- **File → New Window** or **Cmd/Ctrl+Shift+N:** work in another window.
- **Cmd/Ctrl+W:** close the active document tab.
- **@ mentions in Chat:** find a file or folder and insert its relative path.

Tool calls and file edits can be reviewed in Chat. Use **Persona** in the
composer to choose who the Agent is when it talks and writes in this project:
Marketer, Journalist, Storyteller, or **Custom**, which opens an empty box for
your own. A choice applies from your next message and to new chats in the
project. How the Agent works belongs in your own `AGENTS.md` or `CLAUDE.md`;
StashBase never creates or rewrites them.

Drafting, editing, Agent file-change reports, and save-conflict comparisons are
available, and so is the [document diff](../README.md#document-diff): an Agent can
propose a revision to an open Markdown document, and you accept or reject each change
in the prose or take the whole set at once.

Select prose in a Markdown document and choose **Humanize** on the selection
toolbar to have Hemmingway-1 rewrite it plainly. The rewrite opens as the same
suggested changes; nothing is written until you accept one. It sends the
selection to a StashBase-run service, needs no account, and is free for a
limited time.

Some files can be listed without being searchable or editable. Muted files
are excluded from Search and automatic Chat context. Preview, editing,
retrieval text, and Agent file access vary by format; see the canonical
[Format Capability Matrix](../design-docs/capabilities/project-files.md#format-capability-matrix).

## Turn On Search by Meaning

Keyword search needs no account or API key and is on from the start. Search
by meaning, which finds files even when the wording differs, is off until you
add an OpenAI, OpenRouter, or Requesty key under **Settings → Advanced → Search by Meaning**. The
key is billed to you and is used only for search by meaning; signing in to
StashBase does not turn it on.

Once the key is saved, StashBase prepares registered projects and keeps their
search index synchronized, and the search panel gains a **By meaning** mode
beside **By keyword**. Removing the key turns it off again. This background
work is separate from an Agent writing visible Wiki Pages. An OpenAI
restricted key needs embedding access for `text-embedding-3-small`;
model-list access is not required.

Search covers direct text in supported Markdown, UTF-8 plain text, HTML, and
JSON files, plus prepared text from PDFs, DOCX files, and images.
Results point back to the visible source file. Some material needs preparation
before it can appear; Search reports readiness, and failed preparation can be
retried.

Agents search the same way: text matching always, including prepared
document text, plus meaning-based evidence once a key is on.

Default Agent credits don't cover search by meaning. Check the account
menu at the bottom of the sidebar or **Settings → Agents** for the remaining
percentage and refill date.

## Preview Recordings

Audio and video files play directly when their codec is supported. Unsupported
files can be opened externally. Media is not prepared, searchable, or readable
as Agent/MCP content.

## Manage Access

Folders join the project registry only when you explicitly add or open them,
including making a Gallery copy.
Removing a folder clears StashBase's state for it without deleting its files.

For an external Agent client, keep StashBase running and register the
configuration from **Settings → Advanced → External apps (MCP)**. See
[MCP Configuration](mcp-configuration.md) for setup and access boundaries, and
[Your Files and Your Data](../README.md#your-files-and-your-data) for local and
cloud processing boundaries.
