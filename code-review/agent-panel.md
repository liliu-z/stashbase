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
- Text, an attachment, or a selected skill each make a draft sendable. The
  send control's enablement and the submit path must decide that from one
  predicate, so the button can never offer a send the composer refuses.

## Transcript and Turn Lifecycle

- Streaming follows the bottom only while the user remains there. Otherwise a
  jump-to-latest control appears.
- A terminal failure creates at most one persistent turn explanation, preferring
  the runtime's specific message. Record it before advancing queued follow-ups.
- A non-fatal runtime notice appends transcript evidence without refreshing
  runtime failure state, explaining a turn error, or closing a session when it
  arrives before readiness. It uses polite warning semantics rather than an
  alert and remains visible when there is no final answer to carry the turn.
- A classified turn failure renders as a recovery card whose action follows the
  adapter-assigned kind only (see the turn-failure contract in
  [Agent Runtime](agent-runtime.md#protocol-boundary)); guidance copy and the
  settle-then-auto-retry behavior live in
  `web-src/src/features/agent-panel/lib/turnFailure.ts` and
  `hooks/useAgentSession.ts`. The retry belongs to the card's own turn — the
  nearest user prompt above the card, never the transcript's newest.
- Completed thinking, interim narration, and tool activity fold under one
  working-trace header while the final answer remains visible. Interrupted work
  stays expanded. Resumed history has no invented duration.
- Tool activity is compact and inspectable. Its collapsed category summary
  omits exact counts but preserves singular/plural grammar from the underlying
  actions. Intermediate failure may tint its row but does not turn the whole
  summary into a terminal error.
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
| Panel boundary | `web-src/src/features/agent-panel/components/ChatPane.tsx` and `AgentView.tsx` |
| Window-level catalog prime | `web-src/src/features/agent-panel/hooks/useAgentCatalogPrime.ts` — the one eager runtime read, called from `app/App.tsx` because every chat surface is lazy |
| Sidebar entry points | `web-src/src/features/agent-panel/components/NewChatButton.tsx` (the split button, and the only reader of the next-chat agent preference) and `ScopeHistoryButton.tsx` (the per-scope history clock, which owns the `SessionHistoryMenu` lazy boundary). Both are exported from the feature barrel and merely placed by `app/components/Sidebar.tsx`; the sidebar holds no Agent logic of its own |
| Session state Interface | `web-src/src/features/agent-panel/hooks/useAgentSession.ts` owns transport, event routing, and session reset/resume, and composes the focused sub-hooks beside it in `web-src/src/features/agent-panel/hooks/`. It returns those sub-hooks as owner-named groups (controls, queue, mentions, skills, runtime, transcript) rather than one flat surface; the transcript rules its events imply are pure Modules in `lib/transcriptEvents.ts` |
| Transcript/composer Modules | `web-src/src/features/agent-panel/components/AgentMessages.tsx` owns the block list and turn layout over the pure turn model in `lib/turnModel.ts`, with the user half in `AgentUserTurn.tsx` and the tool surface in `AgentToolActivity.tsx`; `AgentComposer.tsx` owns the draft and its send predicate, with the suggestion popup in `MentionSuggestions.tsx` and the session pills in `ComposerPills.tsx`; `MentionComposer.tsx`, and `SessionHistoryMenu.tsx` over `hooks/useSessionHistory.ts`, which merges both agents' listings and routes a rename or delete through the row's own agent and scope |
| State Interfaces | Chat tab state/actions in `web-src/src/store/state/state.ts` and `state/stateReducer.ts`; activation consent in the `activateChatTab` action (`store/contexts/AppContext.tsx`) over `store/lib/chatTabPlan.ts`; focused pure state Modules under `features/agent-panel/lib/` |
| Runtime transport Adapter | connection URL/lifecycle Modules and `runtimeFailurePresentation.ts` under `features/agent-panel/lib/` over the normalized [Agent Runtime](agent-runtime.md) protocol |
| Attachment HTTP Adapter | `web-src/src/common/api/api.ts` and `server/routes/attach.ts` |
| Markdown Adapter | `web-src/src/features/agent-panel/components/AgentMarkdown.tsx` |
| Focused evidence | `web-src/src/features/agent-panel/__tests__/agent-*.test.ts`, `e2e/fixtures/fake-codex-app-server.test.mjs`, and `e2e/journeys/agent-panel.spec.ts` |

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
