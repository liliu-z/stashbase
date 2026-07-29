# StashBase

**Turn local files into searchable context for Agents.**

[![Website](https://img.shields.io/badge/website-stashbase.ai-0a66c2.svg)](https://stashbase.ai)
[![Release](https://img.shields.io/github/v/release/liliu-z/stashbase?label=release)](https://github.com/liliu-z/stashbase/releases/latest)
[![Status](https://img.shields.io/badge/status-early%20alpha-orange.svg)](#status)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-support%20%26%20chat-5865F2.svg?logo=discord&logoColor=white)](https://discord.gg/zsRZH4PTq9)

📂 Open a folder in StashBase to make it searchable by Agents:

- 📄 **Prepare files:** extract searchable text from PDFs, DOCX files, images, audio, and video.
- 🔎 **Search & index:** find relevant context by meaning, not just matching keywords.
- 🤖 **Connect Agents:** keep context shared across Claude, Codex, and other MCP clients.

Your folders remain the source of truth; StashBase adds a search index that can be rebuilt from them.

That is the core idea:

```text
Local files -> Prepare -> Index -> Retrieve -> MCP -> Agents
```

---

## 🚀 Demo

Open this repo in StashBase and ask the built-in Agent: **How is this project designed?**

![StashBase demo: opening local design docs and asking the Agent about architecture and product direction](assets/readme/demo.gif)

---

## 💡 Try It

StashBase primarily supports **macOS 12+ (Apple Silicon)** and **Windows 10+ (x64)**. A community-supported Linux build is also available for **x86_64 Debian 12+ / Ubuntu 22.04+**.

### macOS

```bash
brew install --cask liliu-z/stashbase/stashbase
```

### Windows

Download the latest `StashBase-*-win-x64.exe` installer from [Releases](https://github.com/liliu-z/stashbase/releases), then run it.

### Linux

Download the latest `StashBase-*-linux-amd64.deb` asset from [Releases](https://github.com/liliu-z/stashbase/releases), then install it:

```bash
sudo dpkg -i ./StashBase-*-linux-amd64.deb
```

### First Run

> Don't have an OpenAI API key? Keyword search still works. Join our [Discord](https://discord.gg/zsRZH4PTq9) to ask about evaluation access.

1. Open an existing local folder, or create a new one from the native folder picker.
2. Add an OpenAI API key when prompted if you want semantic search.
3. To transcribe audio or video, download a model from **Settings -> Transcription**: Tiny is about 74 MiB, Base 141 MiB, and Small 465 MiB. Small is selected by default; processing stays local and has no per-minute API fee. Transcription can be cancelled or reprocessed while viewing the file.
4. Connect Claude, Codex, or another MCP client from **Settings -> MCP**.
5. Ask the Agent to search or use your local files.

Your library is opt-in: only folders you open in StashBase are indexed. You can remove a folder from the library at any time; StashBase clears its index but never deletes the folder from disk.

---

## What It Does

StashBase has two core jobs: prepare files and index their contents.

### Prepare

Some formats need preparation before their contents can be searched. StashBase keeps the original files in place and creates derived text only where needed for search and Agent access.

| Format | Source file | Search / Agent text |
|---|---|---|
| Markdown | Read directly | Indexed directly |
| HTML | Read as original HTML | Clean text extracted for indexing |
| PDF | Original PDF stays on disk | Converted to derived Markdown |
| DOCX | Original DOCX stays on disk | Converted to derived HTML |
| Images | Original image stays on disk | OCR text extracted for search |
| Audio and video | Original media stays on disk | Audio track transcribed locally to timestamped Markdown |

For PDF, DOCX, audio, and video, Agents read derived text while the original remains the visible source file. Audio and video play directly when supported; otherwise, StashBase creates a compatible local playback version. Large drag imports stream to disk instead of being held in renderer memory. See [Architecture](design-docs/architecture.md) and [Preparation](design-docs/design/preparation.md) for the product and system contracts.

### Index

StashBase builds semantic and keyword search over:

- Markdown and HTML text
- PDF-derived Markdown
- DOCX-derived HTML
- OCR text from images
- timestamped transcripts from audio and video

Search results point back to the user-visible source file, not hidden app data.

Background preparation is intentionally quiet. Browsing a folder should feel like browsing files, not watching an indexing job. If preparation fails, StashBase shows a lightweight failure marker and lets you retry. Search is where readiness matters, so search is where StashBase explains how much content is ready.

---

## MCP

MCP is the main interface between StashBase and Agents.

While the StashBase app is running, the local MCP server exposes the same library to external clients and the built-in Agent panel.

Core tools:

- `library_info` - return the default folder home, opened folders, optional folder descriptions, and embedder status.
- `search_library` - search the library, optionally scoped by folder or path prefix.
- `reindex` - reconcile disk changes and make updated files searchable.

StashBase also exposes bounded file helpers for opened folders:

- `list_directory`
- `read_file`
- `write_file`
- `edit_file`
- `move_file`
- `delete_file`

These helpers are for Agent clients that run in a sandbox and cannot directly access the user's host files. They are not a second general-purpose filesystem.

### Connect a Client

The normal path is **Settings -> MCP**. StashBase can write the MCP config for supported clients or copy the stdio snippet for clients that manage config themselves.

For manual stdio setup, URL-based clients, Docker access, ports, CORS boundaries, and token rotation, see [Advanced MCP configuration](docs/mcp-configuration.md).

---

## Built-In Agent Panel

StashBase includes a built-in panel for running local Agent CLIs such as Claude Code and Codex against the current folder.

The panel uses the same library and MCP server as external clients. It does not create a separate knowledge base.

It is mainly a convenience layer:

- sessions run in the current folder
- tool calls and file edits can be reviewed in the app
- sessions stay in the Agent CLI's normal storage
- external clients can use the same context through MCP

---

## Storage Model

Local files are the source of truth.

```text
~/.stashbase/config.json          # app-level config, including transcription preferences

<folder>/
  paper.pdf                       # user file

<appData>/derived.nosync/         # derived text, assets, transcript work, media previews
<appData>/models/whisper/         # explicitly downloaded local speech models
<appData>/vector-store.nosync/    # Milvus Lite vector store
<appData>/state/state.db          # conversion failures and local app state
```

Removing a folder from the library clears StashBase's app-owned state for that folder. It does not delete the folder or its files from disk.

---

## Design Docs

The design docs explain the product intent, system contracts, and contribution
areas without duplicating the source tree:

- [Design docs guide](design-docs/README.md) - contribution map and maintenance rules
- [Overview](design-docs/overview.md) - product thesis
- [Principles](design-docs/principles.md) - durable decision rules
- [Architecture](design-docs/architecture.md) - system boundaries and invariants
- [Product direction](design-docs/product-direction.md) - intended product shape

---

## Build From Source

For contributors and developers building locally, and for platforms without a prebuilt installer.

```bash
git clone https://github.com/liliu-z/stashbase
cd stashbase
pnpm install
pnpm setup:python

# Build the renderer and run Electron
pnpm build:web
pnpm electron

# Development mode
pnpm dev

# Build a distributable app for your platform
pnpm dist        # macOS
pnpm dist:win    # Windows
pnpm dist:linux  # Linux

# Optional: include the local PDF/OCR extractor sidecar
pnpm build:python-extract-sidecar
```

Before opening a PR:

```bash
pnpm check
```

---

## Status

Early alpha.

Primary support:

- macOS arm64
- Windows 10+ x64

Community-supported:

- Linux x86_64 Debian 12+ / Ubuntu 22.04+

Reasonably stable:

- Local folder library model
- Markdown preview with accessible footnotes, plus HTML, PDF, and image handling
- PDF extraction, image OCR, and local audio and video transcription, with persisted failures and retry
- Semantic and keyword search
- MCP server and client connectors
- Bounded file helpers for sandboxed Agents
- Built-in Claude Code / Codex panel

### Where We Need Help

- [Agent panel polish](https://github.com/liliu-z/stashbase/issues?q=is%3Aissue+is%3Aopen+label%3A%22area%3A+agent-panel%22)
- [Search filters and ranking controls](https://github.com/liliu-z/stashbase/issues?q=is%3Aissue+is%3Aopen+label%3A%22area%3A+search%22)
- [Long-running conversion and recovery edge cases](https://github.com/liliu-z/stashbase/issues?q=is%3Aissue+is%3Aopen+label%3A%22area%3A+preparation%22)
- [Packaging polish across platforms](https://github.com/liliu-z/stashbase/issues?q=is%3Aissue+is%3Aopen+label%3A%22area%3A+packaging%22)

---

## Contributing

Small focused PRs are preferred. Open an issue before larger changes so scope and direction can be discussed first.

Not sure where to start? Open [`design-docs/`](design-docs/) in StashBase and ask the Agent—or just ask us.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development, validation, and release-maintainer notes.

---

## About

StashBase is an independent open-source project built by [Li Liu](https://github.com/liliu-z), who works on [Milvus](https://github.com/milvus-io/milvus) at [Zilliz](https://zilliz.com). It applies years of experience in vector retrieval to making local files searchable across Agent workflows.
