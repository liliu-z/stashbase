# StashBase

**Turn local files into Agent-ready context.**

[![Website](https://img.shields.io/badge/website-stashbase.ai-0a66c2.svg)](https://stashbase.ai)
[![Release](https://img.shields.io/github/v/release/liliu-z/stashbase?label=release)](https://github.com/liliu-z/stashbase/releases/latest)
[![Status](https://img.shields.io/badge/status-early%20alpha-orange.svg)](#status)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-support%20%26%20chat-5865F2.svg?logo=discord&logoColor=white)](https://discord.gg/zsRZH4PTq9)

Much of your best context already lives in local files: notes, papers,
contracts, project data, scanned documents, and recordings. Open a folder in
StashBase and work with that material in place:

- 📂 **Work in place:** browse, read, and edit supported files without moving them into a proprietary workspace.
- 🔎 **Prepare and search:** extract difficult formats, search exact text immediately, and optionally add meaning-based retrieval with AI Index.
- 🤖 **Use with Agents:** run Claude Code or Codex in the built-in Chat, or share the same authorized library with other MCP clients.

Your folders remain the source of truth; StashBase adds a search index that can be rebuilt from them.

The core idea:

```text
Local files -> prepared evidence -> retrieval -> Agents
```

---

## 🚀 Demo

Open this repo in StashBase and ask the built-in Agent: **How is this project designed?**

![StashBase demo: opening local design docs and asking the Agent about architecture and product direction](assets/readme/demo.gif)

---

## 💡 Try It

StashBase's primary platforms are **macOS 12+ (Apple Silicon)** and **Windows 10+ (x64)**. A community-supported Linux build is also available for **x86_64 Debian 12+ / Ubuntu 22.04+**.

### macOS

Apple Silicon Macs running macOS 12 or later can install with Homebrew:

```bash
brew install --cask liliu-z/stashbase/stashbase
```

Or download the `StashBase-*-mac-arm64.dmg` from [Releases](https://github.com/liliu-z/stashbase/releases), drag the app to **Applications**, and open it there. Published macOS artifacts are signed with Apple Developer ID and notarized by Apple.

### Windows

1. Download the latest `StashBase-*-win-x64.exe` installer from [Releases](https://github.com/liliu-z/stashbase/releases)
2. Run the installer
3. **If Windows SmartScreen appears:**
   - Windows SmartScreen is a security feature that warns about files from the internet. Since you've confirmed the installer came from the official GitHub Releases page, it's safe to proceed
   - Click **More info** → **Run anyway**
4. Follow the installer prompts to complete installation

**To update**: Quit StashBase, then run the newer installer over the existing installation.

**To uninstall**: Open **Settings → Apps**, then select **StashBase** under **Installed apps** (Windows 11) or **Apps & features** (Windows 10).

### Linux

For Debian 12+ or Ubuntu 22.04+ on x86_64, download the latest `StashBase-*-linux-amd64.deb` asset from [Releases](https://github.com/liliu-z/stashbase/releases), then install it with `apt` so any required system packages are resolved:

```bash
sudo apt install ./StashBase-*-linux-amd64.deb
```

Run the same command with a newer package to update. To remove StashBase, run `sudo apt remove stashbase`.

For a portable build, download `StashBase-*-linux-*.AppImage`, make it executable with `chmod +x`, and run it directly.

### First Launch

The first window opens with no folder selected and one reusable blank Chat.

1. **Enable AI Index**: Sign in to StashBase for free monthly AI Index usage,
   or use your own OpenAI/OpenRouter key. To continue without it, choose **Skip
   AI Index for now**; exact text search and local file work remain available.
2. **Ask how StashBase works**: In the Chat that is already open, ask **“How do
   I use StashBase?”** It starts against the whole Library, including Start
   Here. StashBase uses a supported system Claude Code or Codex runtime when
   available; if it is missing, installation waits for **Install and
   continue**. Agent provider login is separate from StashBase sign-in and AI
   Index configuration.
3. **Open source files when you need them**: On a brand-new empty default
   folder home, StashBase adds **👋 Start Here** to the Library without opening
   it automatically. Open it from the titlebar's **Library** menu, or use **Add
   Folder…** to work with one of your own local folders. Selecting a source
   brings it alongside the same conversation.

StashBase processes only folders in its Library. Apart from the bundled Start
Here introduction, folders join only when you explicitly add or open them. You
can remove a folder at any time; StashBase clears its app-owned state but never
deletes your files from disk.

Transcription and external MCP access can be configured later when you need
them. Neither is required to begin browsing local files.

### Updating and Uninstalling

- **Updates**: Quit StashBase and run the newer installer. Your library and settings are preserved
- **Uninstalls**: On macOS, remove StashBase from Applications; on Windows or Linux, follow the platform-specific removal steps above. Your local files are never deleted

### Troubleshooting Installation

**Installer won't start on Windows**
- Make sure the file extension is `.exe` (not `.msi` or other formats)
- Try running the installer as Administrator (right-click → Run as administrator)
- If antivirus software blocks it, temporarily disable it and try again (it's safe to do so from official releases)

**macOS blocks or rejects the downloaded app**
- Delete that copy and download the current DMG again from the official Releases page
- Do not bypass Gatekeeper for an artifact that still reports a signing or malware-verification problem; report the StashBase version and macOS version in the Discord community

**App won't launch after installation**
- Try restarting your computer
- Uninstall and reinstall the latest version
- Check the [Discord community](https://discord.gg/zsRZH4PTq9) for help

**Out of disk space errors**
- Your library index needs space proportional to your files. Add more disk space or remove large files
- Remove the folder from the Library to clear its StashBase-owned index and derived data. Your source files are never deleted

**Can't find installed app**
- On Windows: Press the Windows key and search for "StashBase"
- On macOS: Open Finder → Applications → look for StashBase
- On Linux: Run `stashbase` from terminal or find it in your applications menu

---

## Document Workbench

StashBase works directly with ordinary local folders. The Files sidebar,
persistent tabs, Quick Open, and format-specific viewers keep source work in
the same workspace as Chat.

Use **File → New Window** or Cmd/Ctrl+Shift+N to keep different folders and
tools side by side. Window close follows VS Code's platform shortcuts;
Cmd/Ctrl+W continues to close the active document tab.

Use Cmd/Ctrl+O to open a source file in the active folder. The Command Palette
opens with Cmd/Ctrl+Shift+P or F1 (or by typing `>` in Quick Open) and exposes
safe application actions with their existing safeguards.

---

## Search and Preparation

The local RAG layer has two core jobs: prepare files and index their contents.

### Prepare

Some formats need preparation before their contents can be searched. StashBase keeps the original files in place and creates derived text only where needed for search and Agent access.

| Format | Visible source | Indexed text |
|---|---|---|
| Markdown | The Markdown file | Source text |
| HTML | The HTML file | Clean text extracted from the HTML |
| JSON | The JSON file | Source-preserving tree and exact source text |
| PDF | The original PDF | Derived Markdown |
| DOCX | The original DOCX | Derived HTML |
| Images | The original image | OCR text |
| Audio and video | The original media | Audio track transcribed locally to timestamped Markdown |

For PDF, DOCX, audio, and video, Agents read the derived text while the original remains the visible source file. Audio and video play directly when supported; otherwise, StashBase creates a compatible local audio preview. Large files dragged into the app stream to disk instead of being held entirely in memory. See [Architecture](design-docs/architecture.md) and [Preparation](design-docs/design/preparation.md) for the product and system contracts.

Preview, Workbench editing, retrieval text, Agent reads, and file writes are
separate capabilities. See the canonical
[Format Capability Matrix](design-docs/design/documents.md#format-capability-matrix)
for the current per-format boundary.

Audio and video transcription is optional. Download a local speech model from
**Settings → Transcription** when you need it. Small (465 MiB) is the default;
Tiny (74 MiB) and Base (141 MiB) are lighter choices. Transcription runs on
your machine with no transcription API cost.

### AI Index

Sign in to StashBase for free monthly AI Index usage, or configure your own
OpenAI/OpenRouter key in **Settings → AI Index**. An OpenAI restricted key
needs access only to embeddings with `text-embedding-3-small`; model-list
access is not required. Exact search needs neither option.

StashBase builds its AI Index and exact text search over:

- Markdown, HTML, and raw JSON text
- PDF-derived Markdown
- DOCX-derived HTML
- OCR text from images
- timestamped transcripts from audio and video

Search results point back to the user-visible source file, not hidden app data.

Hosted indexing and meaning-based queries share one monthly token allowance.
The avatar menu shows the remaining percentage and reset date. If the hosted
allowance runs out, Exact search and all local file workflows keep working.

Background preparation is intentionally quiet. Browsing a folder should feel like browsing files, not watching an indexing job. If preparation fails, StashBase shows a lightweight failure marker and lets you retry. Readiness matters most when you search, so that is where StashBase shows how much of your content is ready.

---

## MCP

MCP is the main interface between StashBase and Agents.

While the StashBase app is running, a local MCP server makes the same library available to external clients and the built-in Agent panel.

Common tools:

- `library_info` - return the default folder home, opened folder paths and names, and embedder status. Folder purpose, organization rules, and durable Agent instructions belong in the visible, user-owned `AGENTS.md` instead of separate library metadata.
- `search_library` - search the library in semantic (default) or keyword mode, optionally filtered by source type. Semantic mode may search the whole library; exact keyword mode works before AI Index is set up and requires a folder or path-prefix scope.
- `reindex` - reconcile disk changes and make updated files searchable.
- `create_project` - create and register a new project folder beneath an authorized location.

StashBase also exposes bounded file helpers for opened folders:

- `list_directory`
- `read_file`
- `write_file`
- `edit_file`
- `move_file`
- `delete_file`

These helpers exist for Agent clients that run in a sandbox and cannot directly access the user's host files. They are not a general-purpose filesystem API.

### Connect a Client

The built-in chat agents (Claude Code, Codex) connect automatically. For any other MCP-compatible client, copy the standard configuration or the server connection details from **Settings → MCP** and register them in that client.

For setup examples, URL-based clients, Docker access, ports, CORS boundaries, and token rotation, see [MCP configuration](docs/mcp-configuration.md).

---

## Built-In Agent Chat

StashBase includes a built-in chat for running local Agent CLIs such as Claude
Code and Codex against the whole library or one selected folder. Chat fills the
workspace until you open a document, then adapts into a side panel so the
conversation and source stay visible together.

The chat is a convenient client of the same MCP server, not a separate
knowledge base. It adds:

- Sessions keep their chosen Library or folder scope even when the window
  switches folders.
- New Chat reuses a completely blank conversation when possible; Codex is the
  first default and later chats use the Agent you last selected.
- Tool calls and file edits can be reviewed in the app.
- Session history stays in the Agent CLI's normal storage.
- Agent replies render GFM and offline LaTeX math without changing the copied
  or persisted Markdown source.
- `@` mentions find files and folders with forgiving workspace-path search;
  selecting one inserts only its workspace-relative path.

Claude Code and Codex keep their normal provider login and native history.
Those credentials are independent from StashBase account sign-in and the
embedding source selected for AI Index.

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

## Design and Maintenance

StashBase is also an experiment in human-directed, AI-first software
development. Humans retain control of product direction, engineering Seams,
trust decisions, and releases. AI helps explore designs, implement changes,
maintain documentation, produce evidence, and review diffs.

The goal is not autonomous code generation. It is a closed engineering loop in
which intent, contracts, implementation, and evidence remain traceable:

```text
intent → design → engineering contract → implementation → evidence
   ↑                                                     │
   └──────────────── diff-first review ──────────────────┘
```

Product acceptance runs forward from a
[Journey](design-docs/user-journeys.md) through
[Journey Coverage](code-review/journey-coverage.md) to exact evidence. Diff
review runs backward through
[Reverse Traceability Review](code-review/README.md#reverse-traceability-review)
to an owning engineering contract and either an affected Journey or an
explicit cross-cutting rationale.

Start with the [Project Maintenance Model](MAINTENANCE.md) for the working
method, then descend into the product design and engineering contracts:

- [Project maintenance model](MAINTENANCE.md) - human and AI responsibilities and the maintenance loop
- [Design docs guide](design-docs/README.md) - product design and extension model
- [Overview](design-docs/overview.md) - product thesis
- [Principles](design-docs/principles.md) - durable decision rules
- [Architecture](design-docs/architecture.md) - system boundaries and invariants
- [Product direction](design-docs/product-direction.md) - intended product shape
- [Product scenarios](design-docs/product-scenarios.md) - high-level user motivations
- [User journeys](design-docs/user-journeys.md) - observable workflows and stable coverage IDs
- [Glossary](design-docs/glossary.md) - shared product language
- [Code review contracts](code-review/README.md) - maintainer invariants and validation maps

---

## Build From Source

For contributors and developers running StashBase locally from source.

### Linux prerequisites (Ubuntu / Debian)

Install Node.js 22.12+, pnpm, Python 3.10+, and the native build tools used by the packaged sidecars:

```bash
sudo apt install build-essential binutils cmake curl git nasm pkg-config python3 python3-venv xz-utils
```

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

# Optional: include the local PDF/OCR extractor sidecar
pnpm build:python-extract-sidecar
```

Before opening a PR:

```bash
pnpm check
```

Packaging is release-only and runs from a validated release tag. Maintainers
should follow the [release pipeline](code-review/release-pipeline.md) instead
of creating ad hoc distributable builds.

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
- Markdown, HTML, JSON, PDF, and image preview
- PDF extraction, image OCR, and local audio and video transcription, with persisted failures and retry
- AI Index and exact text search
- MCP access for built-in and externally configured clients
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

For substantial design, implementation, or review work, follow the
[Project Maintenance Model](MAINTENANCE.md).

Not sure where to start? Pick something from [Where We Need Help](#where-we-need-help), or open [`design-docs/`](design-docs/) in StashBase and ask the Agent — or just ask us.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development, validation, and release-maintainer notes.

---

## About

StashBase is an independent open-source project built by [Li Liu](https://github.com/liliu-z), who works on [Milvus](https://github.com/milvus-io/milvus) at [Zilliz](https://zilliz.com) and brings years of vector-retrieval experience to making local files searchable in Agent workflows.
