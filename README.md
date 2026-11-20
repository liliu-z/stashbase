# StashBase

**Stash your notes and sources. Write with your agent.**

[![Website](https://img.shields.io/badge/website-stashbase.ai-0a66c2.svg)](https://stashbase.ai)
[![Release](https://img.shields.io/github/v/release/liliu-z/stashbase?label=release)](https://github.com/liliu-z/stashbase/releases/latest)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-support%20%26%20chat-5865F2.svg?logo=discord&logoColor=white)](https://discord.gg/zsRZH4PTq9)

StashBase is an open-source, local knowledge base for writing with AI agents.
Your notes, PDFs, and docs stay in a folder on your computer, and Claude, Codex,
or Antigravity works inside it with you.

- 📝 **Side by side with your agent.** Your docs stay open beside the
  chat. When your agent edits one, `Review` shows each change inside the prose,
  so you can undo or keep it.
- 🗂️ **Your knowledge base, kept up to date.** Ask your agent to file new material,
  update your notes, and link them back to their sources. It reads PDFs, Word
  documents, and scans too, with the text extracted on your computer.
- 💬 **Bring the agent you already use.** Claude, Codex, and Antigravity run on
  your existing accounts, and StashBase charges nothing for them.

## Product Preview

https://github.com/user-attachments/assets/4ba282a3-85d2-4a08-b7af-562a1e71e716

## Get Started

**macOS 12+ (Apple Silicon and Intel)** and **Windows 10+ (x64)** are the primary
platforms. Linux x86_64 Debian 12+ / Ubuntu 22.04+ is community-supported.
On Intel Macs, local search and PDF/image text extraction require macOS 15+;
older supported systems can still open projects and edit files. Agent runtime
requirements may vary.

On macOS, install with Homebrew:

```bash
brew install --cask liliu-z/stashbase/stashbase
```

Or [download the latest release](https://github.com/liliu-z/stashbase/releases/latest):

| Platform | Download |
|---|---|
| macOS Apple Silicon | `StashBase-*-mac-arm64.dmg` |
| macOS Intel | `StashBase-*-mac-x64.dmg` |
| Windows x64 | `StashBase-*-win-x64.exe` |
| Linux x86_64 | `StashBase-*-linux-amd64.deb` or `.AppImage` |

See [Installation](docs/installation.md) for platform steps, updates, and
troubleshooting.

### Start Writing

1. **Enter a project.** Open or create a local folder.
2. **Choose an agent.** Select Claude, Codex, or Antigravity and complete its
   setup with your provider account. If you can't use any of them, the built-in
   **Default Agent** is available as a fallback. Sign in to StashBase for its
   free monthly credits; [Plus and Pro](https://stashbase.ai/pricing/) add more.
3. **Talk it through.** Try: “I want to write a LinkedIn post about what I
   shipped this week. Interview me before drafting.”
4. **Draft and revise.** Ask your agent to draft the article, then review and
   refine it.

Switch between `Chat` for the conversation and `Documents`, a file tree and
editor that works like an IDE, but for writing. Both modes share the project and
keep unfinished work when you switch.

See [Using StashBase](docs/using-stashbase.md) for everyday document and search workflows.

## Explore the Gallery

Explore how people organize files and write with agents. Copy a ready-made
project or reuse its prompt to try a workflow with your own material.

For example, in [Resume Builder](https://stashbase.ai/gallery/resume-builder/)
the agent interviews you first, then writes a resume that shows what you
actually did and tailors it to each job.

[Explore the Gallery →](https://stashbase.ai/gallery/)

## Your Files and Your Data

Your documents stay in local project folders. Removing a project from StashBase
doesn't delete its files. Browsing, editing, previews, and keyword search work
without an account. PDF and Word text extraction and OCR run locally, with required
components downloaded on first use.

Agent conversations send your prompts and relevant context to model services.
Claude, Codex, and Antigravity use your provider accounts; the Default Agent connects
through StashBase's hosted model gateway, which sends requests through OpenRouter
to Claude Haiku 5.5 by default.

**Search by meaning** requires your own OpenAI or OpenRouter key in
`Settings → Advanced → Search by meaning`. It sends source text and search
queries to your chosen embedding provider. Default Agent credits don't cover
this service.

Packaged builds and source runs share usage statistics and error diagnostics by default, excluding document
and conversation content. You can turn this off in
`Settings → General → Privacy`. See [Usage statistics](docs/usage-statistics.md) for details.

## Connect External Agents

Agents in the built-in Chat connect to StashBase's tools automatically.

To use an external MCP client, keep StashBase running and copy the connection
configuration from `Settings → Advanced → External apps (MCP)` into that
client. It can read, search, and edit supported files in the project you select.

See [MCP Configuration](docs/mcp-configuration.md) for client examples,
transports, and access settings.

## Build From Source

Install Node.js 24.11.0+, pnpm, and Python 3.13 with venv support.
See [Local Development](CONTRIBUTING.md#local-development) for platform dependencies.

```bash
git clone https://github.com/liliu-z/stashbase
cd stashbase
pnpm install
pnpm setup:python

env -u ELECTRON_RUN_AS_NODE pnpm dev
```

The launch command above uses POSIX shell syntax to clear an inherited
`ELECTRON_RUN_AS_NODE`. On Windows, clear that variable in your shell before
running `pnpm dev`.

See [Contributing](CONTRIBUTING.md) for OCR setup, testing, and release guidance.

## Contributing

StashBase is also an experiment in human-directed, AI-first development.
Humans own product direction and trust decisions; AI helps connect design,
implementation, review, and evidence. The
[Project Maintenance Model](MAINTENANCE.md) describes that working loop.

Small focused PRs are preferred. Open an issue before larger changes so scope
and direction can be discussed first.

- [Contributing guide](CONTRIBUTING.md): development and validation.
- [Product design](design-docs/README.md): intent, workflows, and contribution areas.
- [Engineering contracts](code-review/README.md): ownership, invariants, and review.

## Feedback

[Report an issue](https://github.com/liliu-z/stashbase/issues) or
[join the Discord community](https://discord.gg/zsRZH4PTq9) for support and discussion.

## About

StashBase is an independent open-source project built by
[Bing Wu](https://www.linkedin.com/in/bingwu-cmu/) and
[Li Liu](https://www.linkedin.com/in/cmuliliu/).

Licensed under [Apache 2.0](LICENSE).
