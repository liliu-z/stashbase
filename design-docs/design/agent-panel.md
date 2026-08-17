# Agent Panel

## User Outcome

People collaborate with a supported local Agent against an explicit library or
folder scope, then bring durable results back into ordinary local files.

## Scope and Non-goals

The Agent Panel is the product capability; Chat is its visible conversation
surface. This area owns built-in Chat creation, tabs, scope selection,
transcript, composer, attachments, permissions, history, and adaptive layout.
Runtime installation, native process ownership, MCP access, and indexing have
separate engineering contracts.

The panel is not a closed StashBase Agent product, a separate AI workspace, or
a transcript-centered file manager.

## Current Experience

- Chat begins expanded. With no document it is the primary work surface;
  opening a source docks the same mounted session beside it, and closing the
  last source expands an open Chat again.
- New Chat is the deliberate creation entry and reuses a completely blank tab.
  Opening the app, a folder, a tab, or history never grants runtime-installation
  consent; a missing runtime waits for **Install and continue**.
- An installed but signed-out Codex runtime stops at a dedicated sign-in gate.
  **Sign in with ChatGPT** runs that same discovered executable's official
  browser flow; completion resumes preparation without another installation.
- Every conversation is scoped to Library or one member folder. Drafts,
  attachments, content, and resumed history freeze that scope, while folder
  switching preserves started work. History remains attributable to its Agent
  and home scope.
- Runtime capabilities determine model, permission, and effort controls without
  rewriting global CLI defaults. Suggestions prefill rather than send.
- Streaming, tool activity, permissions, attachments, skills, recovery, and
  file artifacts remain inspectable. Editing and resending an earlier prompt
  stops conflicting active work before beginning the new turn.
- Attachment labels preserve user-visible Unicode filenames from selection or
  drop through the sent transcript and restored history.
- Source and attachment access follows the
  [Documents format matrix](documents.md#format-capability-matrix). Built-in
  image attachment behavior does not imply that every external MCP client can
  read image bytes, and previewability does not imply content-write access.
- Document context is explicit. Agent-created files refresh the workspace but
  open only when selected; project creation rebinds only an attributed eligible
  library chat.
- Responses support GFM and local math rendering while preserving original
  Markdown for history and copy. Raw HTML, remote images, unsafe links, and
  invalid formulas remain inert or visibly recoverable.

## Experience Contract

- Chat-primary and docked layouts are two presentations of the same mounted
  session. Transcript, streaming, draft, attachments, scroll, and remembered
  width survive the transition.
- Respect explicit visibility. Initialization opens Chat; later automatic
  layout changes do not override a user hide or reveal.
- Opening, switching, or resuming an Agent tab is not installation consent.
  Each missing runtime waits for its own explicit setup action.
- A runtime, transport, or turn failure leaves one persistent explanation and
  a truthful, stage-specific recovery path. Retrying preparation resumes from
  the first incomplete stage. After an installation failure, **Check again**
  remains available so an external repair can be discovered without
  authorizing another download. Authentication is distinct from installation:
  in-app sign-in uses the selected Codex runtime and never handles its token,
  while **Check again** discovers a login completed elsewhere. Late output
  from an abandoned generation cannot enter a newer turn.
- Permission, deletion, command, network, and broader filesystem decisions
  remain explicit. Tool payloads render in a human-readable form.
- Agent copy and tool affordances describe the actual source or prepared
  representation and never advertise a broader format capability than the
  selected surface provides.
- Streaming does not steal the reading position of someone inspecting earlier
  content.
- Agent response Markdown treats raw HTML and remote images as inert; only
  validated workspace links and HTTP(S) links are active.
- Discovering and invoking a runtime skill never installs, edits, or exposes
  the skill implementation through the composer.
- Turning a Library conversation into a project follows an explicit user
  decision. The same Chat may rebind to the newly registered ordinary folder;
  later tool and file work uses that project as its working folder while native
  session identity and transcript remain continuous. The transcript is never
  copied into source files without a separate explicit write.

## Cross-area Seams

- [Workspace](workspace.md) owns the current folder, source tabs, and shell.
- [Documents](documents.md) owns source editing beside Chat.
- [Search](search.md) owns retrieval identity and readiness.
- [Agent Runtime](../../code-review/agent-runtime.md) owns native lifecycle.
- [MCP Access](../../code-review/mcp-access.md) owns Agent file boundaries.

## Contribution Direction

### Next

- Improve transcript scanning, tool summaries, and file-change presentation.
- Improve attachment, mention, and focused context handoff.
- Clarify runtime, recovery, settings, and context diagnostics.
- Continue refining the compact, low-chrome adaptive layout.

### Coordinate First

- Permission policy, auto-approval, tool execution, or filesystem scope.
- Session lifecycle, history identity, or new context-passing behavior.
- MCP, indexing, or file behavior added only for panel presentation.

### Not Planned

- A second knowledge store or StashBase-owned closed Agent service.
- Implicit current-document context.
- Presentation that weakens explicit access or recovery decisions.

## Related Journeys and Contracts

Journeys: [J01](../user-journeys.md#j01-complete-onboarding-and-reach-first-value),
[J06](../user-journeys.md#j06-start-and-continue-an-agent-chat), and
[J07](../user-journeys.md#j07-converge-chat-into-a-document). The complete
source-to-Agent-to-source route is the
[J10](../user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work)
core loop. A Library Chat becomes a new durable project through
[J11](../user-journeys.md#j11-turn-a-conversation-into-a-project).

Contracts: [Agent Panel](../../code-review/agent-panel.md),
[Agent Runtime](../../code-review/agent-runtime.md),
[Settings and Config](../../code-review/settings-config.md), and
[MCP Access](../../code-review/mcp-access.md). Agent writes additionally cross
[File Transactions](../../code-review/file-transactions.md); use the canonical
route for [J07](../../code-review/journey-coverage.md#traceability-map).
