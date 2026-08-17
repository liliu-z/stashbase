# Agent Panel

> Renderer contract for Chat tabs, transcript state, composer interaction,
> permissions, history handoff, and adaptive layout. Native process behavior
> lives in [Agent Runtime](agent-runtime.md).

## State Model

- Each tab records Agent id, blankness, explicit or connected scope, title,
  and renderer transcript state. A tab is completely blank only when it has no
  transcript, queued prompt, active turn, explicit scope, resume identity,
  draft, or attachments.
- New Chat reuses one completely blank tab, switching its Agent in place when
  required. Otherwise it creates a new tab. No started tab is hijacked.
- A blank tab may follow a window folder switch. Draft or attachments freeze
  the scope visible to the user; content and resumed history remain pinned.
- A scope-specific History selection records one pending handoff. The active
  suitable blank tab consumes it exactly once before reconnecting.
- Runtime readiness gates Chat before transport connection. Failed gates use
  the structured preparation failure stage and advertised manual recovery:
  installation can copy an install command, Codex authentication can start the
  selected runtime's browser login, MCP can open manual setup, and simulated
  failures can remain retry-only. Error prose never selects an action.
  Installation and authentication failures retain a separate **Check again**
  action; it calls the no-download discovery path so external recovery does not
  silently grant installation consent or start another login.
- Tab activation and history resume only select renderer state. A missing
  runtime remains on the setup gate until **Install and continue**; activation
  code must not call the preparation endpoint speculatively.
- A validated `scope-changed` event may migrate only the same live
  Library-scoped Chat that created a project. Update the tab binding before the
  owning window enters the new member so the conversation stays selected;
  other windows receive membership only. If folder entry fails, keep the new
  project scope visible and report an actionable open failure rather than
  reverting to an ambiguous Library presentation.

## Layout and Visibility

- Initialize with Chat open; do not first paint a collapsed panel and reveal it
  from a later effect.
- Chat-primary and docked layouts retain the same mounted session, composer,
  draft, transcript, streaming state, attachments, scroll position, and
  remembered side-panel width.
- Opening a document docks Chat. Closing the last document expands an open
  Chat. Compact view may prioritize a newly opened document, but a subsequent
  explicit Chat reveal wins until the user changes visibility again.
- Hidden zero-width surfaces are inert. Splitters expose keyboard-accessible
  value semantics and respect reduced motion.

## Composer and Controls

- The sidebar New Chat split button is the only creation/Agent-selection
  surface. Its chevron changes preference without creating a chat.
- The scope picker is available before session binding and remains visible but
  locked after binding. Model and effort come from runtime capabilities;
  Default remains an omitted override. Locked controls stay legible and inert.
- CodeMirror owns composer text, selection, undo, and `@`/`/` key handoff. The
  UI remains a capped-height chat input, not an editor workbench.
- Suggestions only prefill a draft; they never send. Their rotation pauses
  while hovered or focused.
- File and image context is explicit through mentions, selection, drag/drop, or
  composer-focused paste. Image paste suppresses the competing library-import
  offer and preserves accompanying text.
- Transient attachment upload preserves the user-visible Unicode basename
  by parsing multipart filename parameters as UTF-8. The server still
  sanitizes and uniquifies every supplied display name before writing.
- A selected skill appears as an inline display token and applies only to the
  next turn; it is not serialized as ordinary prompt text.

## Transcript and Turn Lifecycle

- Streaming follows the bottom only while the user remains there. Otherwise a
  jump-to-latest control appears.
- A terminal failure creates at most one persistent turn explanation, preferring
  the runtime's specific message. Record it before advancing queued follow-ups.
- Completed thinking, interim narration, and tool activity fold under one
  working-trace header while the final answer remains visible. Interrupted work
  stays expanded. Resumed history has no invented duration.
- Tool activity is compact and inspectable. Intermediate failure may tint its
  row but does not turn the whole summary into a terminal error.
- Permission requests and recovery actions never enter collapsed activity.
- User messages expose copy and edit-and-resend. Resend is a new prompt, never
  transcript rewind or fork. When another turn is active, enqueue the edited
  prompt first, interrupt the old turn, and start the edit only through the
  terminal queue handoff; ordinary composer follow-ups remain non-interrupting.
- File-changing tools refresh source/index state but never select the output.
  Artifact and local-link actions use the folder-safe workspace path.

## Rendering and Accessibility

- Agent response Markdown is rendered as React elements with GFM behavior. Raw
  HTML, remote images, and unsafe schemes remain inert.
- The same shared renderer parses `$...$`, `$$...$$`, `\(...\)`, and
  `\[...\]` into untrusted, locally bundled KaTeX output for both runtimes
  and restored history. Its delimiter normalization must remain
  Markdown-aware: code, escapes, incomplete streaming input, and currency
  prose stay literal; invalid TeX degrades visibly. Keep KaTeX and its fonts
  behind a math-present dynamic boundary so ordinary chat does not pay that
  parse/render weight. Copy Reply continues to use the untouched assistant
  source; local links continue through the folder-safe workspace callback.
  Display overflow belongs to the formula block, not the transcript or
  panel.
- Managed primitives own focus trapping, Escape, outside press, collision,
  timers, and announcements. Do not add document-level dismissal handlers.
- Permission actions restore focus to a persistent part of the card after their
  controls disappear.
- Attachment paths are machine context, not visible prose. Restored transient
  images are previewed only from the private attachment root; arbitrary history
  paths never become readable URLs.
- Active thinking or tool work has one liveness cue at a time and becomes
  static under reduced motion.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Panel boundary | `web-src/src/components/ChatPane.tsx` and `AgentView.tsx` |
| Transcript/composer Modules | `web-src/src/components/agent/AgentMessages.tsx`, `AgentComposer.tsx`, `MentionComposer.tsx`, and `SessionHistoryMenu.tsx` |
| State Interfaces | Chat tab state/actions in `web-src/src/store/state.ts` and `stateReducer.ts`; activation consent in `components/agent/chatActivation.ts`; focused pure state Modules under `components/agent/` |
| Runtime transport Adapter | connection URL/lifecycle Modules and `runtimeFailurePresentation.ts` under `components/agent/` over the normalized [Agent Runtime](agent-runtime.md) protocol |
| Attachment HTTP Adapter | `web-src/src/api.ts` and `server/routes/attach.ts` |
| Markdown Adapter | `web-src/src/components/agent/AgentMarkdown.tsx` |
| Focused evidence | `web-src/src/__tests__/agent-*.test.ts`, `e2e/fixtures/fake-codex-app-server.test.mjs`, and `e2e/journeys/agent-panel.spec.ts` |

## Validation

Run:

```bash
pnpm typecheck
pnpm test:renderer
pnpm test:agent
pnpm build:web
```

Run `pnpm test:e2e:functional` for the affected Agent journey and
`pnpm test:e2e:visual` for covered composition changes. Exact protocol fixture
sequences belong in tests. Real credentials, packaged discovery, and
clipboard/native Seams remain in release sanity.

Related journeys: [J01](../design-docs/user-journeys.md#j01-complete-onboarding-and-reach-first-value),
[J06](../design-docs/user-journeys.md#j06-start-and-continue-an-agent-chat), and
[J07](../design-docs/user-journeys.md#j07-converge-chat-into-a-document), plus
the [J10](../design-docs/user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work)
core loop and
[J11](../design-docs/user-journeys.md#j11-turn-a-conversation-into-a-project)
for the Library-to-project session transition.

Related contracts: [Agent Runtime](agent-runtime.md),
[MCP Access](mcp-access.md), [Renderer Styling](renderer-styling.md), and
[UI Regression Testing](ui-regression-testing.md).
