# Agent Sessions

## Scope

Chat mode and the agent pane in Documents share conversation identity, execution,
and unfinished requests. Default, Codex, Claude, and Antigravity expose their
actual capabilities through this common experience.

## Identity and Continuity

- A conversation belongs to a project, agent, and native session. Restore it once;
  duplicate titles are valid. Automatic naming never replaces a manual title.
- Codex conversations keep one local native writer across windows. Reconnecting
  waits for a retiring writer to exit; opening an already-owned conversation
  explains the conflict without interrupting its current chat or replaying work.
- A completely blank chat may be reused. Drafts, context, queued requests, and
  started transcripts remain reachable when navigating or switching modes.
- Changing agent before the first send preserves the draft and clears the skill
  choice without a switch notice. The selected agent's saved model and thinking
  preferences apply when supported. Unsupported context still needs an
  actionable explanation. Changing agent after starting creates another
  conversation; it does not transfer history.
- Project removal stops active work, retains transcripts, and disables sending.
  A conversation never migrates to another project.
- Antigravity keeps no history StashBase can read. StashBase therefore records
  the Antigravity conversations its chats start: their project, title, and the
  turns as the chat showed them. Restoring one continues the same Antigravity
  conversation. Removing it from the chat list removes StashBase's record; the
  conversation stays in Antigravity.

## Choice and Readiness

A project keeps its explicitly selected agent. A project without its own choice
inherits the user's latest explicit agent selection across projects, including
after restart, so an existing native subscription remains the starting point.
With no remembered selection, use **Default**, even when signed out. Explicitly
choosing Default also makes it the starting point for new projects. Model, effort,
and persona changes, readiness, and history restoration never rewrite this choice.
[Account and Settings](account-settings.md) owns access prerequisites and credentials.
The [Chat journey](../journeys/chat.md#first-send) owns the first-send interaction.

Setup acknowledgement is not readiness. Standalone setup never sends a draft.
Only the still-current submission that explicitly requested access may continue
once setup succeeds; changed work or cancelled consent rejects late completion.
An open chat follows a background readiness check until it settles. Supported
controls appear when the agent becomes ready, preserving the draft and choices
without starting a session or sending a message. A failed status read offers Retry.

After a Default turn, the app may prepare a local runtime for the next chat to
reduce connection delay. This creates no conversation, sends no model request,
and consumes no agent credits. Each chat still receives its own runtime and
permissions, with current model and tool choices checked before use.
Those instructions also say how to write math: `$...$` inline, with no space
just inside the dollar signs, `$$` blocks for display, and dollar amounts as
ordinary text. This applies to replies and Markdown file writes.

## Submission and Execution

- File reads and searches default to the conversation’s project. An explicit
  request for other files or directories allows reading or searching that scope
  through native tools, subject to runtime permissions. It does not move the
  conversation or create an implicit global search. Project MCP tools retain
  their project boundary.
- Requested output may also live outside the project. The agent creates or
  modifies those files through native tools under the selected runtime's
  permissions, without requiring import or moving the conversation. Native
  writes remain available; Default asks for them in Ask, Edit, and Auto, while
  Plan refuses changes. Project text content changes use project file tools; Claude
  refuses a native text write whose target resolves inside the project, in every
  mode, and directs the agent to those tools. External
  files do not become project search results or participate in project turn review.
- An authorized project file deletion prefers the project deletion tool. If
  that tool is unavailable or explicitly cannot handle the file type, the agent
  can delete the same exact path with native tools under runtime permissions.
  A permission denial, protected-path or project-scope refusal, or source
  conflict cannot be bypassed that way. An uncertain result requires checking
  whether the file still exists before retrying. This fallback does not change
  the project-tool requirement for text content edits and writes.

- Capture text, context, and choices on Send. Clear only the accepted snapshot.
  Refused delivery retains it; uncertain delivery forbids automatic resend.
- One turn runs per conversation. Follow-ups queue explicitly and advance on
  their own; the queue never needs starting. Stop ends only the running turn,
  and once it is confirmed the next queued message goes. Failure, connection
  loss, or a refused send holds the queue until a later turn completes or the
  reader reviews an uncertain outcome.
- A runtime that can take a follow-up into the running turn (Claude, Codex)
  gets one there unless the reader asks to queue it, including while the
  prompt that starts the turn is still connecting. It joins the transcript
  where the runtime reads it. An installed Claude that cannot report reading a
  follow-up keeps it for after the turn, and a Codex that cannot name it places
  it when it accepts it, so neither sends one twice. One the turn ends without reading, including
  after Stop, goes next, ahead of the queue. A follow-up that arms a skill
  always queues, since a skill starts a turn.
  Waiting for a background subagent and processing its result remain part of
  that turn; an interim reply must not show Completed or release queued work.
- Validate context before sending. Missing or changed context needs replacement,
  refresh, or explicit removal.
- Dragging an ordinary file from Files into the composer explicitly attaches
  its exact path, including code and configuration formats outside automatic
  context. The runtime reads it with its available tools and permissions;
  attaching it neither indexes it nor changes its contents. The draft shows a
  removable file card; sent and restored messages retain the file identity even
  for unknown extensions.
- A file dropped on the workspace outside the message box does attach, to the
  chat beside it, without a click and without opening the pane, when that chat
  can use it: an external file, or a file of the chat's own project that its
  listing shows. Another project's file, or one the tree hides, opens without
  attaching. It shows as a document context chip. An attachment added that way
  leaves the draft when the file's tab closes; one the reader adds by hand stays. An
  [external file](project-files.md#external-files) attaches by its absolute path,
  and each runtime reads it with its own tools under its own permissions, so
  Default asks before reading outside the project. Project MCP tools keep
  refusing it.
- The agent pane beside Documents includes the readable document in front of
  the reader as visible context, including an external file. Removing it excludes
  it until another document comes to the front. Sending, queueing, or sending a
  follow-up captures the document shown at that moment; later navigation cannot
  change that request or its retry. Chat mode and New tab add no current document
  because no document is on screen there. Files explicitly attached to a draft stay attached.
- A **passage** is selected text bound as context, from **Ask agent** on a
  Markdown selection or on selected table cells. A table passage starts with
  where it is, the sheet and range, then its rows as a Markdown table that
  keeps row numbers and column names. Its words travel with the request, so later edits to the
  file do not change what was asked about; it is refused only when its file
  leaves the project or it exceeds 6,000 characters. A passage of an external
  file goes to the chat beside it and carries the file's absolute path. Reloaded history shows it
  as the same passage chip.
  Ask agent closes the selection toolbar and focuses the composer. Clicking a
  passage chip in the draft or sent chat opens its source. In a Markdown file it
  scrolls to the exact passage and highlights it without selecting editable
  text; a passage quoted from a table opens its file. Current-chat
  passages in the draft, queue, unread follow-ups, and sent history retain a light background and
  dashed underline in the document, so they remain recognizable during ordinary
  scrolling. Clicking or editing the document clears the stronger navigation
  highlight; removing a reference or switching chats updates the persistent
  marks. Marks never enter the saved file. Live anchors follow edits around a
  passage, including a reload from disk; changed words invalidate the anchor.
  After a reload, a passage inside the changed text is kept only when its words
  were and remain the file's one copy. Reopened passages locate only
  an unambiguous exact match; unavailable or ambiguous text reports that the
  passage could not be located instead of guessing.
- Antigravity offers Auto, Ask, Edit, and Plan. Running for StashBase, it
  cannot ask the reader itself, so StashBase reviews each tool call before it
  runs. Reads pass. Edit passes ordinary changes inside the project. Auto is
  StashBase's own rule set rather than Antigravity's, whose Auto refuses
  StashBase's tools and asks no one: it also passes commands that only read,
  shown by the command line itself, plus web searches and page reads whose
  address carries no query. Plan refuses changes. Anything else shows the same
  approval card the other runtimes use, and an unanswered card never becomes a
  grant. Antigravity's messages carry text only, so attachments reach it as
  file paths it reads with its own tools, as they do for Claude and Codex.
- A runtime that advertises attachments accepts ordinary local files through the
  picker, drop, or paste. Images and PDFs may have visual previews; other files
  remain named file cards. History preserves a named card when temporary image
  bytes have expired. If an offered preview fails to load, the card shows
  “Preview unavailable” without discarding the attachment reference.
  Attachment acceptance does not promise that every
  runtime can interpret every binary format, and a refused read must stay visible.
- Default sends local attachments with the model request, without cloud object
  storage, project import, or indexing. It accepts PNG, JPEG, GIF, WebP, PDF,
  UTF-8 text, and DOCX. Images and PDFs retain their original media; DOCX supplies
  extracted text and explicitly excludes embedded images and page layout.
  Each message accepts up to ten files totaling 8 MiB, with at most 200,000
  extracted text characters. Oversize, unavailable, changed, and unsupported
  files fail visibly; content is never silently truncated or omitted. The full
  model request, including retained history, also has a transport size limit.
- Model, effort, skills, and permission options follow the selected runtime.
  Remember explicitly chosen models and thinking effort per project and agent
  when switching agents and starting new chats, including after restart.
  A project without its own model or effort choice inherits the user's last
  explicit choice for that agent across projects. Using another agent does not
  replace these defaults. An existing project's explicit choices, including a
  reset to the native default, take precedence; personas remain project-scoped.
  A remembered model list cannot erase a saved choice. Codex retains an explicit
  model and thinking effort through reconnects and catalog changes; a refused
  choice fails visibly instead of retrying the message on a different model.
  Other runtimes may report an unavailable choice and use their native default
  without overwriting the preference. Other open chats keep their choices.
  Restoring history keeps that conversation's native choices and never changes
  the preferences, including the native thinking effort rather than the model
  catalog's suggested default. Explicitly returning a choice to Default remembers
  that reset for the project and as that agent's cross-project default, and applies
  the model's default effort to the next turn.
  Without an explicit model choice, a chat runs on the model the runtime's own
  settings name; StashBase never resets a runtime to a built-in default the user
  did not choose. A model named by an alias shows the release that alias
  resolves to, in the runtime's own words, so the reader can tell which model
  the choice actually runs. A model chosen while a session is still starting applies
  before its first turn. Default's composer control offers no model; it reads Crew,
  and its tooltip names the crew members that are on.
- Default discovers user skills only in the bound project's `.agents/skills`,
  `.claude/skills`, `.opencode/skills`, and `.opencode/skill` directories. It does
  not import global or ancestor skills. This is its default behavior, without a
  setting. Skill bodies load on native invocation. Project instruction files
  remain available, preferring `AGENTS.md`, then `CLAUDE.md`, then `CONTEXT.md`.
  Codex, Claude, and Antigravity retain their own native discovery rules.
  Antigravity offers no list of its skills, so its composer has no skill picker;
  its model still uses the project's skills on its own.
- Default's main agent handles general conversation, research, and writing on the
  service's default model. The composer offers **Crew**, with optional Writer,
  Reviewer, Reader, and Humanizer members from the service catalog. Initially all
  are off. Turning a member on explicitly assigns matching work to it in this
  chat; the user need not name it in every message. The current request takes
  precedence. Discussion, planning, explanations, and small mechanical edits can
  stay with the main agent. A review-only request ends with feedback; selection
  does not authorize unsolicited revision or repeated review/rewrite cycles.
- The Crew menu shows a toggle and chosen model for each member. The model opens
  its description and model options, with its default marked Recommended.
  Changing a model preserves the toggle. Choices belong to this chat and survive
  reopening; the most recent choices seed new chats without changing other chats.
  Changes apply to the next turn. Saving disables further changes and Send until
  settled; failures restore the previous selection and show retry guidance.
  Unavailable selections block startup with an explanation instead of silently
  dropping the chosen responsibility or substituting a model. A selected member
  removed by the service stays visible so the user can turn it off. A cached
  catalog may survive a failed refresh; without one, chats with no selected Crew
  can proceed, while selected Crew requires a readable catalog.
- A Crew member performs one text generation per invocation, with no tools or
  agent loop. The main agent supplies a task, necessary context, and optional
  project file paths. The host reads those files within the chat's project.
  Necessary context includes user decisions, style, exact wording, drafts,
  feedback, and verified evidence; an unsaved draft can pass directly between
  members. Unrelated conversation and internal reasoning are omitted. The
  published description defines the member's work and output. Shared instructions
  define selection and briefing, avoiding duplicate workflow rules in each role.
  The main agent presents results, handles justified next steps, and saves files.
  A root turn can contain multiple calls, billed under the same turn budget.
- Every Crew call has a standalone card naming the member and selected model,
  including while running and after failure. Opening it shows the full brief and
  result. Attribution is fixed when the call starts and persisted with history;
  changing choices or removing a catalog entry cannot relabel old calls. A stopped
  call cannot retry in a later turn. Truncated or unfinished output is a failed
  call, not a completed draft. Ordinary tools remain in collapsed activity.
- Crew supports text work in Plan; Plan still forbids file changes and commands.
  Each root turn retains its catalog snapshot. The service owns model availability,
  provider, price, and reasoning configuration. Default therefore has no separate
  main-model or thinking selector. Native OpenCode sub-agents are disabled.
- A persona is standing
  session guidance chosen per Chat in the composer from the reader's persona
  library, or none. Switching between personas is the reason to keep several;
  a persona that never changes belongs in the project's own instruction files.
  Choosing one applies from that Chat's next message by resuming its own
  conversation, and becomes the persona the project's next new Chat starts
  with; other open Chats keep theirs. Reopening a Chat from history restores
  its persona. The library is shared by every project and lives in app data,
  never in a project folder. A new library starts with the packaged personas;
  the reader can write, edit, and delete any of them, and add copies from the
  Gallery. Editing a persona applies to every Chat that runs it from that
  Chat's next message; a deleted persona leaves its Chats running none. A
  persona is distinct from permissions, requests, and user-owned native
  instruction files, which own how the agent works.
- When the desktop app is in the background or minimized, a pending approval
  or clarifying question sends a local system notification. Requests arriving
  together are grouped per window, and each pending request is announced once.
  The notification names only the project and conversation, not tool inputs or
  document contents. Clicking restores the owning window and focuses the exact
  pending card; it never approves an operation. Resolved, stopped, retired, and
  closed requests invalidate their notifications. Foreground work stays quiet.
  General settings provides a user-wide opt-out, enabled by default. This behavior
  applies to macOS, Windows and Linux desktops. Delivery depends on system
  notification settings; app availability is not OS permission.
  The system menu-bar/tray entry lists running sessions, including work in
  inactive chats, startup, waiting for confirmation and stopping. Completion,
  failure or a confirmed stop removes the row. This is independent of notification
  switches. Opening a waiting chat focuses its pending request; normal session
  state remains the authority for progress and lifecycle.
- Completed turns and failed submissions/turns also notify while the app is in
  the background. Unexpected connection loss asks the reader to inspect the
  conversation; it does not imply that work was rolled back. A user-requested
  stop stays quiet, including startup cancellation and a later cancellation
  timeout or failure. Loading history never announces old outcomes. Foreground
  outcomes and outcomes in disabled categories are not replayed on backgrounding
  or re-enabling notifications. Each chat retains its latest outcome notification
  until replaced, opened or retired. Clicking opens that chat and focuses the
  result/error when present; a startup failure opens the retained input instead.
- Every runtime shares StashBase's role as an assistant for thinking, research,
  writing, and revision in ordinary local projects. It can
  also perform programming and configuration work when the reader requests it,
  within session permissions. Document viewer and search
  formats do not restrict Agent text-file access. A persona can narrow that role.
- Answers, analysis, discussion, and proposed drafts or revisions stay in Chat
  by default. Local file changes require the reader's request or an applicable
  loaded project-instruction workflow that requires file output for the current
  task. Requests to implement code, update configuration, or apply edits include
  their necessary file changes; a request to compose text alone does not imply
  saving it. Opening or attaching a file supplies context, not edit intent.
  Available write permissions do not supply that intent either. The agent
  creates no unsolicited planning or scratch documents and continues in Chat
  without routinely asking to save. A requested preview stays in Chat until
  the reader asks to apply it.
- Requested ordinary writing defaults to a Markdown text note. A requested custom
  layout or interactive page can use an HTML interactive note. The shared creation
  tool supplies the same usable blank page as manual creation, in its own directory
  with `index.html` and `assets/`. The agent can read and customize those files;
  resource filenames and JSON structures are flexible, and existing user data is
  preserved. User-specified formats and existing authored layouts take precedence.
- Resolving an approval keeps the composer anchored at the bottom of an active
  conversation. Transcript scrolling and focus restoration stay inside the
  conversation's scroll area, including when long previews collapse.
- Completed-turn process folding follows the [Chat journey](../journeys/chat.md#flow)
  in both Chat and Documents assistance. It requires an observed successful
  completion; missing native-history outcomes never imply success. Disclosure
  choices belong to the open conversation, without changing native history.
- Allow applies to its pending action only. Codex also offers Allow for this session
  and Always allow when the native request supports those durations. The choice
  remembers that permission with Codex; it does not approve unrelated actions.
  Computer Use app access and Auto's review of a particular action remain separate,
  and a denied review retains its explanation. Stop cancels unanswered approvals,
  retires model/tool work, and preserves transcripts and completed file edits.
  Cancellation is confirmed before reporting Stopped; it does not roll back edits.
- Default offers Auto, Ask, Edit, and Plan. Ask confirms changes and commands; Edit
  approves only ordinary project document writes and asks for other actions.
  Auto also approves those writes, then uses the default model to review routine
  commands, web fetches, and external reads against the current user request.
  Uncertain, failed, or five-second overdue reviews ask the reader instead.
  That decision deadline prevents new review dispatch, but an already dispatched
  review finishes within its own bounded output and time budget so its actual
  usage can settle. A late answer never authorizes an action, including after
  manual approval, Stop, or a new turn. Application shutdown cancels remaining work.
  Deletion, moves, project creation, and unfamiliar tools retain explicit approval.
  Reviews have no tools and share the current turn's usage allowance. Plan reads
  and explores without writes or commands. A mode change applies between turns,
  including when a conversation resumes.
- Codex applies a changed mode on the next turn of the current conversation.
  Switching from Auto to Ask routes subsequent approval requests to the reader;
  it does not retry an action that was already denied.
- A new chat starts each agent in Auto, or in Edit where Auto is not offered;
  Ask is only a choice, never the starting point while either exists. The mode belongs to its agent: switching agents in an
  unsent chat restores the mode that agent was last left in there, so one
  agent's choice never carries to another.
- A reply may cite a passage in a project file with a link carrying a short
  quoted phrase. Opening it shows the file in Documents and locates that
  phrase; when the file no longer holds it, the file stays open and says so.
  A link without a phrase opens its file at the top. Citing is standing
  guidance to the agent, not a guarantee that every reply cites.
- A clarifying question is answered in place on its own pending request. Answers
  return keyed by question text; Skip or Stop leaves it unanswered rather than
  guessing on the reader's behalf.

## Scheduled Runs

A [scheduled task](scheduled-tasks.md) starts its chat through this same session and
send path, so every rule above applies to it unchanged. Its chat starts without taking
the window, keeps the task's agent and a title of its own, and never opens Send's
access prompt. [Scheduled Tasks](scheduled-tasks.md) owns the rest.

## Failure and Recovery

Keep usable history, partial output, and unsent work. Distinguish setup/account
repair, an outdated runtime, provider limits, transport loss, and turn failure so
recovery addresses the actual cause. An outdated runtime updates in place from
the failed turn; the conversation reconnects on it and resends the refused
request. A failed history load never becomes an empty conversation.
An authentication refusal explicitly asks the reader to sign in and offers an
entry to the agent's sign-in settings. The next send checks that prerequisite
again. Opening sign-in keeps the chat and draft and never replays the failed turn.
The same repair is available when authentication or version refusal prevents
the session from starting. Updating a runtime may expose a sign-in prerequisite;
show that next action, then continue after sign-in without reinstalling.
After signing in for a startup failure, an explicit reconnect makes the held
draft sendable without submitting it automatically. A service that requires
a newer StashBase version opens application updates in General settings.
Application updates never substitute a native Agent update or replay uncertain work.
An unexpectedly ended native event stream is a visible connection failure even
when the transport reports no exception. It retires the session and never
automatically resends an already submitted turn.
When listing Default history, a runtime startup timeout or early exit gets one
automatic retry after the failed process has fully retired. This retries only
startup, before reading history; it never replays a chat turn or a history edit.
Exhausted recovery keeps the load error and manual retry available. Missing
runtime/account prerequisites and failed cleanup do not trigger automatic retry.
An agent cleanup failure must not exit the application or discard other work.
Failure remains diagnosable; a cleanup timeout does not establish that the native
process stopped successfully. A later confirmed exit releases the retired
runtime without replaying a request or changing the original timeout into success.
An uninstalled agent is an installation prerequisite when reading its history,
not a server failure or evidence that its native history is empty.
Repeated identical native retry errors appear once per turn while retries continue;
a final short-term request limit or accounting-recovery refusal remains a rate-limit
failure with manual recovery. Accounting recovery may require service-side
reconciliation; its message must not imply exhausted credits or a guaranteed reset time.
A text-only context overflow stays in progress while Default compacts the
conversation. A successful continuation completes normally; a failed summary or
idle without continuation remains a visible failure. Stop still cancels recovery,
and a later turn must not inherit its pending failure. If the refused request
contains images or PDFs, Default stops visibly before native overflow compaction:
that replay could discard files the model has never read. Saved history and
attachments remain intact; the queue pauses, and the reader can start a new chat
with the files and a shorter prompt. Upload-size refusals also stop visibly and
never trigger lossy context recovery.
Hosted retry responses carry the service's suggested delay to the native runtime.
When the service changes the configuration of a Default model a chat runs on,
or withdraws it, the refused turn offers **Refresh models**. Refreshing
reconnects the same conversation to read the list again and keeps the
transcript, draft, and held queue. It never resends; the failed turn offers
a manual retry only after the refresh.
Default retries an empty model response or a hosted stream interruption before
output once within the current turn, retaining completed tool results and file
changes. Both failures share the same single retry. A stream interruption is not
evidence of provider overload. Once a model response has begun producing output,
it is not automatically replayed; streamed text and reasoning remain visible on
failure. Exhausted recovery or an unknown native
completion shows an incomplete-turn failure, never silent success. Recovery must
not automatically repeat the whole user request or its completed file operations.
An unknown outcome keeps the runtime or connection's reported failure visible
beside the review action; it must not replace a known cause with a generic
network explanation. Reconnecting alone does not establish what finished.

When Codex reports missing metadata for a model and then refuses that same
model, the failed turn offers **Update Codex** through this recovery flow.
Neither a metadata warning alone nor an account/model refusal alone establishes
an outdated runtime. Updating is a recovery attempt, not a promise of model
access; the original error remains visible and another model can be selected.

The model picker also offers the installed runtime's updater before any turn
fails, but only once a newer release than the installed one is known: the
host reads the release feed the provider's installer installs from, in the
background, about hourly and only while automatic update checks are on.
Opening the model picker reads that answer again, so a release found after the
chat opened is offered there as soon as Settings shows it. An
unknown installed version or an unreadable feed offers nothing. The runtime's
Settings row names the newer release and keeps Update available as the manual
path. Updating keeps the draft, disables sending during the update, shows the
service's latest progress line (the installer's own output, then the
reconnection) wherever it was started, and reconnects
to read the runtime's model list again. It sends no draft automatically.
Update failures stay visible in the picker and leave the conversation intact.

Reconnect to the same session and establish uncertain outcomes before continuing.
Retry uses the retained submission after checking context; Reuse message prepares
a new turn without truncating history or replacing another draft. Neither restores
missing attachment bytes nor promises that repeated file operations are safe.
Temporary attachments remain available to live drafts/queues across mode changes;
history metadata alone cannot restore them after loss or cleanup.

## Related Journeys

[J01](../journeys/README.md#j01-complete-onboarding-and-reach-first-value),
[J06](../journeys/README.md#j06-start-and-continue-an-agent-chat),
[J07](../journeys/README.md#j07-converge-chat-into-a-document),
[J10](../journeys/README.md#j10-turn-a-local-project-into-durable-agent-assisted-work),
[J11](../journeys/README.md#j11-turn-a-conversation-into-a-project),
[J12](../journeys/README.md#j12-build-wiki-pages-from-a-local-folder),
[J14](../journeys/README.md#j14-run-a-scheduled-task-in-a-project).

[Agent boundary](../../code-review/architecture.md#agent-sessions-and-permissions)
owns runtime integration and permissions; [Project Files](project-files.md) owns
file results, and [Project Context](project-context.md) owns source evidence.
