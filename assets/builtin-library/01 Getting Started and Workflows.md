# Getting Started and Workflows

This guide begins after StashBase is installed. It reflects Shipping behavior
as of 2026-08-31.

## What First Launch Looks Like

A new window opens with no folder selected and one reusable blank Chat. It does
not silently select a folder, send a prompt, install an Agent runtime, or begin
using an online AI service.

On a brand-new empty default folder home, StashBase creates the ordinary
`👋 Start Here` folder and adds it to the Library without opening it. If that
home already contains user folders, onboarding does not seed or modify it.

Similarity Search is recommended for meaning-based retrieval but remains
optional. The empty Library stays quiet; the first folder you activate offers
hosted sign-in or an OpenAI/OpenRouter key. **Not now** keeps browsing,
preview, editing, Preparation, Exact Search, and Build Wiki available,
and is remembered across folders and relaunches. The Files-panel **Set up**
action, Similarity Search mode, and Settings remain available later.

## Fastest Local-Only First Result

1. Open the titlebar **Library** menu.
2. Select `👋 Start Here`, or choose **Add Folder…** and authorize an existing
   local folder whose contents you know.
3. Open a source file. Folder entry prioritizes navigation; background
   Preparation and indexing do not have to finish first.
4. Open Search, choose **Exact**, and search for a word or phrase known to be in
   the source. In Start Here, try `source of truth`.
5. Open a result and confirm that it returns to the visible source file.

That is a complete useful session. It requires no StashBase account, Similarity Search,
transcription model, or Agent runtime.

## Build Wiki from Sources

After opening one of your folders, a blank folder-scoped Chat shows **Build
Wiki Pages** directly below the composer. Choosing it asks the Agent to inspect
the Sources and create or improve source-linked `wiki/index.md`. It may add
focused pages under `wiki/` only when one map would become unwieldy.

Build Wiki preserves the existing layout and modifies only `wiki/`. It
does not move, rename, delete, or broadly rewrite Sources; a physical
reorganization must be proposed and approved separately. Similarity Search
setup does not appear or block this action. If selected-Agent setup is needed,
the original action stays pinned to the same folder and resumes once the Agent
is ready.

## Ask Chat How StashBase Works

The blank Chat starts with Library scope, so `👋 Start Here` is part of the
authorized context even before one folder becomes the current workspace.

Try:

- `How do I use StashBase?`
- `What can I do without Similarity Search?`
- `Explain the difference between Preparation and Similarity Search.`
- `Which file formats can an external MCP Agent actually read or edit?`
- `How is StashBase different from NotebookLM or Obsidian?`

Before the first turn, confirm the visible scope. A Library-scoped Chat may use
all Library folders; a folder-scoped Chat stays with that one member.

The Chat tab toolbar contains **Agent Instructions**. Use it for durable
guidance for the active working folder. A readable default already applies;
Library-wide Chats use that default, and folder customizations take effect from
the next message. StashBase stores them in
application settings and does not create or modify `AGENTS.md` or `CLAUDE.md`
in your source folders.

If the selected Claude Code or Codex runtime is missing, StashBase waits for
**Install and continue**. Opening the app, a folder, or Chat history is not
installation consent. Provider authentication is separate: for example,
Codex may offer **Sign in with ChatGPT** through the same discovered runtime.
Neither Agent login is a StashBase account or a Similarity Search credential.

Opening a document docks the same conversation beside it. Closing the last
document expands an open Chat again. The session, draft, transcript, and scope
remain the same presentation state.

## Add Similarity Search When Meaning Matters

Exact Search is best when the wording is known. Similarity Search is useful when
the same idea may be expressed with different words or buried among many
documents.

1. Choose Similarity Search, the Files-panel **Set up** action, or open **Settings
   → Similarity Search**.
2. Sign in to StashBase for the current hosted allowance, or configure an
   OpenAI/OpenRouter key.
3. Confirm which source is selected and understand its data-handling terms.
4. Let background indexing make relevant files ready.
5. In Search, choose **Similarity** and try a concept query that does not copy the
   source wording.

Hosted indexing and Similarity Search queries share the allowance shown in the account
menu. If hosted capacity or the provider is unavailable, Exact Search and all
ordinary local-file workflows remain available.

## Turn Sources and Chat into Durable Work

The repeatable StashBase workflow is:

1. Add or select an ordinary project folder.
2. Inspect a Source and retrieve relevant evidence with Exact Search or
   Similarity Search.
3. Start an Agent task with an explicit Library or folder scope.
4. Inspect the Agent's evidence, tool activity, permissions, and proposed file
   changes.
5. Ask it to write only accepted conclusions into an explicit Markdown
   document, or edit and save that document yourself.
6. Reopen or retrieve the saved source in later work without depending on the
   original conversation.

Agent-created or changed files refresh the workspace but do not automatically
open themselves or replace the user's current focus.

## Begin with a Conversation, Then Create a Project

A user does not need an existing folder before exploring an idea.

1. Start in a Library-scoped Chat.
2. Explore the question or task.
3. When it deserves a durable home, explicitly ask the Agent to turn it into a
   project and give it a safe name.
4. StashBase can create and register one new ordinary folder inside the default
   folder home or another authorized location.
5. The initiating Chat keeps its transcript and changes scope to the new
   project.
6. Explicitly write accepted goals, decisions, or plans into ordinary project
   files.

StashBase does not infer project-creation consent from conversation alone and
does not copy the transcript into project files automatically.

## Work with Hard-to-Read Sources

- PDF and DOCX can be previewed while their searchable representation is being
  prepared.
- Images use OCR for searchable evidence.
- Audio and supported video use timestamped transcripts. Download a local
  speech model under **Settings → Transcription** only when needed.
- Preparation failures do not make the original source unavailable. Retry or
  use another local action while recovery is pending.

## Connect an External Agent Later

Built-in Claude Code and Codex setup is automatic after deliberate Agent
activation. For another MCP-compatible client, open **Settings → MCP** and copy
the standard configuration or connection details.

Keep the StashBase app running while an external MCP client uses it. The client
receives bounded operations over Library folders, not general host filesystem
access. See `03 Capabilities and Boundaries.md` before making claims about which
formats an external client can read or edit.

## Returning Later

Library membership and durable settings persist across launches. A new window
again begins without silently selecting a folder. Started Chats retain their
own scope, and ordinary source files remain usable even if an optional online
service or Agent is unavailable.
