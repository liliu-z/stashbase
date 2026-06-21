# Overview

StashBase is a local-first Persistent Memory Layer for both humans and Agents.
The user decides what is worth remembering. The Agent handles organizing, maintaining, and retrieving.
Over time, this content gradually accumulates into a personal knowledge base that keeps growing, without requiring the user to invest ongoing maintenance effort.

---

# 1. Problem

Many people have tried to build a "second brain"—a personal knowledge base that accumulates over the long term and can be reused continuously—but very few actually stick with it.
From seeing a piece of content, to saving it, organizing it, and building connections, then later finding it again and using it, the whole process requires ongoing effort.

While existing note-taking and knowledge-management tools have optimized some of these steps, most still default to making the user responsible for maintaining the knowledge structure.
The result is often this: the knowledge base becomes a document warehouse, not a memory system that keeps growing.

---

# 2. Why Now

## 2.1 Agent workflows are already proven in the coding scenario

Claude Code and Codex have already shown that, under user supervision, an Agent can maintain a complex, structured, continuously evolving codebase.
A knowledge base is essentially also a long-term evolving structured system. So this is the natural next scenario for Agent workflows to extend into.

## 2.2 Content is shifting from Human-authored to Agent-authored

Karpathy's proposed LLM Wiki, and the Claude Code team's "HTML is the new Markdown," both point to the same trend: more and more content will be generated, organized, and maintained by Agents.
Once Agents become the primary authors, the knowledge base is no longer just a note-taking tool. It gradually becomes a workspace continuously maintained by Agents.

---

# 3. Product Principles

## Agent-native

The user expresses intent. The Agent does the work.
Any design that pushes the maintenance burden back onto the user is rejected.

## Sees Only What You See

The system's scope of visibility is aligned with the user's. It can only process what you can see. What you can't see, it won't fetch on its own.
Any design that bypasses the user's field of view to actively scrape content is rejected.

## Local-first

Data is stored locally by default. Cloud services are an optional capability, not a prerequisite for use.
Any core capability that can only run by depending on the server is rejected.

## User-owned

Knowledge should remain portable, offline-capable, and cross-model usable over the long term.
Any design that locks the user's Context into a single platform is rejected.

---

# 4. Solution

StashBase treats Memory as a long-term asset shared by humans and Agents.
Not all information becomes Memory. Only content that the user has seen and actively decided to keep enters persistent memory.

We call the user's active act of saving Stash. A Bookmark saves a link; a Stash saves the content itself.
Once it has been Stashed, the content belongs to the user. It can be retrieved, reused, and migrated, and no longer depends on the original platform.

The user only needs to do two things:
1. Browse information
2. Decide what is worth keeping

Everything else is left to the Agent. The Agent handles organizing, building connections, maintaining structure, updating the index, and retrieving relevant memory when needed.
This is also the foundation on which the persistent memory layer rests.

---

# 5. Product

## 5.1 What StashBase Is

StashBase is a persistent memory layer delivered as a desktop application.
Content is stored on the local disk in open formats such as HTML, Markdown, and PDF.

Users can create multiple Spaces.
Retrieval can either cover the entire knowledge base or be scoped to a single Space.

The entire knowledge base is exposed externally through MCP by default.
AI Clients such as Claude, ChatGPT, and Codex can all access it directly.

### A typical scenario

The user imports a paper into a Research Space.
The Agent automatically generates a summary, extracts the core points, connects to existing materials, and writes the result back to the knowledge base.
Weeks later, whether asking a question in Claude, ChatGPT, or Codex, the relevant content can be automatically retrieved and referenced.

---

## 5.2 Core Capabilities

### Stash

Stash is the act of adding content to the memory layer. Content can come from:
* Files
* Folders
* GitHub Repos
* Screenshots

Only content the user actively saves enters the memory layer.

## Retrieval

Uses Hybrid Retrieval.
Vector search handles semantic relevance. BM25 handles keyword matching.

## MCP Exposure

The entire knowledge base is exposed by default as an MCP Server.
Any MCP-compatible AI Client can access it directly.

## Maintenance

Maintenance rules are defined in `STASHBASE.md`. The Agent completes knowledge maintenance in sync while carrying out the user's tasks.
Maintenance is not an extra process. It is a natural byproduct of everyday work.

---

## 5.3 Vision-first Capture

StashBase provides two content entry points:
- For local content such as files, folders, and Repos, import the raw files directly.
- For non-local content such as web pages and Apps, use visual capture.

The system records the view the user sees, then uses a multimodal model to reconstruct structured text. This approach does not depend on website interfaces, nor on export capabilities.

Compared with traditional parser-based approaches, it has several advantages:
* Universal, not dependent on site structure
* Zero maintenance, no need to continuously adapt to website redesigns
* What you see is what you get, preserving the content the user actually saw

The principle behind it is simple: **Memory begins with what the user sees.**

---

## 5.4 Runtime Model

### Desktop-first Runtime

The desktop application is the product's primary form.

### Built-in Agents

Claude Code and Codex are built into the product.
On launch, they automatically load the current Space's Context and Skills.

### MCP Always Available

Even when the GUI is closed, the MCP Server keeps running.
The knowledge base can still be accessed by external AI Clients.

### No Background Autonomy

The product does not continuously run an Autonomous Agent in the background.
Maintenance happens during the collaboration between the user and the Agent, not by continuously consuming Tokens in the background.

---

### V1 Scope

The initial release includes:
* macOS desktop application
* Linux x86_64 Debian package
* Space management
* HTML / Markdown / PDF / image / folder import (clone the repo yourself, then import it as a folder)
* Hybrid Retrieval
* MCP Server
* Claude Code & Codex integration

The subsequent roadmap includes:
* Windows
* Cloud sync
* Mobile access
* Team collaboration

These capabilities will not change the product's core model.

---

# 6. Competitive Landscape

The real difference is not in features. It is in: **who is responsible for maintaining the knowledge structure.**

## Human-maintained Systems

### Notion

AI handles editing. The user maintains the structure.

### Obsidian / Roam / Logseq

Knowledge organization relies primarily on manual maintenance by the user.

### NotebookLM

Knowledge exists mainly as AI Context and is bound within the Google ecosystem.

## Agent-assisted Development Tools

### Claude Projects / ChatGPT Projects / Gemini Gems

Context is confined within a single Project. It cannot be reused across AI Clients, nor migrated over the long term.

### Cursor / Claude Code

Proved the viability of the Agent + Retrieval workflow. But the core goal is still software development.

## AI-native Knowledge Tools

### Mem / Reflect / Heptabase / Capacities

To Do

### Cabinet

To Do

---

# 7. Initial Users

The first users are developers and Technical Founders who already use Claude Code, Codex, and Cursor over the long term.
They are already used to collaborating with Agents, and already used to accumulating Context.
StashBase simply extends this way of working from code to personal knowledge.

---

# 8. Go-to-Market

Early growth comes mainly from the Agent community.

Core channels include:
* GitHub
* Homebrew
* YouTube Workflow Demo
* Reddit
* X
* MCP Directory

The core judgment is simple: if Agents can significantly lower the cost of maintaining knowledge, users will be more willing to accumulate and reuse Context over the long term.

---

# 9. Business Model

The Core is permanently open source (Apache 2.0). Revenue comes from services, not feature licensing.

Possible commercialization directions include:
* Cloud sync
* Hosted KB
* Multi-device access
* Team collaboration
* Shared Space

Once persistent memory extends from the individual to the team, it naturally evolves into a shared Context Layer.

The long-term model is closer to:
* Plausible
* PostHog
* Sentry

That is, open-source core + hosted services.

In the future, it may also give rise to:
* A template marketplace
* An Agent Skills marketplace
* A Knowledge Workflow ecosystem
