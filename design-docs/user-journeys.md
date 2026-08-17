# User Journeys

User Journeys are the stable product-behavior backbone between scenarios,
area design, implementation, and evidence. Each `Jxx` identifier names an
observable outcome rather than a screen or test case. Tests and Evals may cite
the identifier, but exact fixtures and assertions remain in the evidence.

A journey records the primary flow and the results users must be able to
observe. Shared ownership, trust, and lifecycle rules stay in area designs and
engineering contracts rather than being copied into every journey.

J01 Onboarding and J10 Core Loop are the two product-level critical journeys.
J01 proves that a new user can understand the product and reach first value;
J10 proves that the resulting environment supports durable repeated work. J11
Conversation to Project is the Chat-first activation branch between them. The
other journeys own the capabilities and recovery paths they compose.

## J01: Complete onboarding and reach first value

### Outcome

A first-time user understands StashBase's local-file model, authorizes useful
context, makes informed optional AI choices, and reaches a concrete first
result without completing unnecessary setup. On the next launch, completed
choices and authorized content remain recognizable without replaying
onboarding.

### Entry State

StashBase starts in a first-use window. The default folder home may be pristine,
may already contain user content, or the user may want to add an existing
folder. No account, AI Index source, active folder, or Agent runtime is assumed.

### Primary Flow

1. **Orient.** Launch into the document-free workspace and understand that
   StashBase works with ordinary local folders, prepares them as Agent context,
   and keeps source files user-owned.
2. **Acquire useful context.** When the default folder home is genuinely new
   and empty, inspect the ordinary **👋 Start Here** folder or add an existing
   folder. An existing folder home is never seeded or modified by onboarding.
3. **Choose AI Index deliberately.** See why meaning-based retrieval is
   recommended, which hosted or bring-your-own-key source would be used, and
   what remains local. Configure it or deliberately skip for now without
   losing local functionality.
4. **Enter the workspace.** Select a library folder and begin browsing before
   preparation or indexing completes. A fresh window does not silently choose
   a folder on the user's behalf.
5. **Reach first value.** Open a real source and complete at least one useful
   action: inspect the document, retrieve source evidence, or explicitly set up
   a scoped Agent Chat. The next useful action stays visible without requiring
   every optional capability first.
6. **Return.** Close and relaunch StashBase. The library, durable settings, and
   completed setup remain available; transient skips and active-folder choice
   follow their documented scope rather than becoming hidden global state. A
   packaged build may quietly check the stable release channel when the saved
   default-on preference permits it. One deliberate Update action may then
   download, install, and relaunch after open edits are saved; Linux package
   installs may request system administrator approval.

### Required Observable Results

- Before granting access or configuring AI, the user can distinguish source
  files, StashBase-derived data, and optional hosted processing well enough to
  make the next decision deliberately.
- The shortest path to first value is authorizing or selecting useful content,
  not creating an account, installing an Agent, or waiting for all background
  work.
- Local browsing, editing, preview, and Exact Search do not depend on online
  authentication, AI Index readiness, transcription, or an Agent runtime.
- The seeded Start Here content appears only for a pristine default folder
  home, remains an ordinary user-owned folder, and is never recreated after
  deletion.
- A fresh window does not silently select a folder, send a prompt, or install
  an Agent runtime.
- A deliberate AI Index skip does not immediately repeat during the first
  folder entry in the same launch and remains reversible.
- Reaching first value leaves a clear route into Search, scoped Chat, or the
  J10 durable core loop without forcing one universal workflow.
- Returning users recognize their library and completed durable setup without
  replaying first-use explanation or losing access when an optional online
  capability is unavailable.

### Degradation and Recovery

The user can back out of or retry each optional setup stage without losing an
authorized folder or repeating earlier completed work. Provider,
authentication, preparation, or runtime failure never blocks the workspace and
exposes only recovery relevant to the failed stage. A failed first-value action
keeps the source and an alternative local action available.

### Evidence

See [J01 evidence](../code-review/journey-coverage.md#j01-onboarding).

## J02: Add and open a folder

### Outcome

An ordinary local folder joins the library and becomes usable without changing
its ownership, layout, or storage model.

### Entry State

The user has a local folder to open, or chooses a location in which to create
one.

### Primary Flow

1. Open or create a folder through the Library switcher.
2. Enter the folder before recursive preparation or indexing finishes.
3. Browse supported source files and switch among authorized member folders.
4. When no longer needed, deliberately remove a folder from the library.

### Required Observable Results

- Opening or creating a folder does not migrate its contents into managed
  storage.
- Folder entry prioritizes navigation; recursive background work does not hold
  the workspace closed.
- Switching folders preserves library-level state while keeping folder-scoped
  documents and started Chats attributable to their original scope.
- Removing membership clears only StashBase-owned state and leaves the source
  folder on disk.

### Degradation and Recovery

A failed or slow open remains retryable and does not strand another window or
folder context. Removal either finishes its owned cleanup before membership is
committed or remains recoverable without deleting user files. Shipping folder
entry currently has one documented source-mutation exception: it seeds a
missing `AGENTS.md` create-only. See the
[instruction-seeding Known Gap](../code-review/file-transactions.md#known-gap--instruction-seeding-on-folder-entry).

### Evidence

See [J02 evidence](../code-review/journey-coverage.md#j02-folder).

## J03: Read and edit source documents

### Outcome

The user opens and navigates previewable ordinary source files, and edits
content-editable formats with durable and explicit save behavior.

### Entry State

An authorized folder contains a source listed in the
[Documents format capability matrix](design/documents.md#format-capability-matrix).

### Primary Flow

1. Open the source in a persistent tab and receive only the preview or editing
   capabilities declared for that format.
2. For content-editable Markdown or JSON, enter the appropriate editing state
   and save through the shared durability path.
3. Navigate with tabs, Quick Open, outlines, Find, local links, or search
   results.
4. Close the tab or window, or use renderer-error recovery, after the current
   edit becomes durable.

### Required Observable Results

- The visible source file remains the identity behind every view and save.
- Preview-only formats never expose a content-editing affordance. Workbench
  content editing, Agent/MCP content writes, and file-level rename/move/delete
  remain distinguishable capabilities.
- Writer/reader and JSON Tree/Source transitions preserve the same source
  content rather than creating a second document model.
- Navigation, window retirement, and product-owned renderer recovery do not
  silently discard a live edit.
- Parse, preview, or unsupported-format failure keeps the source identifiable
  and recoverable.

### Degradation and Recovery

A failed save blocks renderer recovery. If a root failure has already removed
the save barrier, reloading requires an explicit warning that unsaved changes
may be lost. A concurrent version conflict keeps the dirty buffer and newer
disk source visible until the user reloads, overwrites, or merges. Leaving or
reloading cannot bypass that decision.

### Evidence

See [J03 evidence](../code-review/journey-coverage.md#j03-documents).

## J04: Prepare a hard-to-read file

### Outcome

PDF, DOCX, image, audio, supported video, or an explicitly accepted clipboard
screenshot becomes searchable and Agent-readable while the original remains
visible and authoritative.

### Entry State

An authorized folder contains a source whose useful text requires extraction,
OCR, or transcription, or the user wants to accumulate a copied screenshot as
new knowledge and has opted into clipboard-image offers in Settings.

### Primary Flow

1. Open or add an existing source; for a screenshot, first enable clipboard
   image offers in Settings, copy it, and explicitly choose **Add** in the
   import offer.
2. Continue browsing while OCR or other preparation runs.
3. Observe preparation status only when it changes the next useful action.
4. Search or let an Agent read the current prepared text after completion.
5. Retry or reprocess after an actionable failure or explicit cancellation.

### Required Observable Results

- Preparation never replaces the source or blocks its ordinary preview.
- Direct-text readable formats remain usable without Preparation. Formats that
  require prepared text expose only current format-appropriate OCR, extracted
  text, or transcripts to retrieval and Agents.
- Clipboard-image monitoring is off by default. Enabling it only creates an
  offer while StashBase is focused; importing still requires an explicit
  **Add**, and disabling it stops further monitoring.
- An accepted screenshot is a visible ordinary image source. Its OCR text is
  derived state and never appears as a second workspace file.
- Completion means format-specific output is both complete and fresh for the
  current source bytes.
- Preparation readiness and AI Index readiness remain distinguishable.
- Generated text, checkpoints, and indexes never become workspace files.

### Degradation and Recovery

Stale, partial, cancelled, or incompatible output never counts as current
truth. Missing optional native capability produces a blocked or retryable state
without making the source itself a failed file. An unreadable clipboard or a
dismissed offer creates no source file and does not interrupt ordinary work.

### Evidence

See [J04 evidence](../code-review/journey-coverage.md#j04-preparation).

## J05: Search and open source evidence

### Outcome

A person finds relevant evidence across the authorized library and returns to
the visible source that supports it.

### Entry State

The library contains direct-text readable or currently prepared sources as
classified by the
[Documents format capability matrix](design/documents.md#format-capability-matrix).
AI Index may be ready, partially ready, disabled, or unavailable.

### Primary Flow

1. Enter one query in library search.
2. Use Exact Search without AI Index or Similar Search with an explicitly
   selected hosted or bring-your-own-key source.
3. Optionally narrow the query to one member folder.
4. Review ranked evidence and readiness guidance.
5. Open a result in its visible source context.

### Required Observable Results

- Result scope never widens beyond the visible library or selected folder.
- Every result identifies a user-visible source rather than derived storage.
- Retrieval uses direct source text or current prepared text according to the
  source format; it never treats previewability alone as searchable text.
- Missing results are distinguishable from preparation, indexing, provider, or
  quota state.
- Exact Search remains usable when semantic work cannot continue.
- Representative meaning-based queries retrieve relevant source evidence even
  when the query and source use different wording.

### Degradation and Recovery

Known-stale semantic evidence becomes unavailable before paused or failed work
is presented. Current indexed files may remain partially useful, and switching
to an available source or waiting for quota refresh resumes pending work
without blocking local-file workflows.

### Evidence

See [J05 evidence](../code-review/journey-coverage.md#j05-search).

## J06: Start and continue an Agent chat

### Outcome

The user collaborates with a supported Agent against an explicit library or
folder scope while retaining control of installation, context, tools, and
permissions.

### Entry State

The workspace has a reusable blank Chat. The selected Agent runtime may be
ready, missing, disconnected, or recoverable.

### Primary Flow

1. Use New Chat and choose the Agent and Library or folder scope.
2. When the runtime is missing, explicitly choose **Install and continue**.
3. When Codex is installed but signed out, choose **Sign in with ChatGPT** and
   finish the provider-owned browser flow started by that same runtime.
4. Connect StashBase context and send a prompt.
5. Inspect streaming output, tool activity, permissions, attachments, failures,
   and file artifacts.
6. Continue, edit and resend, or open a source beside the same mounted Chat.
7. Switch workspace folders without silently rebinding started work.

### Required Observable Results

- Opening the app, a folder, a tab, or history is never runtime-installation
  consent.
- Codex authentication uses the executable StashBase already discovered or
  installed. StashBase neither installs a second copy nor receives the
  provider credential.
- A started draft, turn, attachment set, or restored conversation retains its
  visible scope.
- Chat-primary and docked layouts preserve the same session and in-progress
  state.
- Commands, network, deletion, and broader filesystem access remain explicit
  permission decisions.
- Tool and source use remain inspectable without turning generated artifacts
  or transcripts into hidden product state.
- A source is presented as Agent-readable only when the selected Agent surface
  can consume that format's source or current prepared representation. Built-in
  attachment behavior must not be implied for an external MCP client.

### Degradation and Recovery

Runtime installation, authentication, MCP connection, transport, and turn
failures remain distinguishable and preserve the transcript. An installation
failure retains a no-download recheck so a CLI installed or repaired outside
StashBase can resume preparation without repeating the managed install. The
same recheck accepts a Codex login completed elsewhere. Abandoned or
interrupted output cannot arrive in a newer turn or session.

### Evidence

See [J06 evidence](../code-review/journey-coverage.md#j06-agent).

## J07: Converge chat into a document

### Outcome

Exploratory conversation produces reviewed, durable, user-owned project state.

### Entry State

The user has an active scoped Chat and an existing or new Markdown source that
can serve as the Canvas.

### Primary Flow

1. Explore alternatives in Chat using explicit project context.
2. Open the Canvas beside the same conversation.
3. Ask the Agent to write only accepted conclusions, reasoning, open questions,
   and next steps into that source.
4. Review, edit, and save the document as the lasting record.

### Required Observable Results

- The transcript remains exploration history, not the durable project model.
- Writing targets an explicit authorized source file through the shared
  transaction boundary.
- Agent-created or changed files refresh the workspace without selecting
  themselves or replacing user focus.
- The reviewed Markdown remains usable by other tools and future Agent work.

### Degradation and Recovery

A failed, interrupted, unauthorized, or version-conflicted write leaves the
existing source recoverable and does not manufacture a successful document.
StashBase does not automatically merge conversation branches into the Canvas.

### Evidence

See [J07 evidence](../code-review/journey-coverage.md#j07-converge).

## J08: Connect an external Agent through MCP

### Outcome

An MCP-capable client uses the same authorized library operations and visible
source identity as the built-in Agent.

### Entry State

The user has authorized at least one library folder and has an external
MCP-capable client to configure.

### Primary Flow

1. Copy the standard configuration or URL access details from Settings and
   register them in the client.
2. Orient with library information, then search or read authorized files.
3. Use bounded mutations when the client needs to write back.
4. Reindex or reconcile external changes when required.

### Required Observable Results

- Built-in and external Agents use the same operation and source-identity
  rules.
- `read_file`, `write_file`, and `edit_file` advertise and enforce the format
  capabilities in the
  [Documents matrix](design/documents.md#format-capability-matrix); a generic
  claim that every previewable source is text-readable or content-editable is
  invalid.
- Paths outside member folders and hidden derived state remain inaccessible.
- Search narrowing fails rather than silently widening.
- File mutations use the shared version and lifecycle boundaries.

### Degradation and Recovery

Configuration, credential, listener, or transport failure does not broaden
filesystem access or block ordinary app use. Rotation and recovery invalidate
obsolete access rather than maintaining competing authority.

### Evidence

See [J08 evidence](../code-review/journey-coverage.md#j08-external-mcp).

## J09: Prepare and hand off a bug report

### Outcome

The user prepares an actionable local report, reviews exactly what may be
shared, and remains the only party who submits it.

### Entry State

The user deliberately opens Report Bug from the sidebar or native Help menu.
The main workspace renderer may be healthy or impaired.

### Primary Flow

1. Describe the problem and optional reproduction steps in the dedicated review
   window.
2. Inspect safe previews and independently include or exclude each available
   artifact.
3. Choose **Prepare Report** to freeze the reviewed snapshot locally.
4. Open a prefilled GitHub issue after copying the files to Downloads, or
   download the same files without opening GitHub.
5. Go Back to revise and approve a fresh snapshot, or close to discard the
   session.

### Required Observable Results

- Collection, approval, and every external handoff require deliberate actions.
- Previewing an artifact never changes whether it is selected.
- Preparation uses exactly the approved text and artifacts and never
  recollects changing inputs.
- Nothing is uploaded or submitted by StashBase.

### Degradation and Recovery

An unavailable or privacy-unsafe artifact fails closed without exposing
private content or discarding the rest of the draft. A late result cannot
revive a closed or discarded review.

### Evidence

See [J09 evidence](../code-review/journey-coverage.md#j09-bug-report).

## J10: Turn a local project into durable Agent-assisted work

### Outcome

An existing local project becomes reusable Agent context and produces a
reviewed result that remains durable in ordinary source files.

### Entry State

The user has a folder containing project sources, including at least one
readable or preparable document, and chooses a supported built-in or external
Agent.

### Primary Flow

1. Add or select the folder without migrating its contents.
2. Inspect a source and retrieve relevant evidence through Exact or Similar
   Search.
3. Start an explicitly scoped Agent task that uses the same source identity and
   authorized context.
4. Inspect the Agent's evidence, tool activity, and proposed file changes.
5. Write accepted conclusions into an explicit Markdown Canvas, then review
   and save it.
6. Reopen or retrieve that source in later work without depending on the
   original conversation.

### Required Observable Results

- Workspace, retrieval, built-in Chat, and external MCP agree on library scope
  and visible source identity.
- Prepared evidence remains derived and invisible while still resolving to the
  original source.
- The user can distinguish exploration from the accepted durable result.
- The written result re-enters ordinary browsing, search, and Agent context.
- Losing semantic or Agent availability does not make existing source work or
  durable results inaccessible.

### Degradation and Recovery

A failure in preparation, retrieval, Agent execution, permission, or writeback
remains attributable to its stage and never corrupts the source project. The
user can resume from the first incomplete stage without silently expanding
scope or treating partial output as accepted state.

### Evidence

See [J10 evidence](../code-review/journey-coverage.md#j10-core-loop). This
journey composes J02, J04–J07, and J08 when an external Agent is used; it
requires its own end-to-end evidence rather than inferring completion from
those journeys independently.

## J11: Turn a conversation into a project

### Outcome

An exploratory Library Chat becomes a named ordinary local project only after
the user decides the work deserves a durable scope. The same conversation
continues inside the new project without losing its history or silently
copying the transcript into source files.

### Entry State

The user is in a live Library-scoped Chat that is not already bound to one
member folder. The conversation has produced a direction worth continuing,
but no project folder or durable project document is assumed.

### Primary Flow

1. Explore a question, idea, or task in the reusable Library Chat.
2. Explicitly tell the Agent to turn the work into a project, optionally naming
   an authorized location.
3. The Agent uses the StashBase `create_project` operation rather than a bare
   filesystem command.
4. StashBase creates one new ordinary folder under the default folder home or
   another authorized root, seeds missing Agent instructions create-only, and
   registers the folder in the Library.
5. The live initiating Library Chat keeps its transcript, changes scope to the
   new project, and causes its owning window to enter that folder. Other
   windows observe Library membership without being redirected.
6. Continue the same conversation against the new project and explicitly write
   accepted goals, decisions, or plans into ordinary source files when they
   need to persist.

### Required Observable Results

- Project creation follows an explicit user decision or a visible approval
  naming the action and target; StashBase never infers consent merely because
  a conversation resembles a project.
- The created project is an ordinary, newly created local folder. Its name is
  one cross-platform-safe segment, its resolved location remains inside an
  owned root, and an existing destination is a conflict rather than a folder
  to reuse or overwrite.
- Existing Agent instruction files are never overwritten. Any seeded
  instruction remains a visible user-owned source file.
- Only the live, attributable Library Chat that initiated creation may rebind.
  A folder-bound, stale, unattributed, or external caller may create and
  register an authorized project but cannot redirect an unrelated built-in
  Chat.
- Rebinding preserves transcript, draft, session identity, and history
  attribution while changing future tool and file access to the new folder.
- The new Library member and active scope remain visibly attributable. The
  conversation is not copied into project files automatically; durable content
  enters the project only through an explicit write.

### Degradation and Recovery

Invalid names, unauthorized locations, symlink escapes, and existing targets
fail before modifying disk. If Library registration cannot commit, StashBase
removes only the newly created empty directory it still owns. If the initiating
session closes or rebinding races with teardown, the project remains a normal
registered folder while stale history overrides are rolled back. If the
originating window cannot enter a successfully rebound project, the Chat keeps
the new scope visible and reports a retryable open failure rather than
reverting to an ambiguous Library presentation.

### Evidence

See [J11 evidence](../code-review/journey-coverage.md#j11-conversation-to-project).
This Journey composes the Chat entry from J01, project registration and entry
from J02, Agent lifecycle from J06, explicit persistence from J07, and the
durable continuation described by J10.
