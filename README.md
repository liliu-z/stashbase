# StashBase

**Turn local files into searchable context for Agents.**

[![Website](https://img.shields.io/badge/website-stashbase.ai-0a66c2.svg)](https://stashbase.ai)
[![Status](https://img.shields.io/badge/status-early%20alpha-orange.svg)](#status)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)
[![Powered by mfs](https://img.shields.io/badge/powered%20by-mfs-0891b2.svg)](https://github.com/zilliztech/mfs)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-support%20%26%20chat-5865F2.svg?logo=discord&logoColor=white)](https://discord.gg/zsRZH4PTq9)

📂 Open a folder in StashBase to make it searchable by Agents:

- 📄 Turn PDFs, including scans, into Markdown.
- 📝 Convert DOCX files into derived HTML for preview and Agent reading.
- 🖼️ Pull searchable text out of images with OCR.
- 🔎 Index Markdown, HTML, PDFs, DOCX files, and images for semantic and keyword search.
- 🤖 Let Claude, Codex, and other MCP clients search the same local library.

Your folders remain the source of truth; StashBase adds a rebuildable retrieval layer on top.

That is the core idea:

```text
Local files -> Convert -> Index -> Retrieve -> MCP -> Agents
```

---

## Try It

StashBase currently ships for **macOS (Apple Silicon)**, **Linux (x86_64 Debian/Ubuntu)**, and **Windows (x64)**.

### macOS

```bash
brew install --cask liliu-z/stashbase/stashbase
```

### Linux

Download the latest `StashBase-*-linux-amd64.deb` asset from [Releases](https://github.com/liliu-z/stashbase/releases), then install it:

```bash
sudo dpkg -i ./StashBase-*-linux-amd64.deb
```

### Windows

Download the latest `StashBase-*-win-x64.exe` installer from [Releases](https://github.com/liliu-z/stashbase/releases), then run it.

### First Run

> Don't have an OpenAI API key? Join our [Discord](https://discord.gg/zsRZH4PTq9) and ask for a test key.

1. Open an existing local folder, or create a new one from the native folder picker.
2. Add an OpenAI API key when prompted if you want semantic search. Without a key, files still open and keyword search still works.
3. Connect Claude, Codex, or another MCP client from **Settings -> MCP**.
4. Ask the Agent to search or use your local files.

Your library is opt-in: only folders you open in StashBase are indexed. You can remove a folder from the library at any time; StashBase clears its index but never deletes the folder from disk.

---

## What It Does

StashBase has two main jobs.

### Convert

Some local formats are awkward for Agents to read directly. StashBase keeps the original files in place and creates derived text only where it helps search or Agent reading.

| Format | Source file | Search / Agent text |
|---|---|---|
| Markdown | Read directly | Indexed directly |
| HTML | Read as original HTML | Clean text extracted for indexing |
| PDF | Original PDF stays on disk | Converted to derived Markdown |
| DOCX | Original DOCX stays on disk | Converted to derived HTML |
| Images | Original image stays on disk | OCR text extracted for search |

PDFs and DOCX files are different from HTML and images: for text reading, Agents use the derived Markdown or HTML. For HTML and images, the original file remains the primary reading object; the derived text is mainly for search.

### Index

StashBase builds semantic and keyword search over:

- Markdown and HTML text
- PDF-derived Markdown
- DOCX-derived HTML
- OCR text from images

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

The packaged MCP command is generated at:

```text
~/.stashbase/bin/stashbase-mcp
%USERPROFILE%\.stashbase\bin\stashbase-mcp.cmd  # Windows
```

Manual examples:

#### Claude Code

```bash
claude mcp add stashbase -- ~/.stashbase/bin/stashbase-mcp
# Windows:
claude mcp add stashbase -- %USERPROFILE%\.stashbase\bin\stashbase-mcp.cmd
```

#### Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stashbase": {
      "command": "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
    }
  }
}
```

#### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.stashbase]
command = "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
# Windows:
command = "C:\\Users\\YOUR_USER\\.stashbase\\bin\\stashbase-mcp.cmd"
```

#### URL-based clients (Streamable HTTP)

Clients that cannot spawn a local process (self-hosted agent platforms in Docker, web-based agents) can attach to the same tool surface at:

```text
http://127.0.0.1:8090/mcp                    # same machine
http://host.docker.internal:8090/mcp         # from a Docker container on this machine
```

Requests need `Authorization: Bearer <token>`; the token is generated on first use at `~/.stashbase/mcp-http-token`. The endpoint listens on the loopback interface only and is stateless (plain JSON-RPC over POST).

Restart the client after changing MCP config.

---

## Built-In Agent Panel

StashBase includes a built-in panel for running local Agent CLIs such as Claude Code and Codex against the current folder.

The panel uses the same library and MCP server as external clients. It does not create a separate knowledge base.

It is mainly a convenience layer:

- cwd is set to the current folder
- tool calls and file edits can be reviewed in the app
- sessions stay in the Agent CLI's normal storage
- external clients can use the same context through MCP

---

## Storage Model

Local files are the source of truth.

```text
~/.stashbase/config.json          # app-level config: library folders, MCP clients, embedder settings

<folder>/
  paper.pdf                       # user file

<appData>/derived.nosync/         # derived Markdown and extracted assets
<appData>/vector-store.nosync/    # Milvus Lite vector store
<appData>/folders/.../state/      # conversion failures and local app state
```

Removing a folder from the library clears StashBase's app-owned state for that folder. It does not delete the folder or its files from disk.

---

## Design Docs

The design docs are the source of truth for how the product is supposed to work:

- [Overview](design-docs/overview.md) - product motivation and principles
- [Architecture](design-docs/architecture.md) - system shape and module boundaries
- [Data Layer](design-docs/data-layer.md) - correctness, recovery, cleanup, and liveness rules

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

# Build distributable apps
pnpm dist
pnpm dist:win
pnpm dist:linux

# Optional: include the local PDF/OCR extractor sidecar
pnpm build:python-extract-sidecar
```

Before opening a PR:

```bash
pnpm exec tsc --noEmit
pnpm test:python
pnpm build
```

Debugging:

- Renderer logs: **View -> Toggle Developer Tools**
- Packaged-app server logs: `~/Library/Logs/StashBase/`
- Useful env vars: `STASHBASE_LOG=debug`, `STASHBASE_PYTHON=/path/to/python`, `STASHBASE_BUILD_EXTRACT=1`

API keys are configured in Settings, not environment variables.

---

## Publishing

Packaging is release-only. GitHub Actions builds and uploads macOS, Linux, and Windows installers from a release tag.

The release workflow:

1. Commit the code and version bump.
2. Push `main` and wait for `CI` to succeed for the version-bump commit.
3. Create and push the matching `vX.Y.Z` tag, then publish the GitHub Release for that tag.
4. Let the macOS, Linux, and Windows release workflows verify that exact tag commit and attach installers.

Release packaging fails closed when the tag commit has no successful `ci.yml` push run. If CI is still running, the release gate waits for it before packaging starts.

Local macOS fallback:

```bash
pnpm release:verify:mac
pnpm dist:brew
```

Do not commit packaged artifacts. Release outputs belong in `release.nosync/`.

---

## Status

Early alpha.

Supported today:

- macOS arm64
- Linux x86_64 Debian/Ubuntu
- Windows x64

Reasonably stable:

- Local folder library model
- Markdown preview with accessible footnotes, plus HTML, PDF, and image handling
- PDF extraction and image OCR, with persisted failures and retry
- Semantic and keyword search
- MCP server and client connectors
- Bounded file helpers for sandboxed Agents
- Built-in Claude Code / Codex panel

Still evolving:

- Agent panel polish
- Search filters and ranking controls
- Long-running conversion and recovery edge cases
- Packaging polish across platforms

---

## Contributing

Small focused PRs are preferred. Open an issue before larger changes so scope and direction can be discussed first.

---

## About

Built by Li Liu.

I work on [Milvus](https://github.com/milvus-io/milvus) at [Zilliz](https://zilliz.com), where I have spent the last few years building vector retrieval infrastructure for AI systems.

Coding with Agents already feels fluid inside IDEs. Local knowledge still does not.

StashBase is my attempt at the missing layer: local-file infrastructure that makes personal documents, notes, papers, and AI outputs continuously retrievable across Agent workflows.
