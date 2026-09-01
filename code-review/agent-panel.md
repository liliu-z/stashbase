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
- Build Wiki promotes the shown folder to an explicit pick immediately. Its
  renderer-local pending intent counts as non-blank, locks the scope control,
  survives the setup/runtime reconnects it initiated, and clears before its
  one preset send. Cancel restores the prior pick; folder retirement drops the
  intent; no reducer or native history persists it across restart.
- A structured `scope-removed` exit retires only Chats bound to that member. A
  completely blank tab reconnects in place with an explicit Library scope. A
  tab containing any user work preserves its tab, draft, attachments,
  transcript, queued follow-ups, and history identity in a closed neutral
  state; **New Library Chat** creates a separate tab whose first connection is
  Library-scoped even when the window is browsing another folder.
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
- Built-in is the default blank-chat preference and appears after Codex and
  Claude Code in selection surfaces. Its quiet second line is **Sign in for
  free credits** while signed out and **Free credits included** after sign-in.
  Its gate distinguishes
  account-required from runtime installation, and Settings shows its fixed
  seven-day allowance as remaining percentage and reset time beside the Codex
  and Claude Code alternatives. Dollar values and model selection remain
  hidden in the first release.
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
- The composer holds one width across empty chat and full transcript, and the
  transcript's reading column matches that card. Sending the first message
  changes the composer's vertical placement and resting height, never its
  measure.
- Opening a document docks Chat. Closing the last document expands an open
  Chat. Compact view may prioritize a newly opened document, but a subsequent
  explicit Chat reveal wins until the user changes visibility again.
- Hidden zero-width surfaces are inert. Splitters expose keyboard-accessible
  value semantics and respect reduced motion.

## Composer and Controls

- The sidebar New Chat split button is the only creation/Agent-selection
  surface. Its agent picker — the named agent and its chevron form one
  control — changes preference without creating a chat. The row carries no
  hover surface of its own: each target in it highlights only its own box,
  and a rule separates the New Chat/agent pair from chat history.
- The scope picker is available before session binding and remains visible and
  openable after binding, with its scope rows locked in place. Model and effort come from runtime capabilities, and
  Default remains an omitted override. An idle Codex conversation applies a
  model choice to its next turn on the same thread; its row is disabled only
  during an active turn. Before a fresh Codex thread reports its actual model,
  the control says Default rather than speculating from catalog metadata. A
  populated Claude conversation keeps its model fixed.
  Locked controls stay legible and inert at the smallest surface that cannot
  act: a pinned setting dims its own row — still naming its value and why —
  while sibling settings stay adjustable, and a pill goes inert only when
  everything behind it is pinned.
- Mode is its own pill: permission state must read without opening a menu, and
  the Shift-Tab cycle has to land somewhere visible. Model and effort share
  the settings pill over a two-level menu — the parent holds one value row per
  setting and each row opens a single-list flyout, so no card ever stacks two
  headed lists. The trigger names the model and appends effort only when
  explicitly overridden; a default or inherited effort claims no bar space.
  When a runtime advertises only one of the two settings, the pill opens that
  list directly.
- Similarity Search is one switch row pinned under the session scope popup's
  folder list, never an entry in Mode or the model settings menu. The switch is
  required, not stylistic: the scope rows above it are a radio list whose
  selected row wears a check, so a check on this row would make one glyph mean
  "the one selected" and "on" inside a single popup. The row stays ONE control
  semantically — a `menuitemcheckbox` whose indicator is drawn as a track and
  thumb — rather than a menu item with a second focusable switch inside it. It
  belongs with scope because the two are one question in halves — scope is what
  a lookup may reach, this is how it matches — and it belongs INSIDE that popup
  rather than beside it on the composer bar, because the bar's width is the
  docked panel's width and this is the row's least-touched setting. A checkbox
  is load-bearing, not cosmetic: checked ADDS meaning-based retrieval on top of
  text matching that never goes away, so the control must never present as a
  switch over search itself. Off does not stop search. Its explicit state
  belongs to the mounted Chat session. Checking it without available Similarity
  Search opens setup; unchecked keeps library search available through direct
  and current prepared text.
- Hosting independent scope controls makes the popup openable for the life of
  the conversation. The binding lock is a rule about the scope VALUE, so a bound
  Chat dims and disables the scope rows in place and says why, rather than
  killing the trigger and taking the retrieval setting down with it.
- For a Chat with a concrete working folder, Agent Instructions is an action
  beside the Chat tab list, outside the APG `tablist` and the conversation's
  scope popup. It resolves the active tab's connected folder (or its visible
  window folder before binding), opens a
  managed modal, and loads and saves through the folder-scoped HTTP contract.
  A Library-wide Chat has no concrete working directory, uses the packaged
  default, and shows no Instructions editor. A quiet customized marker updates
  after reads and saves; the absence of that marker means the packaged default
  is active. Copy says a save applies from the next message and never claims to
  edit `AGENTS.md` or `CLAUDE.md`.
- It is a glyph, not a labelled button: it shares a row whose purpose is
  showing which conversations are open, and a label there costs tab width that
  a docked panel does not have. Its one tooltip doubles as the accessible name
  and names the scope, because which scope it edits follows the active tab and
  the button cannot show that. It aligns to the chat-panel toggle beside it,
  not to the tab baseline — two adjacent glyph buttons share a centre line, and
  the toggle's is the titlebar band's, measured from the pane top so tab height
  cannot move it.
- A save applies to live sessions, not only to Chats started later. The
  resolved instructions are injected when a native session mounts and no
  Adapter has a live setter for them, so applying an edit means REMOUNTING — resume in place when
  the conversation has content so the transcript survives, plain reconnect when
  it is blank. This is the same move a thinking-effort change makes, which is
  why it needs no adapter-specific server path. A session remounts only for its
  own connected folder, and defers to turn-end while a turn is in flight rather
  than stranding a streaming reply.
- The save is announced as a folder-addressed broadcast, not a callback to the
  tab that opened the editor. Several mounted Chats can share one folder, so
  each session decides for itself whether the saved
  folder is its own; a threaded callback would reach one session and silently
  miss its siblings.
- The editor is a text field, not a form of caveats. One line under it carries
  the only non-obvious consequence (guidance takes effect from the next
  message); the character tally appears only near the cap; the description
  names the working folder and stops. The folder name is emphasis by weight —
  accent there read as a link to
  somewhere the press does not go.
- An unwritten folder opens with the packaged default as real editable text.
  Clearing and saving removes the customization and reloads that default. The
  default is short, user-visible Markdown organized around answering questions,
  making changes, and maintaining Wiki Pages; it states no permission rule,
  which is the Mode control's to enforce.
- CodeMirror owns composer text, selection, undo, and `@`/`/` key handoff. The
  UI remains a capped-height chat input, not an editor workbench.
- An empty composition renders no rotating suggestion carousel. Folder scope
  adds one fixed Build Wiki capsule directly below the composer; it disappears
  for a draft or attachment. Build Wiki sends immediately because it is a
  complete action.
- The preset sends the same concise text shown in the transcript. Durable Wiki
  behavior lives only in Agent Instructions; the action must not carry a second
  hidden prompt.
- File and image context is explicit through mentions and each runtime's
  advertised attachment capability. Selection, drag/drop, and composer-focused
  paste are available only when that runtime can actually read the uploaded
  bytes; image paste then suppresses the competing library-import offer and
  preserves accompanying text.
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
- Active-turn follow-ups live in the renderer queue until the terminal handoff.
  A waiting item may be deleted by id without interrupting the current turn or
  changing its siblings; once steering has begun, a stale delete cannot discard
  the in-flight item.
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
  stays expanded. Resumed history has no invented duration or timestamp:
  hover message times render only when a real clock recorded them — the
  live renderer for this session's messages, or the history source's own
  per-message/turn times (Claude native transcript lines; Codex turn
  boundaries).
- Tool activity is compact and inspectable. Its collapsed category summary
  omits exact counts but preserves singular/plural grammar from the underlying
  actions. Intermediate failure may tint its row but does not turn the whole
  summary into a terminal error.
- OpenCode native file Diffs enter the same settled file-change surface, and
  OpenCode tool names are already normalized before renderer state sees them.
- Scope retirement is not a fatal transport state. Running or
  permission-waiting tools and queued follow-ups become cancelled history;
  settled content remains unchanged, no generic Retry/Reconnect appears, and
  a raw socket close still follows the ordinary failure path.
- Permission requests and recovery actions never enter collapsed activity.
- Every settled reply exposes one standing Copy Reply control — always
  visible, never hover- or menu-gated — carrying the untouched assistant
  source. User messages expose copy and edit-and-resend. Resend is a new prompt, never
  transcript rewind or fork. When another turn is active, enqueue the edited
  prompt first, interrupt the old turn, and start the edit only through the
  terminal queue handoff; ordinary composer follow-ups remain non-interrupting.
- File-changing tools refresh source/index state but never select the output.
  Artifact and local-link actions use the folder-safe workspace path.

## Rendering and Accessibility

- The chat tab strip follows the APG tabs pattern: a `tab` carries no
  interactive descendant. The visual close × is pointer-only — hidden from
  the accessibility tree and the tab order, so keyboard focus never lands on
  an invisible control — and Delete on the focused tab closes it.
- The transcript log announces appends politely, but the one in-flight turn
  is `aria-busy` until it settles so token streaming does not re-announce
  the live tail. Each turn states its speaker for linearized reading
  (visually hidden "You:" / agent-short-name prefixes); bubble alignment
  alone is not attribution. Hand-rolled disclosure toggles (activity groups,
  tool rows, thinking) reference the panel they reveal via `aria-controls`,
  matching the Collapsible primitive's wiring.
- Pane-level state cards (runtime gates, the empty-chat greeting, the
  whole-pane fatal card) head the pane's outline at `h2`;
  transcript-inline cards (inline fatal, permission asks, turn-failure
  guidance) sit at `h3`.
- Agent response Markdown is rendered as React elements with GFM behavior. Raw
  HTML, remote images, and unsafe schemes remain inert.
- The same shared renderer parses `$...$`, `$$...$$`, `\(...\)`, and
  `\[...\]` into untrusted, locally bundled KaTeX output for every runtime
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
| Account-state projection | `web-src/src/common/lib/accountEvents.ts` publishes the last resolved signed-in state from the lazy `useHostedAccount` owner; eager `NewChatButton.tsx` subscribes to that narrow snapshot so its Built-in credit line changes with identity without pulling account API or OAuth code into the initial bundle |
| Sidebar entry points | `web-src/src/features/agent-panel/components/NewChatButton.tsx` (the split button, and the only reader of the next-chat agent preference) and `ScopeHistoryButton.tsx` (the per-scope history clock, which owns the `SessionHistoryMenu` lazy boundary). Both are exported from the feature barrel and merely placed by `app/components/Sidebar.tsx`; the sidebar holds no Agent logic of its own |
| Session state Interface | `web-src/src/features/agent-panel/hooks/useAgentSession.ts` owns transport, event routing, session reset/resume, and the tab-local pending Build Wiki intent, and composes the focused sub-hooks beside it in `web-src/src/features/agent-panel/hooks/`. It returns those owners as named groups (controls, queue, mentions, skills, runtime, transcript, wiki) rather than one flat surface; the transcript rules its events imply are pure Modules in `lib/transcriptEvents.ts` |
| Transcript/composer Modules | `web-src/src/features/agent-panel/components/AgentMessages.tsx` owns the block list and turn layout over the pure turn model in `lib/turnModel.ts`, with the user half in `AgentUserTurn.tsx` and the tool surface in `AgentToolActivity.tsx`; `AgentComposer.tsx` owns the draft, its send predicate, and the control bar, passing only `SimilaritySearchControl.tsx` into the shared `ScopeMenu` footer; `ChatPane.tsx` places `AgentInstructionsControl.tsx` beside the tab list and owns the captured scope for `AgentInstructionsModal.tsx`; `useAgentInstructionsEditor.ts` owns presence reads plus dialog API ordering and errors; `AgentEmptyState.tsx` owns the blank-chat greeting and Build Wiki action, and `lib/buildWikiPagesPrompt.ts` owns the preset contract; `MentionComposer.tsx`, `ComposerPills.tsx`, and `SessionHistoryMenu.tsx` own their focused controls |
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
[J07](../design-docs/user-journeys.md#j07-converge-chat-into-a-document),
[J12](../design-docs/user-journeys.md#j12-build-wiki-pages-from-a-local-folder), plus
the [J10](../design-docs/user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work)
core loop and
[J11](../design-docs/user-journeys.md#j11-turn-a-conversation-into-a-project)
for the Library-to-project session transition.

Related contracts: [Agent Runtime](agent-runtime.md),
[MCP Access](mcp-access.md), [Renderer Styling](renderer-styling.md), and
[UI Regression Testing](ui-regression-testing.md).
