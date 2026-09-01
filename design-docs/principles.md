# Principles
These are the stable rules used to evaluate product and technical decisions.

1. **Agent-native** — StashBase exists to make local files stable context that
   agents can read, search, and reuse.
2. **File-first** — Local files are the source of truth. Previews, extracted
   text, indexes, and app state are derived from them.
3. **Local-first** — The core path runs on the user's computer. Optional cloud
   capabilities must not be required to browse, prepare, or retrieve local
   context.
4. **Bring your own agent** — The included Built-in Agent removes setup as a
   prerequisite; it does not create lock-in. The same library and MCP operation
   layer continue to work with Codex, Claude Code, and external MCP clients.
5. **User-controlled access** — Agents only receive the file access the user
   has explicitly authorized. Context tools are not a general host-filesystem
   escape hatch.
6. **Machine-derived data stays invisible** — Extracted representations,
   chunks, and vectors can support reading and search without becoming
   user-managed files. Agent-authored Wiki Page Markdown is different: it is a
   visible, ordinary, user-owned file that links back to Sources.
7. **Useful before perfect** — Browsing, editing, and Exact Search should
   remain useful while preparation is incomplete or Similarity Search is
   unavailable.
8. **Broad capability, few concepts** — AI can improve many parts of the
   workflow, so capability breadth is welcome when it strengthens the same
   local-file-to-agent-context loop. New work must reuse the product's source,
   library, scope, permission, and recovery concepts rather than creating a
   second world for users to understand.
