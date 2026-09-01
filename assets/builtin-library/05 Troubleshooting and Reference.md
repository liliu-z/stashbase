# Troubleshooting and Reference

This guide explains the first checks and safe fallbacks for common StashBase
questions. It reflects Shipping behavior as of 2026-08-31.

## Search Returned No Results

Check each stage separately:

1. **Library membership:** Is the expected folder still in the Library?
2. **Scope:** Is Search covering the whole Library or narrowed to the correct
   folder?
3. **Mode:** Use Exact for known wording; use Similarity for related meaning.
4. **Retrieval capability:** Does the format provide direct text, or does it
   need current prepared text?
5. **Preparation:** Is extraction, OCR, or transcription still running,
   blocked, failed, stale, or cancelled?
6. **Similarity Search:** Is a provider configured, and is the expected content
   ready?
7. **Hosted availability:** Is the provider available, and does the hosted
   allowance remain?

Switching to Exact Search is the normal fallback when Similarity Search cannot continue.
A true empty result, incomplete Preparation, incomplete indexing, wrong scope,
provider failure, and exhausted allowance are different conditions.

## A File Opens but Is Not Searchable Yet

Preview and retrieval are separate capabilities. PDF, DOCX, images, audio, and
video may open before their prepared text is current. Continue browsing, then
retry after Preparation completes. A preparation failure does not make the
source itself a failed file.

A muted generic file is different: it is deliberately outside Search and
automatic Chat context. Strict UTF-8 content can still open read-only; binary,
unsupported encoding, oversized, or unavailable content keeps an explicit
cannot-open surface with a file-manager action. This state does not become
searchable by waiting for Preparation.

For audio or video, download a local model under **Settings → Transcription**.
If optional native support is missing, StashBase should explain the blocked or
retryable stage without blocking the rest of the folder.

## Similarity Search Is Unavailable or Paused

- Confirm the selected provider under **Settings → Similarity Search**.
- Hosted access requires a StashBase sign-in; bring-your-own access requires an
  OpenAI or OpenRouter key stored in Settings.
- Hosted indexing and Similarity Search queries share the displayed allowance.
- Known stale semantic evidence is hidden rather than presented as current.
- Pending work can resume after allowance refresh or after selecting an
  available bring-your-own source.

Exact Search and ordinary local file work remain available throughout.

## Build Wiki Is Waiting

Build Wiki may wait for the selected Agent runtime or its account.
Similarity Search setup is independent and never blocks this action. Complete the visible Agent setup
action; the pending action stays pinned to its original folder and sends once
when the Agent is ready. Use **Cancel** below the capsule to discard it.

Build Wiki modifies only `wiki/`; it does not move, rename, delete, or
broadly rewrite Sources. If
an Agent proposes physical reorganization, review and approve that as a
separate action. If a partial `wiki/index.md` was written before failure, treat
it as an ordinary visible file: inspect it, then retry or edit it directly.

## Built-In Chat Does Not Start

Treat these stages separately:

- **Runtime missing:** choose **Install and continue** only if installation is
  wanted. Opening Chat or a folder never grants that consent.
- **Installation failed:** use **Check again** after installing or repairing
  the runtime outside StashBase; checking does not authorize another download.
- **Agent signed out:** use the selected runtime's sign-in recovery. Codex can
  offer **Sign in with ChatGPT** through that same executable; Claude may
  provide terminal sign-in guidance.
- **MCP connection failed:** use the stage-specific setup or retry action.
- **Turn failed:** use the in-conversation recovery card. The transcript and
  session remain available.

StashBase sign-in and Similarity Search configuration do not sign in Claude Code or
Codex.

## A Chat Seems to Be Using the Wrong Folder

Check the scope picker or the conversation's visible scope. Library scope can
use all member folders. Folder scope is pinned to one member. Once work has
started, switching the window's current folder does not silently rebind the
conversation.

An out-of-folder search or Agent link opens read-only in the current window.
Open its owning folder in another window for full editing.

## An Agent Cannot Read or Edit a File

Previewability does not imply Agent readability or content editing. Consult
`03 Capabilities and Boundaries.md` for the exact surface:

- external MCP reads current prepared text for PDF, DOCX, audio, and video;
- external MCP does not receive image bytes through `read_file`;
- a built-in Agent may consume an explicitly supplied image;
- preview-only binary formats reject content writes;
- generic Workbench files do not appear in Agent/MCP directory, read, or
  mutation tools;
- rename, move, and delete are separate file-level operations.

For `@` mentions, remember that selecting a result inserts only its
workspace-relative path. It does not attach file bytes or make every format
readable by every Agent client.

## An External MCP Client Cannot See StashBase

- Keep the StashBase desktop app running.
- Confirm the client configuration under **Settings → MCP**.
- Restart clients that read MCP configuration only at startup.
- Confirm the expected folder is a current Library member.
- Confirm requested paths remain inside that member.
- For meaning-based retrieval, confirm Similarity Search separately; Exact
  Search remains the fallback.

Advanced configuration, URL access, Docker boundaries, CORS, and credential
rotation are documented at
<https://github.com/liliu-z/stashbase/blob/main/docs/mcp-configuration.md>.

## Files Changed Outside StashBase

StashBase reconciles disk changes after server boot, folder entry, focus
return, manual Sync, MCP reindex, Agent turn completion, and relevant settings
changes. Use Sync or `reindex` when an external tool changed files and current
retrieval has not caught up.

An external change that conflicts with an unsaved Markdown, plain-text, or JSON edit is not
silently overwritten. Resolve the visible reload, overwrite, or merge decision.

## Removing a Folder or Start Here

Removing a folder from the Library clears StashBase-owned derived data, index
rows, ordering, and folder-bound runtime state only after active edits are
saved. It never deletes the source folder or its files from disk.

Deleting a folder on disk is a separate filesystem action. The bundled
`👋 Start Here` folder is created only for a pristine first-use home. If it is
deleted after seeding, StashBase does not recreate it.

The bundled guide is copied as ordinary user-owned content. Later application
updates do not overwrite an existing copy, so dated facts in this folder are a
snapshot rather than a live documentation service.

## Report a Problem

Use **Report Bug** from the sidebar or native Help menu. StashBase prepares a
local draft, lets the user review and independently include or exclude each
available artifact, and never submits anything automatically. The user chooses
whether to open a prefilled GitHub issue or download the files.

Current resources:

- Latest release and notes: <https://github.com/liliu-z/stashbase/releases/latest>
- Source and issue tracker: <https://github.com/liliu-z/stashbase>
- Current online FAQ: <https://stashbase.ai/docs/faq/>
- Current getting-started guide: <https://stashbase.ai/docs/getting-started/>
- Community support: <https://discord.gg/zsRZH4PTq9>
