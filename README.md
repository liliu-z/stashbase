# StashBase

**Stash your knowledge. Agents maintain it.**

[![Website](https://img.shields.io/badge/website-stashbase.ai-0a66c2.svg)](https://stashbase.ai)
[![Status](https://img.shields.io/badge/status-early%20alpha-orange.svg)](#)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)
[![Powered by mfs](https://img.shields.io/badge/powered%20by-mfs-0891b2.svg)](https://github.com/zilliztech/mfs)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-support%20%26%20chat-5865F2.svg?logo=discord&logoColor=white)](https://discord.gg/F7vtfTVf)

> ⭐ **If this idea interests you, drop a star.** Every item on the [build map](https://stashbase.ai/build-map/) ships with detailed design — easy to pick up if you'd like to contribute.

StashBase is an agent-native, local-first knowledge base — built for personal context that compounds over time and stays portable across AI tools.

🤖 **Agent-native:** Agents organize and maintain the KB per rules in `STASHBASE.md`. The same KB is exposed via MCP to both built-in Claude Code / Codex and any external MCP-compatible client — Claude Desktop, ChatGPT Desktop, and more.

💾 **Local-first & user-owned:** Plain HTML / Markdown / PDF files on your disk, fully portable. The accumulated context is your asset.

🎨 **Native HTML:** Native HTML rendering inside the app, plus a PDF → HTML pipeline that turns fixed-layout, read-only PDFs into pages agents can edit, maintain, and retrieve.

---

## 🚀 Demo

![Demo](.github/assets/demo_0521.gif)

> Import the CS183B starter — 20 YC startup lectures, pre-indexed. Surface ideas in Claude Desktop via `@stashbase`, then use the built-in agent (Claude Code) to organize what resonates into HTML notes.

---

## ⚡ Try it

Install the macOS cask with Homebrew:

```bash
brew install --cask liliu-z/stashbase/stashbase
```

Once the app is running:

1. On the Welcome screen, hit **Clone repo** and paste `https://github.com/0-bingwu-0/stashbase-cs183b` — Stanford CS183B's 20 startup lectures (Sam Altman, …) with a pre-built index. (V1: public GitHub repos only — no token / OAuth management.)
2. Open **Settings → MCP** (gear in the top-right corner), click **Connector** for your AI client, restart that client, then ask `@stashbase what's the best time to start a startup?`.
3. Then bring your own notes: hit **New space** on the Welcome screen and drag your `.md` / `.html` / `.pdf` files onto the app — StashBase indexes them in the background.

**Embeddings.** StashBase asks for an OpenAI API key on first launch — used **only for embeddings** (no chat completions). The default `text-embedding-3-small` is only $0.02 per 1M tokens. [Create a key.](https://platform.openai.com/api-keys) No API key? Pick the built-in local model (`bge-m3` ONNX) in the same modal — fully offline, no account, slower on long files.

---

## Example workflow

Most AI tools treat knowledge as temporary context — uploaded files, copied notes, chat history. But personal knowledge accumulates over years: papers, transcripts, notes, drafts, fragments spread across folders and apps.

StashBase is built for that accumulation layer. Files live as plain HTML / Markdown / PDF on your disk; a local indexer keeps them retrievable through hybrid (semantic + keyword) search; the whole KB is exposed via MCP to any AI client.

```text
research paper
        ↓
Claude Code reads and generates an HTML note
        ↓
StashBase indexes it locally
        ↓
later, in Claude or ChatGPT...
        ↓
"that paper on test-time compute scaling"
        ↓
relevant notes retrieved instantly
```

Codebase retrieval is already well served by tools like [Claude Context](https://github.com/zilliztech/claude-context). StashBase focuses on everything else that accumulates around AI work — papers, transcripts, reading notes, research fragments, saved analysis, generated HTML knowledge pages.

---

## Features

### Built-in Chat panel (Claude Code / Codex)

A built-in Chat panel runs Claude Code (default) or Codex inside StashBase. **No command line, no `npm install`** — the CLI binary ships with the app, runs as a child process, and StashBase renders its structured output as a chat UI (message bubbles, collapsible thinking, tool-call expansion, inline diff viewer with approve/reject). The design tracks the VSCode Claude extension closely.

* `cwd` automatically set to the current space
* Sign in with Anthropic / OpenAI OAuth (no API keys to manage)
* Sessions stored at `~/.claude/` / `~/.codex/` — resumable from external `claude` / `codex` too
* Switch the active agent from **Settings** (applies to next chat)

### Agent-maintained KB via `STASHBASE.md`

Drop a `STASHBASE.md` into a KB (or per-space) to define maintenance rules — what to summarize, how to dedupe, where to file metadata. Agents read it at session start and run the maintenance as part of normal work. **No background daemon, no silent token consumption** — maintenance happens when you ask, not on a hidden schedule.

### Skills shared across CLIs (via symlink)

Drop `<space>/skills/<name>/SKILL.md` into a space. StashBase exposes it to both CLIs via symlinks:

* `<space>/.claude/commands/<name>.md` → `../../skills/<name>/SKILL.md`
* `<space>/.codex/prompts/<name>.md` → `../../skills/<name>/SKILL.md`

All three paths resolve to the same file, so a `/digest` slash command works identically in either CLI with zero drift risk. Hand-written commands in those directories are never touched (StashBase only manages files it created).

### PDF → HTML pipeline

Drop a PDF in and a converter generates a readable, indexable HTML companion (`paper.html` + `paper_files/` asset bundle). Original PDF is kept alongside. Failed conversions surface a **Retry** button — never auto-retried (failures are usually persistent: scanned-only, encrypted, etc.).

### Space-level import

Use **Import folder** or paste a public GitHub URL into the Welcome screen — StashBase copies the folder or clones the repo as a new space under your KB root. Folder import copies by default, with an explicit move option. If the imported bundle includes `.stashbase/snapshot.parquet`, embeddings are bulk-loaded when the space opens, skipping re-embed when compatible.

### MCP exposure with one-click connector

**Settings → MCP** writes the StashBase MCP server entry directly into your AI client's global config (Claude Code, Claude Desktop, Codex CLI, Gemini CLI, Qwen Code, Cursor) or copies the right stdio snippet for GUI-managed clients. One-time setup; afterwards the KB is reachable from those clients without StashBase needing to be open.

---

## Retrieval

A StashBase KB is a folder on disk (default `~/Documents/StashBase`) containing **spaces** — first-level subdirectories. Inside spaces: HTML, Markdown, PDF, plus generated companions and resource bundles.

Indexing runs locally via [mfs](https://github.com/zilliztech/mfs) + [Milvus Lite](https://milvus.io/docs/milvus_lite.md). The index is **KB-level** (one active collection per KB), so retrieval works across spaces or scoped to one.

### When is content indexed?

* App-internal writes (editor save, drag-and-drop, MCP `write_file`) → indexed immediately
* External writes (other editors, git checkout, sync tools) → **reconciled when you next open that space** (no background filesystem watcher, no boot-time full scan — keeps embedding cost predictable)
* Agents writing via shell can call MCP `update_index` to sync explicitly

### Embedder

OpenAI `text-embedding-3-small` (recommended) or local `bge-m3` ONNX (no API key, fully offline). Switching embedders creates a **new active collection**; old collections are archived (not deleted) so a switch is reversible.

### Search

Hybrid retrieval: dense vector kNN + BM25, fused server-side via RRF in a single Milvus query. Surfaced through:

* GUI search bar (semantic by default; toggle to keyword via ripgrep)
* MCP `search_kb` tool for any AI client
* The built-in Chat panel (over MCP)

```text
        Built-in Chat panel
       (Claude Code / Codex)
                │
                ▼
        ┌─────────────────────┐
        │      StashBase      │
        │  Hybrid retrieval   │
        │  (mfs + Milvus Lite)│
        └─────────┬───────────┘
                  │
              MCP (stdio)
                  │
                  ▼
    Claude Desktop · Cursor · ChatGPT
        Gemini · any MCP client
```

---

## Why HTML

Markdown became the default not because it was more expressive, but because it was the lowest-friction format humans were willing to type.

That tradeoff changes once models generate most of the structure.

To an LLM, HTML and Markdown are both just text. But HTML carries richer structure for long-lived knowledge:

* semantic sections
* anchors
* embedded media
* tables
* expandable blocks
* durable layouts

Markdown still works well for drafts and quick notes. StashBase supports both side by side.

But for finished, shareable, agent-generated knowledge pages, HTML becomes much more compelling once humans are no longer hand-authoring every tag.

> "HTML is the new markdown. I've stopped writing markdown files for almost everything and switched to using Claude Code to generate HTML for me."
>
> — [Thariq Shihipar](https://x.com/trq212/status/2052809885763747935), Anthropic / Claude Code

> "Ask your LLM to structure your response as HTML."
>
> — [Andrej Karpathy](https://x.com/karpathy/status/2053872850101285137)

---

## Build from source

For contributors and developers building locally, and for platforms without a prebuilt cask (Intel Mac, Windows, Linux). End users should wait for the brew cask above.

```bash
# Setup
cd StashBase
pnpm install
pnpm setup:python

# Run the Electron app
pnpm electron

# Development mode
pnpm dev

# Build distributable app
pnpm dist:mac
pnpm dist:win
```

## Publishing

`dist:brew` is the one-command publishing flow: build the macOS package, upload the current version's files in `release/` to this repository's GitHub Release, then publish the Homebrew cask update.

```bash
pnpm dist:brew
```

The cask defaults to `liliu-z/stashbase/stashbase`, backed by `git@github.com:liliu-z/homebrew-stashbase.git`; override it with `HOMEBREW_TAP`, `HOMEBREW_TAP_GIT_URL`, or `HOMEBREW_CASK` if needed. GitHub Release asset upload uses `gh` when `GITHUB_TOKEN` is not set, so run `brew install gh && gh auth login` once on a new machine. Homebrew cask publishing commits and pushes directly to the SSH tap repository.

---

## MCP integration

The packaged app ships an MCP command for `@stashbase`. Open **Settings → MCP** (gear in the top-right corner) to connect it to Claude Code, OpenAI Codex CLI, Gemini CLI, Qwen Code, Cursor, Void, Claude Desktop, Windsurf, VS Code, Cherry Studio, Cline, Augment, Roo Code, Zencoder, ChatGPT Desktop, LangChain/LangGraph, or any other MCP-aware client.

Use the manual config below if you're running from source, if a client was installed after StashBase, or if you want to inspect the exact MCP settings.

**Connector support.** From **Settings → MCP**, StashBase writes the right config file directly for Claude Code, Claude Desktop, OpenAI Codex CLI, Gemini CLI, Qwen Code, and Cursor. For GUI-driven or extension-managed clients (Void, Windsurf, VS Code, Cherry Studio, Cline, Augment, Roo Code, Zencoder, ChatGPT Desktop, LangChain/LangGraph, …) the same Connector button copies the stdio config to paste into the client's MCP settings.

### MCP command

Homebrew / packaged app:

```bash
~/.stashbase/bin/stashbase-mcp
```

Source checkout:

```bash
npx tsx /absolute/path/to/StashBase/mcp/server.ts
```

The packaged command is generated when you connect a client from **Settings → MCP**. For source builds, replace `/absolute/path/to/StashBase` with your local repo path.

### Claude Code

For a Homebrew / packaged install:

```bash
claude mcp add stashbase -- ~/.stashbase/bin/stashbase-mcp
```

For a source checkout:

```bash
claude mcp add stashbase -- npx tsx /absolute/path/to/StashBase/mcp/server.ts
```

Restart Claude Code after changing MCP servers.

### Claude Desktop

Open Claude Desktop's config:

```bash
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

For a Homebrew / packaged install, add:

```json
{
  "mcpServers": {
    "stashbase": {
      "command": "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
    }
  }
}
```

For a source checkout, add:

```json
{
  "mcpServers": {
    "stashbase": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/StashBase/mcp/server.ts"]
    }
  }
}
```

Restart Claude Desktop after saving the file.

### Codex CLI

Codex CLI uses TOML configuration. Create or edit:

```bash
~/.codex/config.toml
```

For a Homebrew / packaged install, add:

```toml
[mcp_servers.stashbase]
command = "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
```

For a source checkout, add:

```toml
[mcp_servers.stashbase]
command = "npx"
args = ["tsx", "/absolute/path/to/StashBase/mcp/server.ts"]
```

Restart Codex CLI after saving the file. Codex app configuration is not currently managed by this manual TOML path.

### Other MCP clients

StashBase uses stdio transport, so most MCP-aware clients can use the same command.

Homebrew / packaged install:

```json
{
  "mcpServers": {
    "stashbase": {
      "command": "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
    }
  }
}
```

Source checkout:

```json
{
  "mcpServers": {
    "stashbase": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/StashBase/mcp/server.ts"]
    }
  }
}
```

---

## Status

Early alpha. macOS arm64 is the supported platform today; Windows / Linux are post-V1.

### Reasonably stable

* KB / space file model on disk (HTML / Markdown / PDF + asset bundles)
* Hybrid retrieval (semantic + keyword)
* MCP KB server (stdio) for external AI clients
* Space reconcile on open
* PDF → HTML pipeline
* Space-level import (local folder / public GitHub URL)

### Evolving in V1

* Built-in **Chat panel** — target design is a structured chat UI aligned with the VSCode Claude extension; the shipping build is currently terminal-based and being migrated
* **Skill mirroring via symlink** — design just finalized; implementation in progress
* **Two-layer MCP** — KB MCP server shipped; chat-panel-only "UI MCP server" (open file in viewer / read selection / render diff) being built
* **`STASHBASE.md` schema** — V1 stays freeform natural language; precise schema deferred to a separate RFC
* **Snapshot.parquet portable export** — design specified; explicit export action being wired up

### Post-V1

Windows / Linux, cloud sync, multi-device, mobile access, team collaboration, KB-level skills, per-space MCP server injection.

Pin a commit if you're embedding StashBase into a larger workflow.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Small focused PRs are preferred. Open an issue before larger changes so scope and direction can be discussed first.

---

## About

Built by Li Liu.

I work on [Milvus](https://github.com/milvus-io/milvus) at [Zilliz](https://zilliz.com), where I've spent the last few years building vector retrieval infrastructure for AI systems.

Coding with agents already feels fluid inside IDEs. Personal knowledge tools still largely don't.

StashBase is my attempt at the missing layer: an agent-native, local-first workspace where papers, notes, transcripts, and saved analysis remain continuously retrievable across AI workflows.

This is a personal side project built in the open. PRs, issues, and experiments are welcome.
