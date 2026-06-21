# Architecture

> This document is StashBase's unified system design document. For product motivation, principles, and competitive judgment, see [overview](overview.md); this document only covers **how the system is constructed**—module boundaries, data flows, and the essential technical details and design decisions of each module. Cross-module tradeoffs and open questions about the underlying data's ownership, consistency, sync, export, and recovery are split out into [data-layer](data-layer.md).

---

# 1. System Overview

StashBase is a local persistent memory layer for both humans and Agents:

- Users actively **stash** content worth remembering
- The system stores content locally in open formats, builds an index, and exposes the entire knowledge base to any AI client via **MCP**
- Agents use these memories to do work, and **continuously maintain** the memories during that work

```text
        ┌──────────────────────────────────────────────┐
        │                                              ▼
User → Stash → Storage → Indexing → Retrieval → MCP → Agents → Maintenance
        ▲                                                          │
        └──────────────────────────────────────────────────────────┘
```

## 1.1 Principles → architecture mapping

The four product principles in [overview](overview.md) directly constrain the system design:

| Principle | Architectural landing point |
|-|-|
| **Agent-native** | Maintenance is handed to the agent ([§9](#9-maintenance)); the maintenance burden is not pushed back onto the user |
| **Sees Only What You See** | Only index content the user actively stashes ([§4](#4-ingestion-stash)); no background crawling; only watch the currently open space, inactive spaces are not touched |
| **Local-first** | The file system is the source of truth ([§3](#3-storage)); data is entirely local, Milvus Lite has zero server side. **Two deliberate cloud tradeoffs**—core capabilities do not depend on a server, but two enhancement features explicitly depend on a cloud key and are disabled without one (no low-quality degraded fallback is offered): ① embedding goes through OpenAI (the only embedder, **a local embedder is explicitly not done**—quality / size / maintenance are all not worth it, settled 2026-06); without a key, the only things disabled are **embedding indexing and semantic retrieval**—file read/write, preview, and keyword retrieval (ripgrep, not via the index) continue as usual ([§5.3](#53-embedding)); ② screen recording → text uses Gemini video understanding (§4.4.1); without a key, the recording entry directly prompts to configure—it does not record, does not upload (since 2026-06 the local frame-extraction fallback was removed: the promise of screen recording is high-quality structured notes, and a low-quality fallback dilutes it). Extraction for screenshots / dragged-in images · PDFs is fully local throughout |
| **User-owned** | Stored on disk in open formats, derived data is rebuildable; memories are reused across models via MCP ([§7](#7-mcp)), not locked to a single platform |

## 1.2 Runtime topology

One installation corresponds to one desktop app + one knowledge base (KB). Process composition:

```text
┌─────────────────────────── Electron app ───────────────────────────┐
│  Renderer (Web UI)  ── HTTP ──  Node main process                   │
│                                   │  ├─ KB MCP server (stdio)        │
│                                   │  └─ direct filesystem read/write of space content │
│                                   ▼                                  │
│                       Python daemon (MFS) ── Milvus Lite (store.nosync/) │
│                                   ▲                                  │
│  structured panel ──/ws/agent──> Claude Agent SDK ── spawn ── claude │
└─────────────────────────────────────────────────────────────────────┘
```

- **Node main process** (TypeScript): UI backend, filesystem operations, all format-related preprocessing, MCP server.
- **Python daemon** ([MFS](https://github.com/zilliztech/mfs)): its sole responsibility is chunk + embed + store + search, **it does not touch any format logic**. Node ↔ daemon goes over the **stdio JSON line protocol** (request `{id, op, args}`, response `{id, ok, result}`). The daemon executable resolution order (`server/mfs-daemon.ts:resolveDaemonBinary`): `STASHBASE_DAEMON_BIN` env → the PyInstaller binary inside the packaged app → in dev, directly run `python/stashbase_daemon.py` + `python/.venv.nosync` (in dev mode `resolveDaemonBinary` / `resolvePythonBin` **deliberately skip** any packaged artifacts inside the project directory—both leftover sidecar builds *and* a stray `python/.venv`—to avoid a frozen old binary or an externally copied-in bad venv silently shadowing the source code; in dev, `RESOURCES_ROOT` falls back to `PROJECT_ROOT`, so the "packaged" candidate collides with identically-named artifacts inside the project, making this guard necessary). The interpreter probe runs synchronously with a 30s timeout, to prevent a venv's `import` deadlock from pinning the server event loop. The daemon processes ops serially; **Milvus Lite holds an exclusive single-process file lock**—process topology, lock ownership, call timeouts, and liveness guarantees are covered together in [data-layer §8](data-layer.md#8-concurrency-and-liveness).
- **Agent CLI**: Claude Code / Codex, spawned on demand by the Claude Agent SDK—it probes the user's global installation, **not bundled with the package** (see [§8](#8-built-in-agents)).
- **The MCP server is a Node process**, not the daemon—the protocol layer is separated from the indexing layer.

Even when the GUI is closed, the knowledge base can still be accessed by external AI clients: when the MCP host discovers the server is not running, it **brings up a headless server** (no window, the same `:8090`, see §7.2)—so there may be a server process in the background used by MCP rather than started by the user; this is the implementation of the "queryable even when the app is closed" promise, not a bug. The product **does not run autonomous agents in the background**.

## 1.3 Module map

A one-sentence responsibility + owning chapter for each file; this is the main entry for "where things are" (see the corresponding chapter for details).

**`server/` core**:

| Module | Responsibility | Chapter |
|-|-|-|
| `index.ts` | Process entry: middleware, CSP, mount routes, listen, `/ws/agent` upgrade | §1.2 |
| 🔴 `space.ts` | kbRoot/space/window context (AsyncLocalStorage), path vocabulary conversion (`toKbRel`/`fromKbRel`), KB root migration, first-launch builtin space seeding (`seedBuiltinSpace`) | §2 |
| `files.ts` | In-space file CRUD primitives (safe-path, atomic write) | §3 |
| 🔴 `state.ts` | Global singleton (indexer instance), space-open serial queue + watchdog | [data-layer §8.3](data-layer.md#83-lifecycle-state-machines) |
| `watcher.ts` | `treeVersion` counter (the fs.watch layer was removed, filename retained) | §4.1 |
| 🔴 `sync.ts` | Single reconcile gear (`syncIndex` full content-hash diff), **context-free** (space passed explicitly) | §4.6 |
| 🔴 `indexer.ts` / `indexer.mfs.ts` | Thin `Indexer` interface + MFS implementation (HTML flattening, empty-text short-circuit, per-space cache) | §5 |
| 🔴 `mfs-daemon.ts` | Daemon process management: spawn/respawn, generations, stdio protocol, call and ready timeouts, bindings replay | §1.2 / [data-layer §8.3](data-layer.md#83-lifecycle-state-machines) |
| 🔴 `html.ts` | `analyzeHtml` (heading id injection + indexable plaintext + iframe scroll-bootstrap injection) | §4.1 / §10.1 |
| `format.ts` | The single source of format detection (structured md/html vs unstructured pdf/image, derived-note naming) | §4.1 |
| `indexable.ts` | Index admission rules: excluded directories, size upper bound, no-extractable-text determination, reserved-filename exclusion | §5.5 |
| 🔴 `conversion.ts` / `conversion-status.ts` / `state-db.ts` | Conversion orchestration + direct push of derived notes into the index; failed persistence (SQLite), in-flight in memory | §4.3 / [data-layer §3.3](data-layer.md#33-the-partial-failure-state-machine) |
| `pdf.ts` / `image.ts` / `gemini-video.ts` | PDF / image converter orchestration (isomorphic) + screen-recording Gemini path | §4.3-4.4 |
| `python-host.ts` | Extractor subprocess spawn (dev venv / packaged binary switch) | §4.4 |
| 🔴 `import-folder.ts` / `fs-move.ts` | Space-level import, cross-filesystem safe-move primitives | §4.7 / §2.4 |
| `resources.ts` | Extract inline `data:` resources into a `_files/` bundle | §4.2 |
| `links.ts` | On rename/move, rewrite relative links across the whole space that point to the moved item (**rewrites user files**—touching it requires tests) | §10.1 |
| `rename-helpers.ts` | Shared "disk first, index second, rollback on failure" mechanism for renaming | §5.6 |
| `kb.ts` | KB-level `STASHBASE.md` rule read/write + `kb_info` compilation | §7 / §9 |
| `mcp-host.ts` | Proxy host for per-space additional MCP servers | §7.5 |
| `agent.ts` / `terminal.ts` / `claude-settings.ts` | Structured panel SDK session / CLI probe registration / space-level Claude settings seeding | §8 |
| `http.ts` / `log.ts` | Route shared pieces (error envelope, space gate, windowId extraction) / logging | — |
| 🔴 `stale-lock.ts` | Orphan daemon cleanup: `reapOrphanDaemons` (after winning `:8090`, before spawn, SIGKILL this library's orphans by `--kb-root` command line) + `clearStaleMilvusLock` (before the first GUI bind, clear orphans still holding the flock, lsof + SIGKILL); both deliberately not on the MCP host path | [data-layer §8.1](data-layer.md#81-process-topology-and-shared-resources) |

**`server/routes/`** (the HTTP face, each file = a group of same-theme endpoints): `space` (open/switch/delete space, KB root), `files` (read/write/rename/delete + save-and-index), `upload` (drag-drop/paste import + OCR trigger), `folders`, `indexing` (search/index-status/sync/keyword-search), `embedder` (key config), conversion-related lives inside `indexing.ts`, `recording` (screen recording → note), `attach` (move chat attachments to OS temp), `sessions` (Claude session list/transcript), `terminal`, `mcp` (write external client config). 

**`web-src/src/`**: `store/` (`AppContext.tsx` global action thunks + polling, `state.ts` pure reducer and shapes, `useToasts`/`useModals`/`useFind` self-contained hooks—toast, Promise-ified alert/confirm/cascading dialogs, find-driver registration), `components/` (the view layer, key ones: `MainPane` routing four viewers, `HtmlPreview`/`MarkdownPreview`/`PdfPreview`/`ImagePreview`, `FileTree`, `SearchPanel`, `AgentView` structured panel, `Menu` popover primitive), `hooks/useGlobalDragDrop.ts` (window-level drag-drop coordination + iframe drop forwarding/receiving), `lib/` (pdf.js wiring, preview iframe utilities), `api.ts` (all HTTP wrapping + windowId injection).

**Others**: 🔴 `mcp/server.ts` (standalone MCP host process, **a pure HTTP thin proxy**—if the server is down it brings up a headless server, and it never opens the store itself, §7.2), `electron/` (main process, screen-recording recorder window, capture picker), `python/` (🔴 `stashbase_daemon.py` + the three-in-one extractor + PyInstaller packaging source).

### Maintenance tiers

The items marked 🔴 in the table/text above are the **low-level chain** (concurrency / cross-process / consistency / two-phase file operations, 12 files total, about 5.9k lines = 17% of the whole library—2026-06 snapshot; line count is a fast-changing variable **not maintained in this doc**, check the live state: `git ls-files '*.ts' '*.tsx' '*.py' '*.cjs' '*.mjs' '*.css' | xargs wc -l | sort -rn | head -30`): before changing, read the corresponding subsection of [data-layer §8](data-layer.md#8-concurrency-and-liveness), and after changing you must run `npx tsc --noEmit` + `pnpm test:import-folder`, and changes touching the daemon protocol must change both sides together. The unmarked ones are stateful business logic (about 27%, normal review) and UI / pure functions / utilities (56%—all CSS, icons, settings, Modal, reducer, scripts, broken-is-fixed-on-sight; of the frontend's 18.7k lines, 87% falls into this category).

Easily underestimated within 🟡: the screen-recording part of `electron/main.cjs` (macOS forking, read §4.8 first), `routes/indexing.ts` (god file, to be split), the frontend `AppContext.tsx` (state hub), and `AgentView.tsx` (streaming protocol state machine). **The shrinking of the 🔴 count is a health metric** (2026-06 simplification batch 15 → 12: watcher downgrade, reclaim deletion, MCP embedded deletion); update the marks when the list changes.

---

# 2. Space & Knowledge Base

## 2.1 Conceptual model

- **KB (Knowledge Base)**: StashBase's root directory. Each installation corresponds to one KB, all content is under this one directory.
- **Space**: a **top-level subdirectory** under the KB, carrying one theme ("AI papers", "course notes"). One KB contains multiple spaces, each independent and all within one KB scope. Deeper subdirectories within a space are just ordinary folders and do **not** constitute nested spaces.
- **Window ↔ space one-to-one correspondence**: one window opens one space at a time; you can open multiple windows simultaneously, each opening a space in parallel. Inter-window context (current space, file tree, default retrieval scope, mounted MCP servers) is isolated from each other.

## 2.2 Design decisions

- **A space solves the organization problem, not an isolation boundary**—it is not a permission boundary, not an independent database, not an independent index. The whole KB shares one set of Storage / Indexing / Retrieval / MCP.
- **Scope is decided by the querying side**, not a property of the space itself. The default scope is **global** (covers all spaces in the KB), and you can also specify a single / multiple spaces as a subset. When hard isolation is needed, specify the space explicitly in the query; spaces do no access control and no encryption.

## 2.3 Space-level configuration

Each space can have its own agent working environment, layered on top of the KB-level baseline; unspecified items inherit from the KB level. The configurable items are **limited to agent integration**:

- **MCP servers**: additional MCP servers mounted by the space (a research space mounts arxiv, a code space mounts GitHub).
- **Skills**: a space's specific agent workflows / prompt templates, placed in the fixed-convention directory `<space>/skills/` (user-visible, **not a config item**—there is no `skillsDirs`-style switch). Note: StashBase no longer mirrors them into each CLI's command directory ([§9.2 history](#92-how-stashbasemd-reaches-the-agent)); they now serve as material that users can reference directly / that each CLI discovers on its own.
- **Maintenance rule `STASHBASE.md`**: a space-level rule, overriding / extending the KB level; an empty placeholder is generated by default when a space is created (an empty file is not indexed).

The only config item is `mcpServers`, written in `<space>/.stashbase/config.json`; the skills directory and `STASHBASE.md` are placed at the space root (user-visible, directly editable, travels with git).

## 2.4 Changing the KB root directory (+ optional migration)

The Settings → **Storage** panel (titled "Root folder") lets the user change the KB root. Changing the root has two intents, and the UI guides as needed on Save:

- **Just switch**: only change the `config.json:kbRoot` pointer, leaving the spaces under the old root in place (the user is "pointing at another existing library"). Confirm once when the target is non-empty.
- **Move them**: move the space folders under the old root to the new root (the user is "moving house").

Data flow: Save first hits `GET /api/kb-root/migration-preview?target=` (`previewKbRootMigration`, read-only) to get `{ spaces, collisions, sameRoot }`—only if the old root has spaces does the Move/Just-switch dialog appear. If Move is chosen and there are name collisions, the user chooses for each one **Keep both (rename, default) / Skip / Overwrite**, and the results are aggregated into `migrate: {name, action}[]` passed to `PUT /api/kb-root`. The client flow "set root + catch 409 non-empty → confirm → retry with `confirmNonEmpty`" is abstracted into `setKbRootConfirming` (`web-src/src/api.ts`), shared by the **first-launch root-directory picker** ([§10.2](#102-application-framework-and-global-mechanisms)) and the Settings → Storage root change, avoiding two separate copies.

`setKbRoot({ migrate })` migrates **before switching `kbRoot`** (at this point `getKbRoot()` is still the old root): each space goes through `moveDirectory` (`server/fs-move.ts`, copy-then-delete, cross-filesystem safe; rollback on copy failure, only warn-not-rollback on source-deletion failure—same two-phase safety model as §4.7 import-move). `overwrite` first deletes the identically-named space at the target, `rename` takes the first free `"<name> N"`. Only after moving does it change config + clear recents + notify daemon to reconfigure.

**The index is per-kbRoot** (each root has one `.stashbase/store.nosync`), so the moved-in spaces are **automatically re-indexed at boot bind in the new library**; the old root's store stays in place as an orphan, harmless. The safe-copy primitive `copyDirectoryDereferenced` was extracted from import-folder into `server/fs-move.ts`, shared by both the import and migration paths (no app dependency, avoiding a `space.ts ↔ import-folder.ts` cycle).

## 2.5 Builtin space (first-launch onboarding)

To eliminate the cold start of "installed, opened, and an empty interface", the installer ships with a builtin space (the product manual), seeded into a new library on first launch. `space.ts:seedBuiltinSpace` does three things: copies the packaged content into `<root>/👋 Start Here/` (reusing `copyDirectoryDereferenced`), `ensureSpaceMetadata` fills in `.stashbase/` (so `listKnownSpaces` recognizes it and the subsequent bind indexes it), and `pushRecent` makes it appear in Welcome's recents. **The call site is `ensureKbRoot`**—it is the idempotent entry for "the root is ready", and both boot and lazy `GET /api/kb-root` (the path that adopts the default-root fallback without popping the picker) go through it; the first-launch picker goes through `setKbRoot`, not through ensureKbRoot, so it is backstopped once more by `onKbRootChange`. The seed is itself idempotent + latched, safe to call from multiple places. (Early on it was only hooked into the two `bootBindAllSpaces` spots, missing the lazy-ensure path that is the most common first-launch path—seeded the root but not the space, now fixed.)

The seed content is the packaged resource `assets/builtin-space/` (electron-builder `extraResources` → located at runtime via `STASHBASE_RESOURCES_PATH`, falling to the project root in dev; the resolution mirrors `mfs-daemon.ts`). **Surfacing and seeding are two separate things**: ① the manual is already on disk → ensure it is in Welcome recents (**independent of the latch**—surfacing≠re-seed, only refilled once when it falls out of recents, not bumped to the front every boot), fixing "deleted `~/.stashbase` (config + recents) but the folder is still there → exists but invisible"; ② only copy if it is not on disk, **and only for an empty library**. The `config.json:builtinSeeded` latch only means "the initial copy was done": once set, **only deleting the folder itself makes it re-seed** (re-copy), deleting config doesn't count; at startup, if the library already has spaces (upgraded existing user / root pointing at an existing library, with no manual), it only sets the latch, no injection. Failure only warns, does not block boot. V1's two official HTML pages: ① `Welcome.html`—an English letter (carrying the overview's motivation/philosophy, telling "what problem was discovered → how it's solved → the founding-intention vibe"); ② `Features.html`—a collapsible (native `<details>`, zero JS, CSP-safe) feature list, 6 features ↔ product principles in one-to-one correspondence, honestly annotating the real constraints (semantic retrieval needs an OpenAI key, screen recording needs a Gemini key, static images are OCR-only, etc.). The three pages share one set of inline design tokens, **aligned with the official site's (stashbase-web) palette**: warm white `--paper #fafaf7` + `--ink #0f1419` + dual-tier teal—fill uses `--accent #0891b2` (number circles / tags / vertical lines), text uses the darker `--accent-ink #075e76` (eyebrow / links, better contrast), panels use light teal `--accent-wash #ecf7fa`; webfonts (Source Serif 4 / Geist) are not embedded due to the self-contained constraint and fall back to the system serif stack (the official site's fallback is also Georgia). Light/dark adaptive (the official site is light-only, dark is a builtin bonus), zero external links—since it is self-contained, the "unified design system" relies on convention, fitting CSP + local-first. The official content chooses HTML over md: both to unify the layout and to incidentally dogfood overview §2.2 "HTML is the new Markdown" (HTML, after being flattened by `analyzeHtml`, enters the index as usual; collapsed content is still in the source and searchable even when collapsed). Scenario examples are placed in the `Examples/` subdirectory (subdirectories within a space are just ordinary folders, §2.1; the seed copy is recursive and includes them)—V1 starts with one founder use case (`Examples/Build your founder playbook (CS183B).html`, persona = builder/founder): clone the public starter repo [`0-bingwu-0/stashbase-cs183b`](https://github.com/0-bingwu-0/stashbase-cs183b) (CS183B 20 lectures transcribed + a distilled `founder_playbook.html` + a prebuilt snapshot) → import folder → read the playbook → ask questions in the builtin Claude panel → **drop your own material into `transcripts/` and let the agent reconcile the playbook**, demonstrating the full "Stash→distill→retrieve→accumulate" closed loop (also dogfooding §4.7 snapshot import + the source/derived two-tier agent maintenance). Per the current implementation it is written as **clone→import** (there is no builtin clone-repo-as-space); it does not say "import and it's queryable" (a snapshot is just prebuilt embedding reuse, semantic retrieval / agent still need an OpenAI key, the copy mentions this once lightly); it assumes the first batch of users already have Claude Code installed. The remaining walkthroughs (connecting an external MCP client / screen recording / dragging in papers) are added per feedback later, avoiding the onboarding space growing into a documentation site.

---

# 3. Storage

> The file system is the source of truth; `.stashbase/` and all derived files can be rebuilt from the original content. All content is ordinary files, usable directly with Finder / editors / git even outside the app.

## 3.1 Directory layout

The KB root has a flat structure, all spaces under the root as top-level subdirectories. `.stashbase/` exists once at the KB root and once at each space root, carrying KB-level / space-level derived state. The initial KB contains only `STASHBASE.md` and `.stashbase/`.

```text
~/.stashbase/config.json         # app-level config: kbRoot, recents, embedder, KB-level MCP baseline (0600)

<KB>/                            # default ~/Documents/StashBase
├── STASHBASE.md                 # KB-level maintenance rules (rulebook)
├── skills/                      # KB-level skills (user-visible)
├── .stashbase/                  # KB-level sidecar (derived state)
│   ├── store.nosync/            # vector index (Milvus Lite), read/written by daemon; `.nosync` makes iCloud skip it
│   └── state.db                 # application transactional state (SQLite)
├── research/                    # user-created space
│   ├── STASHBASE.md             # space-level maintenance rules (empty placeholder by default on creation)
│   ├── skills/                  # space-level skills (user-visible)
│   ├── .stashbase/              # space-level sidecar (created on demand)
│   │   ├── config.json          # optional, space-level override (mcpServers)
│   │   ├── snapshot.parquet     # optional, explicitly-exported embedding cache (pure vectors)
│   │   ├── snapshot.meta.json   # snapshot descriptor (embedder identity / counts / time)
│   │   └── file-order.json      # sidebar manual ordering
│   ├── paper-1.html
│   └── paper-1_files/           # resource bundle for paper-1.html
│       └── figure.png
└── notes/
    └── ...
```

**Agent files the user should see go at the root, pure derived state goes into `.stashbase/`**: `STASHBASE.md` (the rulebook, the user wants to read and edit it), `skills/` placed at the KB root / space root, traveling with git, user-visible and editable; `store.nosync/` / `state.db` / `snapshot.*` and such derived state go into `.stashbase/`. The KB root path and recents are app-level state, stored separately in `~/.stashbase/config.json`.

> **The `.nosync` suffix of `store.nosync` is deliberate**: `<KB>` often lands under `~/Documents` (iCloud sync), and iCloud evicting / rolling back Milvus Lite's WAL `.arrow` files would corrupt the collection (a file disappearing from under a running daemon's FD → every upsert/delete reports `FileNotFoundError`). macOS iCloud skips directories whose names end in `.nosync`, keeping this **pure per-machine derived** vector library out of sync. At daemon startup it renames the old `store/` (and the even-earlier `mfs/`) into `store.nosync/` once (`stashbase_daemon.py` `__init__`).
>
> The same `.nosync` convention guards the repo's build artifacts — `release.nosync/`, `python/sidecar.nosync/`, `python/.venv.nosync/`, `python/pyinstaller-cache.nosync/` — against an iCloud checkout flattening PyInstaller symlinks or xattr-tagging signed bundles. It is a **per-machine guard, not tied to the current checkout path**: keep the suffix even when the repo lives outside iCloud, since a contributor may clone into `~/Documents` / `~/Desktop` (both synced by default). The one deliberate exception is `state.db` (SQLite, + `-wal` / `-shm`): it carries only reconstructable conversion-failure rows, written rarely and never under a continuously-open daemon FD, so it stays plain — the iCloud-WAL risk that justifies `.nosync` for Milvus does not pay rent here.

## 3.2 Three-layer storage division of labor

Within `.stashbase/`, three carriers each manage their own area:

| Carrier | Content | Reader/writer | Selection rationale |
|-|-|-|-|
| `store/` (Milvus Lite via MFS) | chunks + dense/sparse embeddings (single collection) | Python daemon | dedicated to vector retrieval, MFS owns the schema |
| `state.db` (SQLite) | **conversion failures only** (`conversions` single table: failed+reason+attempts; in-flight is in process memory, "done" = derived note is on disk) | Node main process | transactional, queryable by field ("list all failed conversions") |
| `*.md` / `*.json` (plain text) | agent-readable metadata + config (`config.json`) | agent + user + Node | human / agent can directly read and edit, version-control friendly |

Design decisions:
- **Do not stuff `state.db` into `store/`**: MFS owns `store/`'s schema, StashBase does not add custom tables there; `state.db` is StashBase's own transactional boundary.
- **state.db only stores "non-derivable async derived state"**: a conversion's **failed** (reason/attempts) is not visible on disk (a failed conversion ≈ not yet converted), so it must be persisted + queried by field; in-flight lives only in process memory—the process dies and the conversion dies with it, persisting it only produces corpses that need reclaiming (2026-06 simplification). **Derivable things do not go into state.db**: per-file hash / whether already indexed is authoritatively held by daemon/store (`scan_diff`), whether a file exists is asked of the file system, and recents/kbRoot/embedder config goes into `~/.stashbase/config.json`. The early `files` (per-file index) and `index_queue` (op queue) tables were write-only copies of daemon/reconcile state, consumed by no one, now deleted (cleaned up incidentally by `DROP TABLE IF EXISTS` when opening an old library).
- **`store/` is at the KB, `snapshot.parquet` is at the space**: `store/` is the KB-level live database, queries do not cross spaces; `snapshot.parquet` is a space-level portable artifact—a **pure embedding cache** (only stores `{text_hash, dense_vector}`), paired with a `snapshot.meta.json` descriptor, dumped only on explicit export, for sharing / backup / migration (see [§5.7](#57-snapshot-a-portable-embedding-cache)). Daily writes only touch store, not double-writing the snapshot, avoiding consistency complexity.

## 3.3 Derived data is rebuildable

Both `.stashbase/` and app config are derived state, **containing no user original content**. Deleting any layer's `.stashbase/` loses no original content: deleting `state.db` only loses the bookkeeping of "which conversions failed" (next time the space is opened, reconcile re-triggers conversion for PDFs/images that have no derived note); after deleting `store/`, a space with a snapshot re-runs ingestion, but reuses the snapshot's cached vectors and only re-embeds the unmatched chunks (see [§5.7](#57-snapshot-a-portable-embedding-cache)). Whether the index is up to date is determined by the daemon's `scan_diff` per file hash (the per-file hash is stored on `store/`'s chunks), not dependent on `state.db`.

## 3.4 External tool compatibility

- **git**: files within a space are naturally version-controllable; it is recommended to `.gitignore` `.stashbase/` (large in size, changes on every startup).
- **iCloud / Dropbox / Syncthing**: visible files sync normally; `.stashbase/` is rebuilt locally per endpoint, recommended to explicitly exclude.
- **Other editors**: files within a space can be changed by any editor; the changes are reconciled at **deterministic event points** (window refocus / open or switch space / agent turn end / manual Sync)—it does not listen to the file system, does not touch inactive spaces, and does not silently consume embedding tokens.

---

# 4. Ingestion (Stash)

> Content enters the KB via drag-drop / folder import / screenshot / API, going through the embedding pipeline asynchronously, with the UI not blocking. Reconcile runs only at deterministic event points on the **currently open space**, not pre-scanning all spaces—an inactive space does not silently consume tokens.

## 4.1 Entries and format scope

The core model—**the unit of indexing is always markdown**; split into two categories by "whether the source is already structured text":

- **Structured**: Markdown, HTML. The source file itself is the single source of data, **indexed directly, deriving no files**. Markdown is fed to MFS as-is; HTML, when fed to MFS, undergoes one **targeted optimization**—`analyzeHtml` extracts `<h1-6>` into `#` headings + body (MarkdownChunker splits on headings), **done in memory on the fly, not written to disk** (the conversion is pure regex, near-zero cost, and writing to disk would only introduce a copy that drifts).
- **Unstructured**: PDF, images (png/jpg/jpeg/webp). On import, a converter **extracts structured content, stored in a hidden derived markdown** (PDF→`pdf_extract`, image→`ocr_extract` OCR text layer); this hidden `.md` becomes the **single source of data** for that file's indexed content. The naming carries the **full source filename** `.<source-filename>.md` (`paper.pdf`→`.paper.pdf.md`, `shot.png`→`.shot.png.md`), avoiding `paper.pdf` and `paper.png` colliding on `.paper.md`, and making it unambiguous when remapping search results back to the original file (see [§6.7](#67-derived-hit-mapping-pdf--image)).

Why HTML is optimized in memory but PDF/image is written to disk: **how expensive the conversion is**. HTML→md is pure regex (free), done on the fly is fine; PDF/image needs to spawn a subprocess (pymupdf / OCR, expensive), and writing to disk is a **cache**—avoiding re-running it on every reconcile/open. The structural knowledge (how to turn HTML/PDF/image into markdown) all lives in StashBase's layer, keeping MFS a clean general-purpose engine that "only indexes markdown".

**Screen recording is an independent path** (not part of the "file → hidden derivation" model above): the recorded webm is first stored into the note's asset bundle (`recording-<ts>_files/`), then converted via Gemini video understanding into a **visible** `recording-<ts>.md` note, with a link to the original video attached at the note's tail (clicking opens an external system browser to play it, see §4.4.1 / §4.8 for details). Other formats (videos, images beyond the above / other binaries) can be placed into a space but are not indexed.

Split into two categories of entry by whether they go through the StashBase API:
- **Writes via the GUI**: drag-drop into the GUI, save in the builtin editor, screenshot landing on disk **synchronously trigger the indexer** (queryable as soon as written).
- **Writes bypassing the GUI and external changes** (agent writing with filesystem tools, external editors, git checkout, folder copy, external scripts): reconciled at **deterministic event points**—window refocus, open / switch space, agent turn end, manual Sync, MCP `reindex`. **It does not listen to the file system**. After an agent modifies a file with native file tools, it calls `reindex` (diff disk vs index, self-discovering additions/deletions/modifications, without itself needing to report what changed) to make it queryable.

**Reconcile only operates on the currently open space, not pre-scanning all spaces at startup**—an inactive space does not silently consume embedding tokens. App/agent writes via the API are indexed directly on their respective write paths, with no loop-back that needs suppression.

## 4.2 Processing flow

Unstructured first **normalizes** (PDF / image → dot-prefixed markdown), structured skips; after that all files go through a **unified pipeline**:

1. **Write to disk**: land on disk per naming and conflict rules.
2. **Extract resources**: inline `data:` resources (HTML `<img>`/`<link>` attributes, base64 / utf8 images in Markdown `!` references) are extracted into separate files under a sibling `<filename>_files/`, named by content hash, with duplicate payloads deduplicated (`server/resources.ts`); remote `http(s)` resources keep their original references. Local sibling resources that come in together with a browser "Save Page As Complete" are already real files in place and are not moved again.
3. **Rewrite references**: extracted `data:` references are rewritten to relative `<filename>_files/...`.
4. **Embedding + write store**: compute embeddings for chunks (**the bottleneck**, seconds to tens of seconds), and after completion write `store/` (milliseconds).

The pipeline **runs asynchronously in the background**: it returns immediately after writing to disk (the file is already visible / readable / editable), the rest proceeds in the background, with the file carrying an "indexing..." status in the UI. The agent's write-then-read consistency is not specially guaranteed—very large files may briefly fail to query content just written.

## 4.3 PDF conversion

After dragging in `paper.pdf`, extra items appear on disk (the sidebar shows only the original PDF, the dot-prefixed derivatives are hidden):
- `paper.pdf` —— the original file, retained by default, visible (convenient for re-checking the original).
- `.paper.pdf.md` —— the structured markdown extracted by the converter (hidden), indexed, maintainable by the agent. The name carries the source suffix, to avoid colliding with an identically-named `paper.png`.
- `.paper.pdf_files/` —— the extracted image / formula resources (hidden).

Goes through `pymupdf4llm` (heading detection, tables to markdown grid, figure regions captured to PNG). **Chose markdown over HTML**: the early HTML path lost arXiv papers' vector-graphic figures, and two-column reflow and formulas were prone to garbling; the markdown path has more stable quality (`marker` can opt-in as a quality ceiling).

**When the converter fails**: the PDF still writes to disk (the file is readable), but no derived markdown is generated and it is not indexed; the UI gives a warning + a **Retry button**. **All PDF re-conversions are user-initiated actions**—reconcile does not auto-trigger them: a failed PDF is often a persistent failure (corrupt file / pure scan with no OCR / encrypted), and manually deleting the derived `.md` does not auto re-convert either (deletion may just be cleanup). Reconcile does only one thing for a PDF: trigger the converter for a PDF that is "source present, derived note absent, no failure record, not currently converting"—this judgment is all from disk + process memory reality, idempotent, and naturally self-healing after a crash. The failure record is persisted in `state.db` (the Retry surface needs reason and attempt count to survive restarts).

**Why there is no such thing as "crash reclaim"** (2026-06 simplification): in-flight is no longer persisted—the converter subprocess is a Node child, the process dies and the conversion dies with it, and persisting "converting" would only leave corpse rows that need dedicated reclaiming (the old version maintained a live set + `reclaimInterruptedConversions` for this). Now in-flight lives only in memory, after a crash nothing remains, and the next discovery walk just decides anew per disk reality. When a conversion completes, the derived note is **pushed directly into the index** (`conversion.ts:setDerivedNoteIndexer`, injected by `index.ts` at boot)—not going through any intermediate layer.

## 4.4 Image OCR

Isomorphic to PDF, a reuse of that PDF sidecar mechanism (`server/image.ts` mirrors `server/pdf.ts`, sharing the `python-host.ts` + `conversion-status.ts` state library). After a `shot.png` (png/jpg/jpeg/webp) is dragged in / pasted / landed from a screenshot, extra items appear on disk:
- `shot.png` —— the original image, visible, embedded preview in the main pane.
- `.shot.png.md` —— the text layer extracted by `ocr_extract.py` (RapidOCR ONNX, Chinese & English) (hidden), indexed. The name carries the source suffix (`.<source-filename>.md`). **No `_files/` bundle**—OCR only produces text.

Goes through RapidOCR onnxruntime: pure ONNX, no system binary dependency (unlike tesseract), the model ships with the package. When the venv lacks rapidocr, the stderr is recognized as an actionable error and prompts to run `pnpm setup:python` (`image.ts:isMissingRapidOcrError`). **Always build the sidecar**: pure photos / text-free images also write a derived `.md`, ensuring uniform behavior, and the daemon does not embed an empty file. Failure handling is the same as PDF (sharing `state.db`'s `conversions` table + `conversion-status.ts`), and PDF / image **share the same failure/Retry set**: `conversionFailures` contains both, `/api/conversion/retry` dispatches by extension (pdf→pdf_extract, image→ocr_extract), and each Preview has a failure banner. The two image-ingestion paths (drag-in / clipboard) both ultimately go through the same branch of `/api/upload` to trigger OCR (in-app screenshot capture was removed, see §4.8).

### 4.4.1 Screen recording → text (Gemini video understanding)

**Screen recording → Gemini video understanding + a visible note (the video is retained with the note)**: `server/routes/recording.ts`'s `/api/recording` (see §4.8). The webm is **first** `saveBytes` into the note's asset bundle `recording-<ts>_files/recording.webm`—from this moment on no failure mode (Gemini error/crash/restart) loses the recording → `server/gemini-video.ts:analyzeVideoWithGemini` goes through **Gemini Files API upload + `generateContent`** (default `gemini-2.5-flash`, overridable via `GEMINI_VIDEO_MODEL`), the prompt produces Markdown of **summary + screen-content extraction** → written as a **visible** `recording-<ts>.md` (`saveText` + `indexer.upsertFile`), with a **Markdown link** (`📹 [Recording video](recording-<ts>_files/recording.webm)`) attached at the tail pointing to the original video in the bundle → delete the Google-side file. **Why a link rather than an embedded `<video>`**: the webm produced by MediaRecorder (`encoder=Chrome`, Segment unknown-size) has no `Duration` element in its header, so an embedded `<video preload="metadata">` cannot read the duration → `duration=Infinity`, and the player sticks at 0:00 and won't play (`ffprobe` can scan out the duration because it reads to the last cluster, while the HTML media element only trusts the file header). After changing to a link, clicking goes through `previewIframe.ts:forwardAnchorClick` → `stashbase-open-external` → the system browser plays it (the `/asset` route still goes through `res.sendFile` with Range for video extensions, so the browser can drag the progress bar). Rule: non-note resources under `/asset/` (non md/html/htm) always open in the external browser, only notes navigate within the app. The external-open URL must carry `?windowId=`: an external browser cannot send the `x-stashbase-window-id` header, and `/asset`'s space context is resolved by it (`http.ts:withWindowContext` also accepts the query), `App.tsx`'s `stashbase-open-external` handler appends the current windowId for same-origin `/asset/` URLs, otherwise the server has no open space and returns `NO_SPACE` (only valid while the space is still open and the windowId is still in `currentSpaces`). The bundle follows the existing `<stem>_files/` convention: hidden in the sidebar, cascading rename/delete with the note. Why choose Gemini over local frame-extraction OCR: split-frame OCR cannot reliably reconstruct reading order / multi-column / dynamics / the time dimension, while Gemini natively solves it by watching the whole segment. **No key**: the renderer-side recording button pre-checks (`getGeminiKey`) and toasts a prompt to go configure in Settings → Capture; the route double-checks and returns `GEMINI_KEY_REQUIRED` (412)—**no local fallback** (removed 2026-06: low-quality frame-extraction OCR dilutes the "high-quality structured note" feature promise). **Privacy**: once a key is configured, the recording is uploaded to Google, distinct from the other local-first paths.
- Progress is tracked via `conversion.ts:runBackgroundConversion(noteKbRel, work)` (in-memory in-flight banner), keyed by the **note path**. On failure `clearRecord` (not `markFailed`—not in the conversions table's Retry model), and the error note still has the video link attached—the video is already on disk, the recording is not lost.

**Dragged-in video files get no processing at all** (in 2026-06, along with the fallback, the local frame-extraction OCR path—`video.ts` / `ocr_video.py`—was removed for the same reason): a video landing in a space is just stored, not indexed. **Note-first** has already landed on the screen-recording side (the "visible note + bundle attachment" form above); unifying dragged-in video to the same form is scheduled for **V2**—dragged-in video is a low-frequency entry, screen recording already covers the "screen content into the library" main use case, and V1 does not add a pipeline for it.

Background fire-and-forget. **Known tradeoff**: depends on the network + incurs Gemini API costs. (The old `STASHBASE_RECORDING_DEBUG` debug mode was removed—the video is saved anyway, no need for a dedicated backstop.)

**Packaged form (PDF + image extraction share one mechanism)**: in dev, `pdf_extract.py` / `ocr_extract.py` are spawned by the local venv interpreter; the packaged version **has no Python interpreter**, the two extractors are merged into one self-contained PyInstaller binary `stashbase-extract` (`python/extract_main.py` dispatches by `pdf` / `ocr` subcommand), placed alongside `stashbase-daemon` in `python/sidecar.nosync/` (the `.nosync` suffix makes iCloud skip this build artifact; a repo under ~/Documents would have iCloud flatten the PyInstaller symlinks / evict dylibs, and then the daemon couldn't load), shipped via electron-builder `extraResources` (`from: python/sidecar.nosync` → `to: python/sidecar`, still called `sidecar` inside the .app). `python-host.ts:extractorSpawn` switches between "spawn binary + mode" and "spawn venv python + script" based on `STASHBASE_EXTRACT_BIN` (injected when the main process detects the binary). This binary must bundle onnxruntime/opencv (rapidocr) + pymupdf data (`--collect-all rapidocr_onnxruntime pymupdf4llm pymupdf`, otherwise the model / layout resources are missing and it errors at runtime), so it is ~450MB in size—the daemon, conversely, keeps lean with `--exclude-module onnxruntime`. See `scripts/build-python-sidecar.mjs` for the build (two PyInstaller bundles).

## 4.5 Conflict handling

| Scenario | Behavior |
|-|-|
| User drags in a file with the same name as an existing file | Auto-append `-2` / `-3` suffix, **keep both** (all file types; a note's accompanying `<stem>_files/` bundle is renamed together). No popup, no overwrite |
| User drags in a folder with the same name as an existing folder | The whole top-level folder is renamed by `<folder>-2` / `-3`, landing a complete new copy, **not merging/overwriting in place** (`upload.ts:computeFinalNames` step 2 also includes the top-level directory in the increment, with the in-folder paths moving as a whole following the first segment's rename). The early folder-nested path landed on disk as-is, and dragging the same folder a second time would be silently overwritten by `saveBytes`—manifesting as "the second copy didn't drag in", now fixed |
| MCP / agent write with the same name as an existing file | Rejected by default, requires explicit `overwrite=true` |
| The same file changed simultaneously by two write paths | The later writer overwrites (V1 does not introduce file locks; write frequency is low) |

The two paths correspond to two intents: a user's drag is "add it in", so it is always keep-both, never silently destroying existing content (early on only notes were keep-both, PDF / image would be overwritten, now corrected to suffix-append for all types); an agent write is more likely "replace", but the replace must be explicit `overwrite=true`.

## 4.6 Reconcile

Reconcile always operates **on only one space** (not pre-scanning the whole KB). **Single granularity**: full content-hash diff (`syncIndex`)—hashing a personal library is milliseconds, and embed only happens for files whose hash changed, so the old name-only fast gear (`syncNewFiles`) saved no tokens and only contributed a second set of semantics, removed 2026-06. The trigger points are all **deterministic events** (it does not listen to the file system):

| Trigger | Description |
|-|-|
| Open / switch space | bind → snapshot import → syncIndex, serial |
| Window refocus | frontend 5s throttle (`AppContext.tsx`)—external edits get reconciled on return |
| Agent turn end | panel `turn-end` triggered (`AgentView.tsx`)—shell writes get indexed immediately |
| Manual Sync button / MCP `reindex` | explicit full reconciliation |

The full content-hash diff scans the file tree → compares against indexed records → incrementally classifies and processes:

| State | Determination | Action |
|-|-|-|
| **Unchanged** | path + mtime + size match exactly | skip |
| **Suspected change** | mtime or size mismatch → compute content hash | hash same (touch / git checkout): only update mtime/size, **do not re-embed**; hash changed: re-extract + re-embed |
| **Added** | path does not exist → look up the hash of a "deleted" entry | match → rename, only update path (**do not re-embed**); otherwise full ingestion |
| **Deleted** | record exists but the file does not | rename detection first; if neither matches, remove from store |

The key to saving tokens: when mtime/size change but the hash does not (`touch`/`cp -p`), only update metadata; when path changes but the hash does not (rename/move), only update the path. The hash is computed only at three moments—first ingestion, verification on mtime/size mismatch, and rename-detection matching an orphan entry—not hashing every file every time, avoiding slow startup on a large KB.

## 4.7 Space-level import and snapshot

A whole space is brought in as one unit, with the only entry being a **local folder**: import a directory via the GUI, or copy / move a folder under the KB root. **There is no builtin git clone**—a user who wants to treat a repo as a space `git clone`s it themselves (the git relationship belongs to the user: when to `git pull`, whether to sync upstream, are all in the user's hands, StashBase makes no implicit promise to track upstream), and the cloned directory (together with `.git/`) goes through import folder. 

Flow: copy / move to the KB root → **always go through the standard ingestion pipeline**; if it carries `.stashbase/snapshot.parquet` + `snapshot.meta.json`, first load it as an embedding cache, and during ingestion, on a `text_hash` hit reuse the vector, **only truly embedding the unmatched chunks** (saving tokens), and without a snapshot embed everything → bring in the space-level `config.json` (if present). See [§5.7](#57-snapshot-a-portable-embedding-cache) for details. On copy, exclude `.stashbase/`'s per-machine state in place (`state.db-*`, `pdf-status.json`, etc., `import-folder.ts:isImportExcludedEntry`); a very large import (>10k entries or >1GiB) requires an explicit second confirmation (`CONFIRM_LARGE_IMPORT`).

**Snapshot compatibility**: the embedder recorded in `snapshot.meta.json` (provider/model/dim) must match the current KB's embedder; on mismatch the cache is not loaded + a warning, and ingestion re-embeds everything as usual (it will not pollute the index). **Space name conflict**: the UI asks to rename the import / overwrite / cancel.

## 4.8 Screen-recording capture and clipboard

Image ingestion relies on drag-in / clipboard / external screenshot files, reusing the OCR-into-index of [§4.4](#44-image-ocr); screen recording is converted via Gemini video understanding into a visible note (the video is not retained, see §4.4.1). **Note: in-app screenshot capture (`desktopCapturer` fullscreen/window/region + a region-selection overlay) was removed**—its memory-layer value is limited (just the text layer in the image, no image-meaning reconstruction), and macOS's builtin screenshot + drag-in already cover it; only the recording button remains on the rail. `getCaptureSettings` / `CapturePanel` (screen-recording permission UI), `listCaptureWindows` / `internalCaptureSourceIds` (the screen-recording old-path picker), `classifyCaptureError` / `emitCaptureCreated` and such are shared pieces still depended on by screen recording, retained.

- **Clipboard detection**: peek the clipboard while the main window is focused—triggered once by `win.on('focus')`, plus a `600ms` focus-period poll (`startClipboardPolling`, the timer stops itself when focus leaves the main window); if there is an image, IPC pushes it to the renderer to pop a **modal** (with thumbnail) asking whether to ingest; Add goes through the same upload+OCR. Dedup by the PNG bytes' SHA1—the same image is only asked about once (`lastClipboardOfferHash`); on privacy it is on by default and can be turned off via `clipboard:setWatch` (which stops polling when off). **Why poll rather than only listen for focus**: when browsing on StashBase and pressing a system screenshot (Cmd+Ctrl+Shift+4 → clipboard), macOS writes the bytes into the clipboard **asynchronously**, often landing after the focus event—reading once would read empty, requiring the user to manually switch away and back to pop it; the focus-period poll makes "pop as soon as you finish capturing", with no refocus needed. **Known boundary**: macOS's default screenshot (Cmd+Shift+4) saves a desktop file, not into the clipboard, and these rely on drag-in as a backstop.
- **Screen recording**: the entry is the **record button on the left ActivityBar** (`ActivityBar.tsx`, under the Search icon), clicking toggles start/stop; the recording state is pushed by main via `recording:state` to all main windows, and the button turns into a red stop state accordingly (synced however it is started/stopped, including stopping via the macOS recording indicator dot). `MediaRecorder` is a renderer-only DOM API that main cannot run, so a new **hidden recorder window** (`electron/recorder.html`, `show:false` + `backgroundThrottling:false`) runs MediaRecorder. **Two source-selection paths by macOS version** (`supportsSystemPicker()` judges macOS 15+ by Darwin major ≥ 24):
  - **macOS 15+ (new path)**: `setDisplayMediaRequestHandler`'s `useSystemPicker:true`; `beginRecording`→`startRecordingSystemPicker` builds the recorder window→main injects a user gesture via `executeJavaScript('window.startCapture()', **true**)`→the recorder calls `getDisplayMedia({video:true})` to pop the **native system picker** (SCContentSharingPicker, **the only one that can list fullscreen apps and natively highlights the selected item**). Only after the user selects does `recorder:started`→flip `recordingActive` (`recordingPending` guards against re-triggering); cancel triggers `recorder:canceled` and silently tears down.
  - **macOS 14 and below (old path)**: `beginRecording`→`createCapturePickerWindow('record')` lists **windows only** (`listCaptureWindows`, excluding StashBase's own windows, see `internalCaptureSourceIds`)→user selects→`recorder:recordWindow(sourceId)`→`startRecording(sourceId)`→`recorder:start`→recorder `getUserMedia(chromeMediaSource:'desktop')`. **A fullscreen app cannot be recorded**: it is in a separate Space, and `desktopCapturer`'s on-screen-only enumeration simply does not return it; to record it you need to exit fullscreen into a window, or upgrade to macOS 15. **No silent fallback** (errors if no source is selected, does not silently record the main screen).
  - **In-recording floating overlay (cross-Space hint)**: during recording, main raises a **persistent floating pill** (`showRecordingIndicator`, inline HTML, a red breathing dot + timer + recorded-screen label + Stop button). `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})` + `setAlwaysOnTop('screen-saver')` make it **float above any app's fullscreen Space**—precisely to fill the gap where macOS's builtin menu-bar recording icon is hidden in a fullscreen Space, and the rail's red button is on an unreachable window, leading to "sliding elsewhere with zero awareness". `setContentProtection(true)` makes it **visible to the user but not recorded into the video** (otherwise the pill would smear into the very recording it announces). The lifecycle is hung on the single `emitRecordingState` point: start (both paths) / normal end / crash backstop all go through it, so the overlay's existence strictly follows `recordingActive`; `focusable:false` does not steal focus from the current Space; the pill is draggable to reposition. **Key gotcha**: both the pill and the border overlay must be created `show:false` → first `setVisibleOnAllWorkspaces` → then `showInactive()`; otherwise the new window, the moment it "shows", would bounce the user from **the fullscreen window being recorded**'s Space back to the main-desktop Space where the overlay is (`canJoinAllSpaces` must be in place before show, so the window "joins the current Space" rather than "switching to its own Space").
  - **What is being recorded (the overlay label, copy that does not mislead)**: `visibleOnAllWorkspaces` on macOS corresponds to `canJoinAllSpaces | fullScreenAuxiliary`, and `canJoinAllSpaces`'s semantics is exactly "appear on **all** Spaces (including the main desktop)"; Electron binds these two flags together and exposes no interface to set `fullScreenAuxiliary` alone. **Consequence**: when recording a single window, the overlay must `canJoinAllSpaces` to be able to cover that fullscreen window, so when you slide back to the main desktop it is there too—making people mistakenly think the desktop is being recorded. Truly "only in the recorded window's Space, disappearing when you slide back to desktop" requires getting the recorded window's native windowID and snapping the overlay onto it (SCK native module, not done). **Tradeoff: do not hide the overlay, instead disambiguate with copy**—the overlay always shows "**what is being recorded**" rather than implying the current screen: the recorder reads the video track's `getSettings()` (`displaySurface` + pixel dimensions) and returns it via `recorder:meta`, and `describeRecordingTarget` generates a subject phrase: `window`→"Recording a window"; `monitor`→matched by resolution against `screen.getAllDisplays()` (for `monitor`, directly take the closest, not held to a tolerance, lest HiDPI rounding misjudge; only on unknown surface use a ±5% tolerance), single-screen "Recording the screen", multi-screen judging `left/middle/right` by x coordinate and showing "Recording the right screen" and moving the overlay to the top center of that screen; on no match, fall back to "Recording a window". The label is pushed to the pill via `recording:label` (the pill may be built before the meta, so `did-finish-load` re-pushes once). This way, even if the overlay floats over the main desktop, the copy only claims "recording some window / some screen", not that the current Space is being recorded. After the pill renders, it measures its own width and returns it via `recording:indicator-size`, and main shrinks the window to just fit (label not truncated, the transparent window not acting as a superfluous click-interception zone).
  - **Recording glow border (four thin edge windows)**: `showRecordingBorder` draws a ring of red glowing border as a strong "recording in progress" hint, covering the recorded monitor (default main screen, moved over by `positionBorderOnDisplay` after `recorder:meta` matches the monitor). **Key: it is not one full-screen window, but four thin edge windows on top/bottom/left/right** (`createBorderStrip`, each with inline HTML: a solid edge line + glow fading inward + breathing). Reason: **a full-screen-sized window entering a fullscreen App's Space gets ordered beneath the App (covered, invisible)**, only a small auxiliary window like the pill can float above; the four thin edge windows are each small, so they can float above the fullscreen window and assemble into a border. Each is `setIgnoreMouseEvents(true)` click-through, `setContentProtection(true)` not-recorded, `focusable:false`, `canJoinAllSpaces` (so it also appears on the main desktop), `show:false`→set collection behavior→`showInactive()` (the same anti-Space-jump handling as the pill). **Deliberate imprecision**: when recording a single window, it still draws a full-screen ring border (the recorded window's coordinates are unobtainable, see below), disambiguated by the pill's "Recording a window"—this tradeoff is the user's explicit choice. The border is created before the pill, and the pill is on top, staying clickable.
  - **Known gaps / tradeoffs**: native apps like Feishu **use ScreenCaptureKit to directly list/highlight/raise fullscreen windows across Spaces**; Electron's equivalent wrapper `useSystemPicker` is macOS 15+ only, and achieving the same effect (window enumeration/raising/snapping a **single-window** border) on 14.x needs a native SCK module or AppleScript+Accessibility (neither done). **So the recording border can only draw the full screen, it cannot snap to a single window**: the precise coordinates of the recorded window are unobtainable on both paths (the system picker does not return the selected item; the `desktopCapturer` window source has no bounds), so when recording a window it is "full-screen border + copy disambiguation" rather than truly hugging the window; true window-level highlighting is left to the macOS 15 system picker's native highlight, or a later SCK adoption.
  - Common wrap-up: stop goes through `capture:stopRecording`→`recorder:stop` (or stopping via the macOS recording indicator dot, track `ended`) → the recorder reads the webm into a data URL and returns it to main via `recorder:result`→`capture:created` pushes the renderer→`App.tsx` for the video mime calls `actions.recordVideo`→**POST `/api/recording` (not `/api/upload`)**. MediaRecorder at 16 Mbps + native resolution (for recognition clarity), no audio. **The video is retained with the note**: the server stores the webm into `recording-<ts>_files/` → Gemini video understanding (key required, see §4.4.1) → produces a visible `recording-<ts>.md`, with a tail link to open in the external browser for re-watching.

**Correspondence with overview §5.3 Vision-first Capture**: §5.3's "record the view the user sees → a multimodal model reconstructs structured text" **has already landed in the screen-recording path**—screen recording goes through Gemini video understanding to produce a summary + structured content (see §4.4.1), the first implementation of this very principle (and it is thus what introduces the optional cloud dependency, see §1.1 Local-first tradeoffs). **Static screenshots / images are still only an OCR text layer**: you can search the text in the image, but the image-meaning of text-free images (charts / photos) has no semantic reconstruction—full multimodal reconstruction of static images is still on the roadmap.

---

# 5. Indexing

> MFS is used as the indexing layer, with only one thin `Indexer` interface above it (currently the single implementation `MfsIndexer`). The daemon only handles chunk + embed + store.

## 5.1 Why use MFS directly

Mapping the low-level capability requirements one by one to the capabilities provided by [MFS](https://github.com/zilliztech/mfs):

| StashBase needs | MFS provides |
|-|-|
| Files are the source of truth | the explicit principle "Files are SoT, Milvus is derived" |
| Hybrid retrieval | Dense + BM25 sparse + RRF fusion |
| Incremental updates | single-file granularity add / delete / rename |
| Local-first zero-config | Milvus Lite (no separate server, data stored in local files) |

Therefore StashBase **uses MFS as the indexing layer**; chunker / embedder extensions go through MFS plugins. Four core modules are used: **Chunker**, **Embedder**, **Store**, **Searcher** ([§6](#6-retrieval)).

Above it is only one thin `Indexer` interface—the rest of the server only imports this interface, and the current only implementation `MfsIndexer` connects to the daemon over stdio. When MFS ships a native TS package / when the vector backend is swapped, only this one spot changes. This abstraction is extremely thin (one interface + one implementation), a cheap insurance for "betting on the young dependency MFS", not superfluous layering.

## 5.2 Chunking

Done by MFS's `MarkdownChunker`: split sections by ATX headings (`#`/`##`/`###`), with long sections backstopped by **1500 characters + 200-character overlap**. Markdown / HTML go through the same chunker—HTML has already been flattened on the Node side into markdown-style plaintext with a natural heading structure.

## 5.3 Embedding

V1 has a **fixed single embedder: OpenAI `text-embedding-3-small` (1536d, cloud)**. No provider switching, no local fallback, no per-space override—the whole KB has one embedder, one collection.

The API key is stored in KB-level config (`~/.stashbase/config.json`'s `apiKey`). **Without a key, the only things disabled are embedding indexing and semantic retrieval**—files still land on disk / preview / edit as usual, keyword retrieval (ripgrep, not via the index) remains available, and the search panel is locked in keyword mode (`SearchPanel.tsx`); the UI pops a dialog to guide adding a key when a space is opened. **In implementation, both write paths short-circuit without a key**: `syncIndex` (reconcile) and the snapshot import `maybeImportSnapshot` both return directly when `getApiKey()` is empty (no store/embedder available). Otherwise the import would upsert file by file (the daemon's `_store is None` throws `no bound space … set an OpenAI API key`), and a space with a snapshot would additionally have `load_vector_cache → require_current()` throw a Python traceback of `no embedder bound`—a whole-library import would flood the screen with per-file failures (once at a no-key import of the CS183B starter, 23/23 all failed + snapshot traceback). After configuring the key, running sync again fills everything in and reuses the snapshot vectors. Note: this makes embedding the only core capability that depends on a cloud service, a deliberate and **permanent** tradeoff against local-first—a local embedder is explicitly not done (semantic retrieval of insufficient quality is worse than none, and the model's size/maintenance cost conflicts with desktop distribution); the data is still entirely local, only the "build index" step hits OpenAI.

> History: the early design supported two providers, OpenAI / local `bge-m3` (ONNX), plus runtime switching, and for that introduced active/archive multi-collection, cross-collection RRF, a migration window, and archive GC. After V1 cut switching, all of this was removed.

## 5.4 Store structure

One KB has one Milvus Lite DB (`<KB>/.stashbase/store.nosync/`), internally **one collection** `vectors_openai_1536` (the name carries the dim, reserving a non-colliding slot for a possible future `3-large` (3072); the default small keeps the historical name, not orphaning already-indexed data). All spaces share this one collection, and all read / write / search go through it. No active/archive distinction, no migration window.

**Chunk record schema**:

| Field | Use |
|-|-|
| `id` | primary key, derived from BLAKE3(path + line range + chunk text hash) |
| `source` | the file's relative path within the KB (POSIX), carrying the space prefix |
| `chunk_text` | the chunk's original text |
| `dense_vector` | the dense vector output by the embedder |
| `chunk_index` | which chunk this is within the source file |
| `start_line` / `end_line` | the chunk's position in the original text (for result back-linking) |
| `content_type` | "heading" / "paragraph" / "code" etc. |
| `file_hash` | the content hash of the owning file (redundantly stored per-chunk) |
| `metadata` | reserved JSON blob (currently always empty `{}`, file-level metadata is no longer injected) |

**The schema is owned by MFS**, and the table above lists only the fields StashBase cares about. Two notes: (1) **there is no materialized `sparse_vector` column**—BM25 is computed in real time server-side by Milvus's `Function` from `chunk_text` at query time ([§6.3](#63-hybrid-algorithm)), StashBase does not write sparse vectors; (2) MFS additionally carries several internal fields (`parent_dir` / `is_dir` / `embed_status` / `account_id`), which StashBase does not read or write, evolving with MFS.

## 5.5 Per-file index

Reconcile's "should I re-embed" judgment relies on the **per-file content hash**, and this index is **authoritatively held by daemon/`store/`**—each chunk redundantly stores its file's `file_hash` (BLAKE3), and the daemon's `scan_diff` compares the disk hash against it to classify add/modify/rename/delete. **Index admission** is gated on the Node side (`server/indexable.ts`): excluded directories, a 600KB size upper bound, and "no extractable text" (empty/whitespace-only notes, bundler-type pure `<script>` HTML)—these three categories can never produce a chunk, the upsert directly skips embed, and `/api/index-status` also filters them out of `pending`, otherwise the sidebar would flash "indexing…" on them forever. The daemon's disk-scan view (excluded directories/size/extension) **uses the same set of rules**—pushed down from Node via the `set_rules` op after each daemon spawn (see [§5.6](#56-incremental-update-ops)), so the two sides no longer each maintain a constant that drifts. The Node side **no longer** maintains a parallel copy (the early `state.db.files` table was exactly such a write-only-never-read copy, now deleted, see [§3.2](#32-three-layer-storage-division-of-labor)). The hash algorithm in three places (Node `prepareForIndex` / daemon upsert / MFS scanner) is **locked to BLAKE3**, otherwise `scan_diff` would judge every file as modified.

## 5.6 Incremental update ops

The core ops exposed by the daemon:

| op | Behavior |
|-|-|
| `upsert(path, text, ext, file_hash)` | re-chunk + embed (with a snapshot cache, reuse on hit, only embed misses) + replace all chunks of that source + update the per-file index |
| `delete(path)` | delete all chunks of that source + delete the per-file entry |
| `rename(old, new)` | only change the chunks' `source` + the per-file `path`, **do not re-embed** |
| `scan_diff(space?)` | return that space's add / modify / delete / rename candidates (no write, for Node reconcile) |
| `export_space(space)` | dump that space's collection's `{text_hash, dense_vector}` (deduplicated) → snapshot.parquet |
| `load_vector_cache(space, path)` | read the snapshot vectors into a daemon temporary cache, for subsequent `upsert` reuse |
| `clear_vector_cache(space)` | clear that cache after the import's reindex finishes (release memory) |
| `set_rules(excluded_dirs?, max_indexable_bytes?, include_extensions?)` | receive the index rules pushed down from Node (Node is the only source, the daemon's builtin constants are fallback only); auto-pushed by `mfs-daemon.ts` after each spawn's `ready`, and when an old binary does not recognize this op Node warns loudly |

**Single-file `rename` fast-path**: reuse each old chunk's `dense_vector` etc. one by one, only swap `source` / recompute `id`; if any chunk's `file_hash` does not match the passed-in one (content drifted) or a vector is missing, abort and fall back to the delete + re-insert slow path, never leaving a half-renamed state. The rename of a 100MB PDF drops from tens of seconds to ~5ms. **Folder rename (`rename_prefix`) is also fast-path**—file by file reusing the single-file hash-match vector-reuse path (if the hash did not drift, only change `source`/`id`, no re-embed), only falling back to re-embed for files whose content truly drifted; after processing, scan once more for leftover old-prefix rows to clean orphans. The only exception: when the old and new prefixes nest within each other (`a` → `a/b`), the closing orphan sweep may mistakenly delete a just-written new row, and this case falls back to the old "clear the old prefix first, then re-embed" path.

**The hash algorithm is locked to BLAKE3** (fast, streaming-friendly): the content hash + chunk id in three places (Node / daemon / MFS scanner) must be locked to BLAKE3, otherwise `scan_diff` would judge every file as modified.

## 5.7 Snapshot: a portable embedding cache

The snapshot is a portable layer StashBase builds on top of MFS (MFS does not provide export/import), positioned to **save the re-embed cost**—embedding costs API/GPU, while chunk / line number / metadata can all be deterministically rebuilt from the source file. The snapshot sits in `<space>/.stashbase/` and always travels with the source file, so it **only stores what cannot be cheaply rebuilt: vectors**.

- **`snapshot.parquet`**: just two columns `{text_hash, dense_vector}` (zstd). `text_hash = BLAKE3(chunk_text)`—content-addressed, not bound to path/line number, so file moves, renames, and line-number drift do not affect hits; chunks with the same text naturally dedupe into one row.
- **`snapshot.meta.json`**: a human-readable descriptor, written out from config on the Node side—`{version, space, embedder:{provider,model,dim}, vectors, chunks, exported_at}`. Validation info like embedder identity is placed here, not stuffed into the parquet.

**Export** (`export_space`): pull `{chunk_text, dense_vector}` from that space's collection, dedupe by `BLAKE3(chunk_text)` and write the parquet; Node writes meta.json.

**Import** (clone/copy a space with a snapshot): no longer bulk-inserting whole rows, but instead—(1) read meta.json, validate that its embedder matches the current KB's embedder (mismatch → don't use the cache + a warning, re-embed everything); (2) `load_vector_cache` reads the vectors into a daemon temporary cache; (3) go through **standard ingestion** re-chunking the source files, the `upsert` computing `BLAKE3(chunk_text)` for each chunk, reusing the vector on a cache hit and only truly embedding on a miss; sparse is computed by Milvus from text on the fly, no need to store; (4) after reindex finishes, `clear_vector_cache` releases the cache.

**Cost**: vector reuse relies on "the re-chunked text matching the export-time text" (the chunker + HTML flattening logic deterministic and at the same version); if the version drifts → `text_hash` doesn't match → that batch falls back to truly embedding (safe, just not saved). This is an acceptable tradeoff in exchange for "the parquet not duplicating the source file, with clean responsibility".

**Version**: `SNAPSHOT_VERSION = 3`. The old v2 (self-contained whole rows) snapshot has no `snapshot.meta.json` and its parquet schema does not conform—it will not be reused (nor error), automatically falling back to re-embedding everything; re-exporting with the current build restores the token savings.

---

# 6. Retrieval

> Hybrid retrieval (dense + BM25 + RRF) is done in one pass within a single collection by the MFS Searcher, and StashBase adds no business secondary ranking. Scope filtering is pushed down into the Milvus expr.

## 6.1 Call entry

All retrieval requests ultimately arrive at the daemon's `search` op: the GUI search bar (default semantic), MCP `search_kb` (external clients), and the builtin agent CLI (via MCP, same path). The daemon's single responsibility: assemble the query → call the MFS Searcher → format and return, not doing secondary ranking adjustment at the daemon layer.

**Agent direct file operations vs MCP retrieval**: the KB is a real local folder, and the agent natively has `cat`/`grep`/`edit`. MCP retrieval is positioned as the capability the shell cannot reach—semantic / vector recall / cross-file conceptual association. **When to use MCP and when to use the shell is decided by the agent itself**.

## 6.2 Retrieval interface

```text
search(query, top_k=10, space=None, path_prefix=None) -> list[Hit]
```

`space`: `None` (= global) / single space / multiple spaces. `path_prefix`: further narrow to a subdirectory prefix (finer than space, with `path_prefix` taking priority when both are passed). Filters like file type / date are a V2 direction, absent in V1. `top_k` defaults to **8**, consistent in three places (the daemon op, the GUI search bar `routes/indexing.ts`, the MCP `search_kb`'s `DEFAULT_TOP_K`); MCP callers can override (cap `MAX_TOP_K=25`).

## 6.3 Hybrid algorithm

Done in one pass by MFS's `Searcher.hybrid_search`, no client-side merge:
- **Dense kNN**: cosine, recalling with the collection's embedder encoding the query.
- **Sparse BM25**: Milvus server-side `Function` field computes BM25 IDF.
- **RRF fusion**: k=60, the server fuses the two paths by reciprocal rank.

The three steps are done within a single Milvus query. With only one collection, **StashBase adds no business secondary ranking**—MFS's RRF output is the final order, making the search path simple and predictable. V1 has no tuning hooks whatsoever; time decay / space weight / click history / score normalization etc. all need extra client-side secondary ranking, to be revisited in V2+, avoiding premature optimization.

## 6.5 Scope filtering

Each chunk's `source` carries the space prefix, and scope goes through a Milvus string-prefix filter:

| Scope | Milvus expr |
|-|-|
| global (default) | (no source filter) |
| single space `research` | `source LIKE "research/%"` |
| multiple spaces `[research, notes]` | `source LIKE "research/%" OR source LIKE "notes/%"` |

Scope must be **pushed down into the Milvus expr** (filter before ranking), rather than getting all KB results and client-side filtering—the latter has uncontrollable latency on a large KB. **Long-term direction**: make `space` a Milvus partition key, so a single-space query physically skips other spaces' chunks.

## 6.6 Result structure and performance

`Hit = { source, chunk_text, start_line, end_line, score, metadata, chunk_index, content_type }`, in descending score, with length ≤ top_k. The daemon returns only chunk-level data (text + line range), not highlight positions—the UI handles that itself.

| KB scale | hybrid search latency |
|-|-|
| <10k chunks | <30 ms |
| 10k–100k chunks | 50–150 ms |
| >1M chunks | not optimized in V1, may be >500ms, needs V2 partitioning |

V1 target users' KBs are usually 10k–100k chunks, no special tuning needed.

## 6.7 Derived hit mapping (PDF / image)

The semantic hits of PDF / image all come from the hidden derived `.<source-filename>.md` (`.paper.pdf.md`, `.shot.png.md`), and the server rewrites the path back to the sibling original file before returning—since the derived name already carries the full source filename, `originalForDerivedNote` directly strips the head and tail (the `.` prefix + `.md`) to get the source filename and confirm it exists, **with no need to probe by extension**; an orphan derived hit whose source was deleted externally is discarded (not exposing the hidden `.md`). What the user and MCP `search_kb` see are both the original file path. PDF originals have no line numbers, and the viewer uses the chunk text to search within the page to locate (head/mid/tail three anchors), scrolling to paragraph precision; the image viewer does no in-page locating (no text layer to jump to), and a hit only opens the original image.

---

# 7. MCP

> StashBase exposes the entire KB to any MCP-compatible AI client via MCP; it does not embed an LLM itself, only being a persistent memory layer—MCP is this layer's outward interface.

## 7.1 Role and architectural position

StashBase **does not embed an LLM**, relying on the AI client (Claude / Codex / Cursor / Gemini) for reasoning, only being a persistent context layer itself. The premise is that **the client and KB are on the same machine, with filesystem access to kbRoot** (the local-first default): MCP only provides the capability the filesystem cannot give, with all other read/write going through the client's own file tools.

```text
AI client ── MCP ──→ Node MCP server ── daemon ops ──→ Python daemon (MFS)
   └── filesystem tools ──→ directly read/write files under kbRoot (not via MCP)
```

The MCP server is a **Node process** (not the daemon), managing the protocol layer + tool definitions + daemon ops; file CRUD does not go through it.

**Transport**: V1 is **stdio only**—the default transport of mainstream clients. V2+ may add streamable HTTP (letting web-based clients connect directly).

## 7.2 Tool surface

Three tools, corresponding to the capability the filesystem cannot give + one directional entry:

- **`kb_info()`** — a directional card, returning `{kb_root, spaces, rules}`: `kb_root` is the KB's absolute path (the agent uses file tools to read/write accordingly), `spaces` lists each space (name + embedder provider), and `rules` is the KB-level `STASHBASE.md`. A new session **calls it first**.
- **`search_kb(query, space?, path_prefix?, top_k?)`** — goes through the daemon's hybrid_search, returning kbRoot-relative paths + chunk + line numbers + fusion score; to get full text, directly read `<kb_root>/<path>`.
- **`reindex(space?)`** — run one reconcile (the whole library by default, optionally `space`), self-diffing disk vs index and self-discovering additions/deletions/modifications (the caller does not report what changed), returning `{spaces:[{added,modified,removed,renamed,failed}], total, indexed, pending, upToDate}` (totals come from a post-sweep whole-library index-status). The agent calls it after modifying any file with file tools.

File CRUD (read full text, create / modify / delete / move notes, change `STASHBASE.md`) all go through the client's own file tools—the KB is just ordinary files under kbRoot. There is no fs watcher, and only after writing and calling `reindex` is it queryable.

## 7.3 Why not expose file CRUD

When the client and KB are on the same machine with fs access, reading full text / create-delete-modify-move / changing rules are all ordinary file operations that the client's own file tools can do, and MCP wrapping another layer is just redundant. So MCP keeps only the two things the filesystem cannot give: **semantic retrieval** (which needs the vector index) and **reindex** (no watcher, so disk changes must be explicitly reconciled, and only an MCP call can trigger it from headless). The maintenance contract (do CRUD with file tools, `reindex` after writing, tag new files `generated_by: stashbase-agent`, `kb_info` at the start) is injected into the client's system prompt at connection by the MCP server's **`instructions` field**, in concert with the `STASHBASE.md` rules brought out by `kb_info`.

## 7.4 Permissions and multi-KB

V1 has **no auth**—any process that can connect to stdio can use the full tool set. This is a reasonable simplification under the local-first model: the user's shell already has full file permissions, and MCP is not broader. V2+ may add read-only / read-write modes, per-tool permissions, multi-client isolation.

Single installation = single KB → a single MCP server process. Tools operate on the active KB by default, with `space?` limiting scope (not passed = whole KB), the same "scope decided by the caller" semantics as reconcile.

**Single-path execution** (`mcp/server.ts:viaWeb`, since 2026-06-12): every tool hits the local server's HTTP API; when the server is down, the MCP host **brings up a headless server** (`spawnHeadlessServer`: dev spawns `tsx server/index.ts`, packaged version runs `dist/server/index.mjs` with `ELECTRON_RUN_AS_NODE`, injecting sidecar binary env; detached + its own log `~/.stashbase/headless-server.log`; `STASHBASE_HEADLESS=1` tolerates a missing web build) and then connects. **The single-instance arbitration is just the `:8090` port bind**: on concurrent bring-up one binds and the other exits with `EADDRINUSE`, and both hosts connect to the winner—the MCP host itself **never opens the store**, so the whole class of multi-daemon lock contention disappears by construction ([data-layer §8.1](data-layer.md#81-process-topology-and-shared-resources)). A mid-stream disconnect (fetch TypeError) re-spawns once and retries; HTTP status-code errors are re-thrown as-is. The sync flow (`server/sync.ts`) is context-free (space passed explicitly, paths resolved against kbRoot), so the headless server can run `reindex` for any space.

## 7.5 Per-space MCP server injection

A space can mount additional MCP servers (a research space mounts arxiv), written in `<space>/.stashbase/config.json`. This is an extension beyond StashBase's own MCP server, started and proxied by the Node-side MCP host per the current window's active space. When passing through to the client, the upstream tool is renamed to `space_<index>_<server>_<tool>` (slugified to `[a-z0-9_-]`, avoiding characters like `/` that violate tool-name rules); the host internally routes by `<server>/<tool>` as the key.

## 7.6 Client configuration

StashBase ships with the MCP server binary. The UI's "Connect to AI clients" section does **one-click writes for the three clients with a stable global config path** (claude-code → `~/.claude.json`, codex-cli → `~/.codex/config.toml`, claude-desktop); for the other clients (Cursor / Gemini / VS Code / Cline etc.) it gives a **copyable config snippet** for the user to paste themselves—each client's config format differs (JSON / TOML), and the UI generates by type. After configuring, the external client can access the KB even outside the app.

---

# 8. Built-in Agents

> The builtin agent binds to the current space, saving the steps of opening a terminal, `cd`, and configuring MCP. **Claude goes through a structured panel** ([§8.4](#84-structured-panel-claude-phase-1), Phase 1 implemented): run via the Claude Agent SDK, rendered into a VSCode-style panel of bubbles / tool calls / inline diff approve-reject. **Codex is a placeholder for now**—it shows "Coming soon" in the same panel shell, the structured Codex panel is not yet implemented (the raw terminal entry has been retired).
>
> The two are opened by two launcher buttons in the top right respectively. For the feature list and phasing, see the dedicated document [chat-panel.md](chat-panel.md).

## 8.1 Agent CLI probing and registration

The top-right chrome is **one branded icon button per agent** (Claude / Codex, imitating VSCode): clicking one opens the chat panel and **opens a new window (tab) of that agent**, and repeated clicks accumulate multiple parallel sessions (tab titles uniformly `Untitled`, repeats appended with ` 2` / ` 3`). The panel has no separate hide toggle—**closing the last tab auto-collapses the panel** (the reducer `CHAT_TAB_CLOSE` sets `chatOpen` to false). The entry for creating a new tab is the chrome launcher (the tab bar itself only shows already-open tabs); the structured panel header additionally has a "new Claude conversation" `+`. **Each tab locks to its own agent**.

The CLI registry + probing is in [server/terminal.ts](../server/terminal.ts) (`/api/terminal/clis`): **the CLI is not bundled**, instead probing the global installation on the user's PATH (`command -v`, going through an interactive login shell to read the PATH of nvm / asdf etc.). When Claude is not installed, the SDK fails to start, and the panel shows "Unable to start Claude" (there is no longer a builtin `npm install` guide).

## 8.2 How the builtin agent connects to the StashBase MCP

The CLI in the panel is **not injected via `--mcp-config`**, but reads each CLI's own global config—relying on the "Connect to AI clients" one-click write of [§7.6](#76-client-configuration) (`~/.claude.json` / codex toml etc.). So the builtin agent and external clients go through **the same KB MCP server**, the same config, with no separate "builtin-dedicated" MCP layer. Per-space additional MCP servers are proxied by the Node-side host ([§7.5](#75-per-space-mcp-server-injection)).

## 8.3 Session

The Claude Agent SDK's session is stored in `claude`'s own standard location (`~/.claude/`), so **a session started by the StashBase panel and an external terminal / claude.ai are fully interoperable**—start on one side, resume on the other, no extra mechanism needed.

## 8.4 Structured panel (Claude, Phase 1)

Aligned with the VSCode Claude extension's structured panel: render the agent output into message bubbles, expandable tool calls, inline diff (approve / reject), and thinking blocks. **Phase 1 implemented** (for the feature list and phasing see [chat-panel.md](chat-panel.md)); plan mode, checkpoints / rewind / fork, the permission-mode dropdown, and UI MCP (driving the viewer) are subsequent phases.

Data flow:

```
AgentView (web-src) ──/ws/agent──> server/agent.ts ──Claude Agent SDK──> claude
  structured events <───── normalized wire protocol <───── SDKMessage stream / canUseTool
```

- **How it runs**: [server/agent.ts](../server/agent.ts)'s `AgentSession` uses `@anthropic-ai/claude-agent-sdk`'s `query()`, streaming-input mode (a `Pushable` queue feeds user messages, the session lives long). cwd = current space.
- **wire protocol** (line-JSON over `/ws/agent`): server→client are normalized events `text` / `thinking` (streaming deltas), `tool` / `tool-result` (with tool_use_id reconciliation), `permission`, `session-id` (the SDK `session_id`, for History to mark the current session), `turn-end` / `error` / `exit`; client→server are `prompt` / `permission-reply` / `set-mode` / `interrupt` / `close`. The SDK's `BetaMessage` / stream_event is normalized away on the server, and the renderer does not touch SDK types.
- **Permission round-trip**: in the SDK's `canUseTool` callback, read-class tools (Read / Grep / search…) are passed directly; write / execute class (Edit / Write / Bash / MCP write) round-trip to the client, suspending a Promise to wait for the user to approve/reject—this is the foundation of inline-diff approval. `updatedPermissions` ("always allow") has the interface reserved. **The permission mode** is controlled by the composer's "Modes" dropdown: `set-mode` → `query.setPermissionMode()` immediately switches `default` / `acceptEdits` / `plan` / `auto` (stacked with `canUseTool`: `acceptEdits` short-circuits approval on edit-class tools, while Bash etc. still fall to `canUseTool`). **Effort (thinking depth)** is different—the SDK only takes `effort` at `query()` construction, with no live setter, so it goes through the connection URL's `?effort=` parameter (`low…max`, default `high`); changing the level relies on reconnection: an empty session reconnects immediately, an existing conversation waits until the next new session. After reconnection the session returns to `permissionMode: 'default'`, so the renderer re-sends a `set-mode` once on `ready` per the current selection.
- **Config loading**: `settingSources: ['user','project','local']` lets the panel see the user's global + that space's CLAUDE.md / skills / MCP (including the KB MCP in ~/.claude.json); env clears `ELECTRON_RUN_AS_NODE`, passes `STASHBASE_WINDOW_ID`.
- **StashBase directional preamble**: relying on settingSources alone, the panel is a bare `claude` whose cwd happens to be at some space—the model does not know it is inside StashBase, does not know what `search_kb`/`reindex` are for, and cannot get the rulebook (these only arrive via the MCP `instructions` advisory field + an optional `kb_info` call, neither guaranteed). So `query()` uses `systemPrompt: { type:'preset', preset:'claude_code', append }` to **deterministically** inject a directional preamble ([server/agent-preamble.ts](../server/agent-preamble.ts)): the current space / sibling spaces (live), the use of the two MCP tools, and **the inlined STASHBASE.md rulebook** (KB-level baseline + the cwd's space-level overlay, reusing `getKbInfo()`, read-only no fork). The preamble is generated fresh per session (cwd is fixed within the session lifecycle). "Proactively query the KB" is **soft-recommendation** wording rather than a hard requirement—preserving the [§6.1](#61-call-entry) principle "when to use MCP / shell is decided by the agent itself".
- **Authentication**: the SDK reads the same credentials the user's `claude` login wrote down (Keychain / `~/.claude`), and a subscription (Pro/Max) is used directly without an API key—do not inject `ANTHROPIC_API_KEY` into env (its priority would override the subscription). See the authentication notes in [chat-panel.md](chat-panel.md) for details.
- **Lifecycle**: one tab one session; switching / closing the space → `killActiveAgent` disposes all, and the renderer shows "session ended".
- **History / resume**: the header History dropdown lists **all local Claude Code sessions** (not limited to the current space), with the SDK's on-disk session store as the foundation (`~/.claude/projects/`). Session management goes through [routes/sessions.ts](../server/routes/sessions.ts) (`/api/agent/sessions` list, `/:id/messages` get transcript, `PATCH` rename, `DELETE` delete)—**a global route, outside the `requireSpace` gate** (the list does not depend on an open space). Opening a session: first `getSessionMessages` maps the transcript into blocks isomorphic to the wire protocol (historical tools are always `done`/`error`) and renders them out, then reconnects `/ws/agent` with `?resume=<id>`, and `AgentSession` passes `resume` through to `query()`, and the SDK continues writing the same `session_id`. **Resume runs under the current space's cwd** (the panel is always bound to the current space), and recovering an old session across projects only loads its conversation history, continuing in the current space. `resume` and `effort` likewise are consumed only once on the connection URL and cleared after connecting, avoiding a mistaken resume on subsequent reconnections.
- **Packaging**: `@anthropic-ai/claude-agent-sdk` is external in [build-server.mjs](../scripts/build-server.mjs) (at runtime it locates the bundled `cli.js` by its own package directory, and bundling it into a single file would break the resolution), loaded from node_modules. The SDK and its pnpm store entries stay in `asarUnpack` because the platform-specific Claude CLI binary must be executable from disk. Python sidecars are platform-native too: [package-unsigned.mjs](../scripts/package-unsigned.mjs) refuses cross-OS Linux/Windows/macOS packages unless the prebuilt sidecars match the target binary format (ELF/PE/Mach-O), preventing a macOS PyInstaller daemon from being silently bundled into a Linux `.deb`.

On the renderer side, [AgentView.tsx](../web-src/src/components/AgentView.tsx) maintains an ordered block array (user / assistant / thinking / tool / error), incrementally updated by normalized events; the diff is computed client-side from the input of Edit/Write/MultiEdit (trim the common head and tail + a middle ±, not a full LCS). After it lands, the user-visible flows migrate into [use-cases.md](use-cases.md).

- **Attachment = temporary context (not into the KB)**: a local file via the composer `+` / dragged into the panel goes through [routes/attach.ts](../server/routes/attach.ts) (`POST /api/agent/attach`) written into the **OS temp directory** (`os.tmpdir()/stashbase-attachments/<uuid>/`, **not within any space**), returning an absolute path; on send the paths are listed at the end of the prompt, and the agent reads them with Read. **Deliberately not via `/api/upload`**—the attachment is one-shot context, it should not go into the file tree / index / git. A KB file dragged in from the sidebar directly references its existing space-relative path.

---

# 9. Maintenance

> StashBase relies on agents for continuous maintenance (generate summaries, build backlinks, categorize, dedupe). The maintenance rules are written in `STASHBASE.md`, triggered by the user and executed by the agent; all writes are ordinary files, fully visible and reversible.

## 9.1 STASHBASE.md: the agent contract file

Each KB / space can have a `STASHBASE.md`, telling the agent that this is a StashBase KB / space along with the maintenance rules. The KB-level `<KB>/STASHBASE.md` is common to the whole KB; the space-level `<KB>/<space>/STASHBASE.md` is for that space only (a new space gets an empty placeholder by default). The content is mainly natural language, executed by the agent per LLM understanding—**V1 enforces no schema**, the precise schema awaits a separate RFC.

## 9.2 How STASHBASE.md reaches the agent

`STASHBASE.md` is the single source of truth for rules. The agent obtains it via three paths, **none of which copies the file**:

- **MCP `instructions`**: the contract injected into the client's system prompt at connection—directing the agent to do CRUD with file tools, call `reindex` after writing, tag new files `generated_by`, and `kb_info` at the start.
- **MCP `kb_info()`**: the return carries the KB-level `STASHBASE.md`'s `rules`, and the agent reads it at the start.
- **Direct read**: `STASHBASE.md` (KB-level and space-level) are ordinary files, in the search index, and the agent can `search_kb` / directly read `<kb_root>/[<space>/]STASHBASE.md`; the space-level rules are right at that space's root, and the agent reads them directly when entering a space.

The user's `CLAUDE.md` / `AGENTS.md` are ordinary notes, which StashBase does not touch.

## 9.3 Maintenance operation list

V1's default maintenance operation types, combined and executed autonomously by the agent per `STASHBASE.md`:

| Operation | Description | Via |
|-|-|-|
| Generate summary | generate a summary HTML for a long document (peer file) | file tool write |
| Build backlink | insert a link in file A pointing to a related file B (`search_kb` discovers the association) | file tool edit |
| Categorize | move scattered files to the appropriate space / subdirectory | file tool mv |
| dedupe | near-duplicate content → merge / delete / add "see also" | file tool edit / rm |
| Structure | split scattered content (log / dump) into structured files | file tool edit |

All CRUD goes through the agent's own file tools, and after modifying it calls MCP `reindex` to make the changes queryable; discovering associations / judging duplicates relies on MCP `search_kb`.

## 9.4 Trigger model: user-triggered, no autonomy

**StashBase does not proactively schedule agents**—all maintenance is user-triggered: the user starts an agent in the builtin panel (or an external CLI) → the agent obtains the rules via MCP `kb_info` / directly reading `STASHBASE.md` ([§9.2](#92-how-stashbasemd-reaches-the-agent)) → the user gives an instruction ("organize the research space") → the agent executes per the rules + conversation context + the KB's actual state.

**Why not auto-schedule**: an LLM call costs tokens, and silently modifying the user's KB is a high-risk default; maintenance preferences / cadence vary by person; the agent CLI itself has an interactive loop, with the user and agent negotiating each maintenance scope. **Scheduled/background maintenance is explicitly not done** (settled 2026-06)—it fundamentally conflicts with the stance of "no background autonomy, no silent spending", and a scheduled task with "per-action confirmation" satisfies neither end: requiring human confirmation means it is not truly scheduled, and truly scheduled violates the stance. The once-considered "V2+ cron-like hook (opt-in)" has been rejected.

## 9.5 Observable & reversible

All of the agent's writes are **fully visible and undoable** to the user: they are all ordinary files in the file system (HTML / MD), viewable by Finder / git / any editor; the maintenance artifacts are all text with clear diffs, and the whole KB can be a git repo; the agent-generated peer files are tagged `generated_by: stashbase-agent` in in-file metadata, recognizable / cleanable in bulk.

**Failure handling**: `STASHBASE.md` missing → `kb_info`'s `rules` is empty, the agent goes by general behavior; rule conflict / ambiguity → the agent asks the user first; a file modified without calling `reindex` → reconcile auto-repairs the next time that space is opened.

---

# 10. Desktop UI

> The container layer and file viewing / editing experience the user directly faces when opening StashBase. The UI representation of each backend capability belongs to the corresponding module; the app container layer / file viewing-editing / cross-module UI mechanisms belong to this section.

## 10.1 Viewer: preview / edit dual mode

The main pane routes to the HTML / Markdown / source-code / PDF / image viewer by file type. Each file can switch between **preview** (rendered) and **edit** (source, CodeMirror)—switching loses no state, and find links across modes. Preview is the default entry (the user is "viewing" most of the time). PDF / image are binary, with no edit mode.

- **HTML**: rendered by a sandboxed iframe (`allow-scripts allow-same-origin`), with relative resources resolving via the `/asset/*` route to the sibling `<filename>_files/`. `allow-same-origin` lets the page get the real localhost origin—a bundler-type self-contained HTML (an entire `<script>` app) loads its own resources via `blob:http://` URLs produced by `URL.createObjectURL`, and without it the blob would be `blob:null/` and rejected; the main process's CSP accordingly allows `blob:` in `script-src`/`connect-src` (`server/index.ts`), with the iframe sandbox still the main security boundary (the same tradeoff as Obsidian / VS Code). Same-origin also lets the parent window attach listeners directly to the iframe document: when an OS file is dragged onto the preview area, `HtmlPreview` forwards `stashbase:iframe-drop` to `useGlobalDragDrop` for normal import (the same mechanism as `MarkdownPreview`). This is the concrete carrier of [overview](overview.md)'s "HTML First-class"—only HTML can truly render, embed images and formulas, and jump anchors.
- **Markdown**: iframe srcDoc (no scripts), rendered by `marked` (GFM + breaks), with headings given stable ids for in-file anchor jumps; cross-file relative links are intercepted by an outer hook and turned into in-app navigation.
- **PDF**: builtin PDF.js (`pdfjs-dist`) to browse the original; a search hit is located by in-page chunk-text search ([§6.7](#67-derived-hit-mapping-pdf--image)); on conversion failure it still opens the original + a top warning banner + Retry. Click a PDF to open the PDF, click md to open md—what you see is what you click, no sibling linkage (the extraction artifact is a hidden note that the user cannot open).
- **Image**: `<img>` loads directly from `/asset/*`, with an embedded preview, and clicking enters a lightbox to zoom (`ImagePreview` → `ImageLightbox`); the hit maps back to the original image ([§6.7](#67-derived-hit-mapping-pdf--image)), but does no in-page text locating.

## 10.2 Application framework and global mechanisms

- **Welcome**: the entry page on first launch / no active space, listing existing spaces + recents, with three entries **Open space / New space / Import folder** (no clone, see [§4.7](#47-space-level-import-and-snapshot)). On first launch and when the KB root is unconfigured (`GET /api/kb-root` returns `needsPicker`), a **mandatory** root-directory picker pops first (no cancel), which shares the `setKbRootConfirming` set-root primitive ([§2.4](#24-changing-the-kb-root-directory--optional-migration)) with the Settings → Storage root change.
- **Activity bar**: the left 44px icon rail, with **Files / Search** two mutually-exclusive views (`⌘⇧E` Files, `⌘⇧F` Search), default Files. Below Search is the **record button** (desktop only, a viewfinder + record-dot icon, turning into a red stop square while recording, see §4.8; the in-app screenshot button was removed); at the bottom is a fixed **Settings** gear (VSCode-style, pushed to the bottom by `margin-top:auto`). Clicking the icon of the already-active view = collapse the sidebar panel, clicking another view / clicking any icon when collapsed = expand to that view. The rail itself never collapses.
- **Scope faceting (KB ⊃ space two-tier, no multi-space in one window)**: the top of the Files view pins a small `KNOWLEDGE BASE` section, listing only one KB-level meta file—`STASHBASE.md` (the rulebook, KB root, bot icon, `getKbRules`), opened in the main pane as a kb-kind tab. Below it is the `SPACE` section (the current space name + file tree). **Per-space `STASHBASE.md` is not in the KB section**—it is physically at the space root, shown directly in the file tree, edited and saved in place as an ordinary file (via `/api/file`). Each file has only one entry, with scope obvious at a glance (global KB vs current space); it also avoids the agent-context ambiguity that "multi-space in one window" would bring (MCP / skills / rules / terminal cwd are all per-space, see [§2.3](#23-space-level-configuration)).
- **Sidebar width / collapse**: the resizable panel width to the right of the rail is driven by `state.sidebarWidth` (CSS var `--sidebar-width`, the `.app` grid's first column = `calc(44px + var)`). Dragging the right edge's `.sidebar-splitter` (absolutely positioned at `left: calc(44px + var)`, not occupying a grid track) adjusts width within `[SIDEBAR_MIN_WIDTH, MAX]` (200–520px); dragging narrower than `SIDEBAR_COLLAPSE_AT` (100px) sets `sidebarCollapsed` → leaving only the 44px rail (no separate collapse button). There is a hard breakpoint between collapsed ↔ expanded (0 vs 200px floor), so **dragging is handled as a "snapshot"**: in the collapsed state pulling right a few px pops open at the remembered width, in the expanded state dragging narrower than the threshold collapses, with each grab doing only one thing (during drag `.app.sidebar-dragging` turns off the grid transition, avoiding a gap). The constants and clamp are in `store/state.ts`.
- **Search UI** ([§6](#6-retrieval)): Semantic (default, goes through the daemon hybrid, results a chunk-level flat list) / Keyword (`≈`/`=` toggle, goes through the Node-side ripgrep (`@vscode/ripgrep`, `/api/keyword-search`) scanning the space folder, **not via the daemon**, results line-level file-grouped). Keyword is **literal matching** (ripgrep `--fixed-strings`), with whole-word filtered on the Node side by Unicode word characters `[\p{L}\p{N}_]`, returned after a UTF-8→UTF-16 offset conversion (`routes/indexing.ts:runRipgrep`). Click-jump + "fade-away" chunk highlight, consistent across the four viewers; the HTML/Markdown viewer's chunk locating uses **normalized three-anchor** matching (clean Markdown syntax + Unicode normalize, take head/mid/tail 80-character anchors and search the flattened DOM text, `server/html.ts:chunkAnchors`/`flattenDocumentText`)—Markdown rendering differences and CJK no longer drop the highlight.
- **Tab / split view**: single click = ephemeral preview (italic), double click = pin; edit mode can have a left editor + right live preview on the same screen (~80ms debounce).
- **FindBar** (in-file find): `⌘F` opens, a separate path from the cross-file keyword search.
- **Settings**: a tabbed container (fixed size, switching tabs does not change height), each panel's content belonging to the backend module—Storage (KB root directory), Capture (screenshot permission), Embedding ([§5](#5-indexing)), MCP ([§7](#7-mcp)). Agent selection has been moved from Settings to the two launcher buttons in the top right (Claude / Codex, [§8](#8-built-in-agents)).
- **Global mechanisms**: Hotkeys uniformly registered; ModalShell + Promise-based confirm / alert; DropVeil (drag-file visual feedback); Toast (bottom-right, errors persist, others auto-dismiss, replacing "failure pops a modal"); ImageLightbox; **multi-window** (window-id passed through via HTTP header + asset URL query, renderer state per-window). Theme: inherits the app's light / dark, no built-in theme system of its own.
- **`useHoverTip` hover tip** (`hooks/useHoverTip.tsx`): **native HTML `title` is unreliable in this Electron window**—hovering a rail icon for any length does not pop, and `app-chrome` is a `-webkit-app-region: drag` area where a native tooltip is swallowed entirely (which is why the top-right agent launcher never had a tip). So buttons landing in these two kinds of positions (the four activity-rail icons, the top-bar home, the top-right Claude/Codex launcher) use a self-rendered tooltip: after hovering 600ms, render a `position: fixed` bubble at the button's edge (the same trick as `<Menu>` to escape the sidebar's `overflow: hidden`—the rail is only 44px, and a pure CSS `::after` would be clipped), with `a11y` going through `aria-label`. **The style is deliberately light-colored**, aligned with the rest of the app still using native `title`'s light tips (sidebar buttons / file-tree rows)—globally there is only one look and feel. **Do not add `title` to these buttons again** (it would double-pop / not-pop); the rail bubble faces right, the top-bar buttons face down (hugging the window top, facing up would go off-screen). The skin `.hover-tip` is in `styles/globals.css`.
- **`<Menu>` popup-menu primitive** (`components/Menu.tsx`): the single exit for all popup menus—the sidebar's `⋯` (space operations) / new-note picker go by rect anchor (hugging the button's bottom-left), the file-tree right-click `ContextMenu` (`components/Overlays.tsx`, driven by `state.ctxMenu`) goes by cursor-point anchor. The component uniformly handles **viewport-aware positioning** (`position: fixed` + measure-then-clamp, flip upward when there is not enough space; the old scattered `right: 0` hand-positioning would be clipped under the icon rail by a narrow sidebar's `overflow: hidden`), click-outside / Esc / blur close, and arrow-key navigation. A new menu = pass one `MenuItem[]` (supporting `detail` subtitle / `shortcut` right-aligned hint / `danger` / `disabled` / `separator`), no longer copying positioning logic. The skin is in `styles/menu.css`.

---

# 11. Putting Everything Together

A user sees a piece of content and decides to save it → the content enters the Memory Layer (stored on disk in open formats, immediately visible in the UI) → the index is built asynchronously in the background (chunk + embed + store) → the Agent retrieves relevant memories when needed (hybrid retrieval, via MCP or the built-in chat) → the Agent continuously maintains these memories during work (filling in metadata, generating summaries, building associations, all ordinary files that are visible and reversible).

```text
User → Stash → Storage → Indexing → Retrieval → Agents → Maintenance
```

The user is responsible for deciding what is worth remembering, and the Agent is responsible for keeping these memories usable. This is StashBase's overall architecture.
