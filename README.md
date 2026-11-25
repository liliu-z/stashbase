# StashBase

**Keep your context in one place for recurring work.**

[![Website](https://img.shields.io/badge/website-stashbase.ai-0a66c2.svg)](https://stashbase.ai)
[![Release](https://img.shields.io/github/v/release/liliu-z/stashbase?label=release)](https://github.com/liliu-z/stashbase/releases/latest)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-support%20%26%20chat-5865F2.svg?logo=discord&logoColor=white)](https://discord.gg/zsRZH4PTq9)

StashBase is a free, open-source desktop workspace where your background, notes,
and instructions stay in local files, ready for Claude, Codex, Antigravity, or
StashBase Agent on every plan, post, or client project.

- **See and control your context.** Keep your background, past work, and
  instructions in ordinary local files you can review and edit, shared across
  Claude, Codex, Antigravity, and StashBase Agent.
- **Let your agent handle the upkeep.** Ask your agent to draft, update project
  notes, and organize material directly in your folder. Open `Review` on any
  edited Markdown document to `Keep` or `Undo` each change inline.
- **Build up resources you can reuse.** Save reusable instructions, slide decks,
  explainer videos, and project dashboards as templates so your agent builds on
  the layout and style you already have instead of starting from scratch.

## Product Preview

https://github.com/user-attachments/assets/ca53d973-4c6f-422d-98af-5cb1da82537e

Follow the step-by-step walkthrough: [How to Build in Public on LinkedIn](https://stashbase.ai/blog/build-in-public-on-linkedin/) · [All Tutorials →](https://stashbase.ai/tutorials/)

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

### Start a Project

1. **Open a folder or copy a template.** Open an existing local folder, create
   an empty project, or copy a template from the [Gallery](https://stashbase.ai/gallery/).
2. **Choose an agent.** Select Claude, Codex, or Antigravity and complete setup
   with your existing provider account. If you can't use any of them, the
   built-in **StashBase Agent** is available as a fallback. Sign in to StashBase
   for free monthly credits; [Plus and Pro](https://stashbase.ai/pricing/) add more.
3. **Work in Chat.** Ask your agent to draft a post, plan, or client update from
   your project context, or update your notes when details change.
4. **Review edits inline.** Open `Review` on any edited Markdown document to
   `Keep` or `Undo` each change.

Switch between `Chat` and `Documents` to browse your file tree and edit files
directly. Both views share the same project and keep unfinished work when you
switch.

See [Using StashBase](docs/using-stashbase.md) for everyday document and search workflows.

## Tutorials & Gallery

- **[Tutorials](https://stashbase.ai/tutorials/)** — Step-by-step walkthroughs
  for real workflows in StashBase, starting with
  [Build in Public on LinkedIn](https://stashbase.ai/blog/build-in-public-on-linkedin/).
- **[Gallery](https://stashbase.ai/gallery/)** — Explore project templates you
  can copy into StashBase, including
  [LinkedIn Ghostwriter](https://stashbase.ai/gallery/linkedin-ghostwriter/),
  [Client Update Writer](https://stashbase.ai/gallery/client-update-writer/),
  and [Resume Builder](https://stashbase.ai/gallery/resume-builder/).

## Your Files and Your Data

Your documents stay in local project folders. Removing a project from StashBase
doesn't delete its files. Browsing, editing, previews, and keyword search work
without an account. PDF and Word text extraction and OCR run locally, with required
components downloaded on first use.

Agent conversations send your prompts and relevant context to model services.
Claude, Codex, and Antigravity use your provider accounts; the StashBase Agent connects
through StashBase's hosted model gateway, which calls Anthropic directly for
Claude models (default: Claude Haiku 5.5) and uses OpenRouter for other hosted models.

**Search by meaning** requires your own OpenAI or OpenRouter key in
`Settings → Advanced → Search by meaning`. It sends source text and search
queries to your chosen embedding provider. StashBase Agent credits don't cover
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
