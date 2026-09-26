# Journey Coverage

Start here for a journey review: choose its boundary and implementation entry
points, then inspect the code and evidence. [User Journeys](../design-docs/journeys/README.md)
states required outcomes; [Engineering Boundaries](architecture.md) owns invariants.
Tests own fixtures and exact assertions. This is not a source inventory or a review-completion percentage.

## Evidence Model

| Evidence | Establishes |
|---|---|
| Contract Test | Deterministic interfaces, invariants, failures, and recovery at the lowest useful layer |
| Driven Runtime Pass | A named observable flow through the built app, within its recorded substitutions and limits |
| AI Eval | Probabilistic retrieval, grounding, or task quality on representative inputs |
| Release Check | Packaged, native, credentialed, or third-party behavior unavailable to source tests |

**Covered** requires decisive evidence for every Required result. **Partial**
means some results lack it. **Release-dependent** reserves named external or
packaged checks. **Gap** identifies contradicted or unproven behavior. These
labels concern evidence, not feature completion. A broad command or passing count is
not proof.

Format evidence follows the [Documents capability matrix](../design-docs/capabilities/project-files.md#format-capability-matrix):
editable prose/structured text, preview-only text, prepared binary documents,
and OCR images. One representation cannot prove another.

For horizontal review, follow a shared capability across these rows and inspect
its [current engineering owners](architecture.md#shared-capability-owners).
The map is navigation, not proof that every caller has been reviewed.

## Traceability Map

| Journey | Shared capabilities | Engineering boundary |
|---|---|---|
| [J01 Onboarding](#j01-onboarding) | [Project Entry](../design-docs/capabilities/project-entry.md), [Agent Sessions](../design-docs/capabilities/agent-sessions.md), [Account and Settings](../design-docs/capabilities/account-settings.md) | [Entry and identity](architecture.md#project-scope-and-paths), [Native lifecycle](architecture.md#native-lifecycle-and-updates) |
| [J02 Folder](#j02-folder) | [Project Entry](../design-docs/capabilities/project-entry.md), [Project Files](../design-docs/capabilities/project-files.md) | [Projects](architecture.md#project-scope-and-paths), [Import](architecture.md#import-publication) |
| [J03 Documents](#j03-documents) | [Project Files](../design-docs/capabilities/project-files.md) | [Source transactions](architecture.md#source-transactions), [Renderer](architecture.md#renderer-boundaries), [Draft durability](architecture.md#draft-durability) |
| [J04 Preparation](#j04-preparation) | [Project Context](../design-docs/capabilities/project-context.md) | [Preparation](architecture.md#preparation-and-retrieval), [Local components](architecture.md#optional-local-components) |
| [J05 Search](#j05-search) | [Project Context](../design-docs/capabilities/project-context.md), [Project Files](../design-docs/capabilities/project-files.md) | [Retrieval](architecture.md#preparation-and-retrieval), [Scope](architecture.md#project-scope-and-paths) |
| [J06 Agent](#j06-agent) | [Agent Sessions](../design-docs/capabilities/agent-sessions.md), [Account and Settings](../design-docs/capabilities/account-settings.md), [Project Files](../design-docs/capabilities/project-files.md) | [Agent sessions](architecture.md#agent-sessions-and-permissions), [Credentials](architecture.md#credentials-and-external-access) |
| [J07 Converge](#j07-converge) | [Agent Sessions](../design-docs/capabilities/agent-sessions.md), [Project Files](../design-docs/capabilities/project-files.md) | [Source transactions](architecture.md#source-transactions), [Agent permissions](architecture.md#agent-sessions-and-permissions) |
| [J08 External MCP](#j08-external-mcp) | [Project Context](../design-docs/capabilities/project-context.md), [Project Files](../design-docs/capabilities/project-files.md), [Account and Settings](../design-docs/capabilities/account-settings.md) | [MCP](architecture.md#credentials-and-external-access), [Scope](architecture.md#project-scope-and-paths) |
| [J09 Bug report](#j09-bug-report) | [Account and Settings](../design-docs/capabilities/account-settings.md) | [Bug report](architecture.md#bug-report), [Native lifecycle](architecture.md#native-lifecycle-and-updates) |
| [J10 Core loop](#j10-core-loop) | [Project Entry](../design-docs/capabilities/project-entry.md), [Agent Sessions](../design-docs/capabilities/agent-sessions.md), [Project Files](../design-docs/capabilities/project-files.md), [Project Context](../design-docs/capabilities/project-context.md) | [Ownership](architecture.md#runtime-ownership), [Agent sessions](architecture.md#agent-sessions-and-permissions), [Source transactions](architecture.md#source-transactions) |
| [J11 Conversation to project](#j11-conversation-to-project) | [Project Entry](../design-docs/capabilities/project-entry.md), [Agent Sessions](../design-docs/capabilities/agent-sessions.md) | [Projects](architecture.md#project-scope-and-paths), [Session ownership](architecture.md#agent-sessions-and-permissions) |
| [J12 Build Wiki Pages](#j12-build-wiki-pages) | [Agent Sessions](../design-docs/capabilities/agent-sessions.md), [Project Files](../design-docs/capabilities/project-files.md), [Project Context](../design-docs/capabilities/project-context.md) | [Agent permissions](architecture.md#agent-sessions-and-permissions), [Preparation](architecture.md#preparation-and-retrieval) |
| [J13 Gallery download](#j13-gallery-download) | [Project Entry](../design-docs/capabilities/project-entry.md) | [Gallery](architecture.md#gallery), [Import](architecture.md#import-publication) |

## J01: Onboarding

**Intel entry (2026-09-17):** macOS build and source CI include native x64,
with dual-architecture update metadata and Homebrew selection owned by the
[Release Runbook](release-pipeline.md#macos-developer-id-distribution).
`server/native-component-support.ts` limits native search/extraction on older
Intel systems without raising the application's macOS 12 minimum.
`indexer-mfs-path.test.ts` proves no daemon is spawned on an unsupported system;
`extractor-runtime.test.ts` covers no download/demand/retry there and supported
Intel offline reuse. Hosted Intel macOS 15 packaged daemon, component, and OpenCode execution passed
the [native release checks](release-pipeline.md#macos-developer-id-distribution).
Actual desktop interaction and old-OS editing remain release checks; controlled
platform substitution does not establish those.
A built-server pass with isolated app data and substituted Intel/macOS 12
identity returns the unsupported component status, opens a real project, lists
and reads its Markdown, saves revised content with a search warning, and reads
the saved bytes back while health stays available. Provider CLI execution is
disabled in this pass; it establishes service isolation, not Intel binary or
Agent compatibility.

**Settings organization (2026-09-16):** General owns preferences, Agents groups
Default account/credits/connection, and Advanced owns optional connections.
`renderer/src/features/settings/ui/managed-settings.tsx` owns routing;
`managed-settings.test.tsx` exercises navigation and direct search setup.
Developer controls use a development-only shortcut and separate dialog;
`sidebar-update-preview.test.tsx` exercises preview dismissal without updater authority.
Validation: `pnpm check:web` passed all 12 gates, including renderer coverage
and Story accessibility. Native Help menu tests passed (26). A browser
pass through built Storybook checked General, the grouped Default account/credits,
and switching MCP from Standard to HTTP with Docker port settings collapsed.
These used controlled ports; the native Electron accessibility connection timed
out, so packaged Settings composition and live-provider setup remain unverified.

**Settings persistence (2026-09-16):** model catalog caching uses strict
read-modify-write and remains best-effort without replacing malformed settings.
Embedding key changes retire older validations and serialize runtime changes.
The catalog and embedder route tests exercise malformed storage and a delayed
PUT overtaken by DELETE with isolated configuration and controlled validation.

**Usage statistics:** `server/telemetry.ts` and `server/routes/telemetry.ts` own
manual collection and Settings persistence; Settings General exposes default-on
disclosure and opt-out. Test launches set `STASHBASE_TELEMETRY_DISABLED=1` to
suppress packaged collection independently of Settings. A subprocess regression
uses the production telemetry owner and Electron's server environment builder
with an intercepted transport: packaged test events and the opt-out notification
are suppressed, capture preserves stored preferences/identity, and normal packaged
collection still works. Smoke launchers set the override, and packaged-server
smoke checks `available: false` before user flows. A built-service pass in packaged
mode exercised real HTTP capture and preference changes with isolated config and
an intercepted outbound transport: no fetch was attempted, the saved preference
survived capture, and no identity was created. Configuration tests (58), package
contracts (16), host types, service build, Electron smoke, and docs validation
passed. Signed-package verification of this override remains pending the next release.
The workspace has no first-launch statistics banner. `server/telemetry.test.ts` covers
field rejection, opt-out/restart/ID rotation, offline delivery, corrupt config,
and daily editor-save suppression. Renderer usage tests cover terminal event
coalescing and Settings choice/failure UI. A 2026-09-15 built-service pass with
isolated config, real Python/MFS, and a local capture sink exercised project open,
versioned editor save, opt-out, ID removal, and suppression of later events.
Before removal of the startup banner, built Storybook privacy controls and the
then-present disclosure were driven and reviewed visually;
Electron boundary/authorization smoke passed. A separate real PostHog Capture
API pass received HTTP 200 for `app_opened` and `telemetry_disabled`, both visible
in project 384555 with version `2.7.0-telemetry-verification`. IP discard was
confirmed enabled there. Signed packaged multi-window privacy settings and real-provider
Agent telemetry remain unproven; desktop accessibility selected a pre-existing
app instance rather than the isolated verification window.
A later 2026-09-15 source-desktop startup pass used an empty temporary HOME and
isolated profile, with any application access to Electron safeStorage made fatal.
It reached the real welcome screen, showed no statistics banner, and exited
cleanly. This proves the source startup path no longer needs OS key storage;
it does not establish the next signed installer or third-party Agent login UI.


**Intent:** [J01](../design-docs/journeys/README.md#j01-complete-onboarding-and-reach-first-value).

**Implementation:** Renderer: `renderer/src/app/bootstrap/startup.tsx`, `renderer/src/features/workspace/ui/welcome.tsx`.
Host/services: `electron/main.cjs`, `server/folder.ts`.

**Status:** Release-dependent.

- **Contract Test:** startup ownership/readiness, native activation and window
  isolation, empty-home startup/registry/restart, Settings persistence, account entry,
  Agent preparation, and update state/authorization. Entry points:
  `pnpm test:renderer`, `pnpm test:config`, `pnpm test:project-files`,
  `pnpm test:updates`, `pnpm test:electron`, `pnpm test:electron:smoke`,
  and `pnpm test:agent`. Key persistence survives daemon reconfiguration
  failure; these tests do not prove rollback of saved configuration.
- **Driven Runtime Pass:** a 2026-09-16 isolated built-server pass verified that
  first launch creates an empty default home and no project membership; restart
  preserves existing unregistered files, and explicit open registers only the
  requested project. `server/folder-startup.test.ts` owns these startup
  regressions. This pass does not establish packaged Welcome composition.
  Earlier isolated macOS built-app passes cover Welcome/Recent,
  return without automatic project reopen, independent windows, orphan recovery,
  delayed-start activation, save-refused quit and later reopen,
  and theme writes. OS URL registration/key protection are substitutes.
  Account identity/menu is tested; a seeded session did not prove live sign-in.
  A 2026-09-15 isolated Chromium pass renders the server-owned sign-in success
  and failure pages in light and dark modes, with visible return buttons and
  no horizontal overflow. Screenshots verify composition; this pass does not
  exercise a real OAuth provider or native protocol handoff.
  A built-server delayed fake-Codex pass (2026-09-15) kept health requests
  responsive and issued one probe; it proves liveness, not a model turn.
  The development tools dialog triggers a preview in the sidebar footer.
  `sidebar-update-preview.test.tsx` covers developer-dialog dismissal, footer placement,
  inert preview installation, and restoration of real update actions.
  `update-preview.test.tsx` covers selecting a state before starting the preview.
  An isolated Electron/Vite pass (2026-09-15) opens the developer controls,
  starts the default ready-to-install preview, and visually verifies the card
  above Gallery in the expanded sidebar with Settings closed. Clicking Install
  and restart leaves the window running; the close icon removes the preview.
  Controlled updater passes cover dismissed notices, Settings actions, native
  input locking, save barriers, and handoff failure rollback, not replacement.
- **AI Eval:** first-discussion quality belongs to J10; retrieval quality to J05.
- **Release Check:** signed/notarized first launch, offline startup, actual
  native picker, first-session-to-returning-session flow, and N→N+1 updates on
  supported platforms.
- **Gap:** no full pass demonstrates understanding local/derived/hosted data,
  entering an empty project, useful brainstorming, and returning without
  unnecessary onboarding. Real update download, replacement, and relaunch remain
  unproven by controlled handoff; unpackaged builds report unsupported.
- **Known issues:** saved appearance applies after first paint.
- **Sign-in recovery (2026-09-15):** `settings/hooks/account-context.tsx` owns
  one browser wait shared by sidebar, composer, and Agents Settings.
  `use-account.test.ts`, `agents-panel.test.tsx`, and
  `app/composition/layout/workspace-sidebar.test.tsx` cover read failure/retry,
  duplicate command suppression, shared waiting across Settings reopening, and
  stopping local polling. `server/hosted-account.test.ts` and
  `server/account-route.test.ts` cover transient refresh preservation, confirmed
  revocation, stale refresh isolation, late OAuth after sign-out/new attempts,
  and callback/native-return contracts. These focused suites pass 45 tests.
  An isolated built Electron pass with controlled account responses exercises
  initial-read retry, shared waiting, Settings reopening, and Stop waiting; native
  boundary smoke also passes. Host/renderer types and builds pass. The full renderer
  gate encountered the existing 401-line file-tree limit and a J07 test timeout
  (its focused rerun passed); the new duplicate lifecycle check was removed and
  duplication passed on recheck. Real Google/Supabase login and packaged protocol
  handoff remain unproven.

## J02: Folder

**Intent:** [J02](../design-docs/journeys/README.md#j02-add-and-open-a-folder).

**Implementation:** Renderer: `renderer/src/features/workspace/hooks/use-project-entry.ts`, `renderer/src/features/workspace/hooks/use-project-entry-receiver.ts`, `renderer/src/features/workspace/application/open-folder.ts`, `renderer/src/features/workspace/application/remove-folder.ts`.
Host/services: `server/folder.ts`, `server/github-import.ts`, `server/project-file-mutations.ts`.

**Status:** Partial and release-dependent.

- **Contract Test:** `pnpm test:renderer`, `pnpm test:project-files`,
  `pnpm test:conversion-scheduler`, and `pnpm test:electron` cover asynchronous
  open/commit, cancellation, GitHub staging/publication rollback, project
  retirement, retained nested projects and preparation, and distinct path
  whitespace/case/Unicode identities. Scoped HTTP/Agent regressions now preserve
  a trailing-space project through reads, saves, and index status. Shared entry
  tests cover copy/entry retry separation, explicit folder conflicts, cancellation
  before late results, retained Recent records, receipt recovery, and workspace
  readiness. Native tests cover Welcome reuse, self/peer focus, occupied-window
  isolation, serialized allocation, and stale acknowledgements.
- **Driven Runtime Pass:** isolated macOS built app/server (2026-09-14): existing
  open, failed-open retention, alias focus, empty creation, duplicate rejection,
  registration without unrelated window rebind, and a real
  shallow `octocat/Hello-World` clone. Picker selection/creation, URL registration,
  and key protection are substituted. The Git pass does not prove background
  listing/index completion. A 2026-09-15 built-service HTTP pass with the real
  Python/MFS daemon additionally preserved a trailing-space project through
  open/read/save/search and rejected a save from another window request scope.
  This is API evidence, not a new full UI pass; desktop control permission was
  unavailable during the v2.7.0 retry. An isolated built-renderer Electron pass
  (2026-09-15) drove real pointer input across a Welcome recent row: the drag
  selected the project's name and path and sent no open request, a plain click
  still posted `/api/projects/open` for that path, and the row's remove control
  faded once the pointer left instead of standing on an untinted row.
  A further isolated built-app pass (2026-09-15) exercises Open, Create, Recent,
  GitHub Import, and Gallery Copy through the shared entry flow. Welcome is
  reused; self/peer requests focus the existing project; an occupied source
  keeps its project while a new window opens. A real shallow `octocat/Hello-World`
  copy survives an injected handoff refusal, and network observation confirms
  Retry sends no second import POST. Explicit Open existing folder resolves the
  Gallery destination conflict. System picker choices and Gallery index bytes
  are controlled; source/server builds and native window routing are real.
- **Boot and open reconcile pass (2026-09-21):** an isolated macOS built app
  with a real Python/MFS daemon and no embedding key started with two registered
  projects. Boot bound both and reconciled neither: the server log held no
  project reconcile, and the project that was never opened still reported zero
  documents at exit. Opening the other through a window-origin
  `/api/projects/open` reconciled its 300 Markdown sources in about four
  seconds, and a concurrent window-origin request loop saw no response slower
  than 22 ms across the first second and a half of it. This is API evidence
  from the desktop window's origin, not a UI pass, and it does not establish
  behavior for large mixed-format folders or with an embedding provider.
- **AI Eval:** not required.
- **Release Check:** real OS folder picker, file drop, and packaged public Git import.
- **File import (2026-09-16):** Files exposes `FileImport` through
  `useFileImport` and `createUploadAdapter`. The file tree's empty-space context
  menu offers Import files; no idle import row precedes the file list.
  `file-import.test.tsx` exercises menu-to-picker wiring and pending/completed
  feedback alongside an existing file listing. Picking or dropping files copies
  them into the captured project root. Partial results retain successful paths
  and allow retry of refused files only; lost responses require checking the
  refreshed listing. Adapter/hook tests cover partial retry and project retirement.
  An isolated built Electron pass supplies browser File objects through the input
  and a DOM drop, verifies actual server publication, preserves a colliding source,
  and observes confirmation/tree refresh. The context-menu follow-up also verifies
  chooser activation and visually checks the idle list without an import row.
  The native OS chooser/drop remains a release check.
- **Gap:** no cross-platform atomic no-replace directory publication primitive;
  concurrent user additions/edits must survive rollback. See
  [File Transactions](architecture.md#import-publication).
  Cross-platform native-picker and signed-installer validation remain release checks.

## J03: Documents

**Intent:** [J03](../design-docs/journeys/README.md#j03-read-and-edit-source-documents).
The [Documents design](../design-docs/journeys/documents.md) owns navigation, continuity,
and recovery behavior; the evidence below establishes its exercised paths.

**Implementation:** Renderer: `renderer/src/features/documents/ui/source/registry.tsx`, `renderer/src/features/documents/application/document-runtime.ts`, `renderer/src/features/documents/ui/markdown/document.tsx`.
Inline review: `renderer/src/features/documents/domain/revision.ts`,
`renderer/src/features/documents/ui/markdown/use-revision-review.tsx`,
`renderer/src/features/documents/hooks/use-revision-proposals.ts`, and
`renderer/src/features/documents/ui/markdown/revision-adapter.ts` over a patched
`@milkdown/plugin-diff` (`patches/`).
Humanize on a selection: `renderer/src/features/documents/ui/markdown/humanize-selection.ts`,
`use-humanize.ts`, `humanize-toolbar.ts`, `renderer/src/features/documents/infrastructure/humanize-api.ts`;
host `server/humanize.ts` and `server/routes/humanize.ts`; wire
`shared/protocols/http/humanize.ts`.
A save refused against a version a deleted file no longer has, whose reload confirms
the source is gone, enters the document's `detached` state and stops autosave.
`application/draft-settlement.ts` turns a close or a release of such a tab into the
question rendered by `ui/workspace/discard-draft-dialog.tsx`, and `document-runtime.ts`
owns the explicit restore, which re-attempts the ordinary save before creating the file
so a source that came back is compared instead of overwritten.
Host/services: `server/file-save.ts`, `server/text-file-transaction.ts`,
`server/document-revisions.ts`, `server/routes/document-revisions.ts`.

**Status:** Release-dependent.

- **Contract Test:** `pnpm test:renderer`, `pnpm test:project-files`,
  `pnpm test:electron`, and `pnpm test:electron:smoke` cover format capabilities, source identity,
  hidden-file policy, tab/history behavior, save barriers, shared version
  authority, conflicts, and failure handling.
  `pnpm test:config` covers strict durable preferences.
  Transaction/Python regressions cover concurrent saves, staging-time external
  edits, failed empty-source removal with same-content retry, and consecutive
  projection acceptance while a local embedder blocks. They do not establish
  provider completion or search latency during a pending revision.
  HTTP source-format contracts isolate index admission; they do not start or
  verify the Python daemon. Real daemon lifecycle belongs to Electron smoke
  and the built-service pass below.
  `revision-engine.test.ts` proves the inline review against the real Milkdown
  build with DOM clicks: what a proposal renders, which commands dirty the
  buffer, and that a per-change Reject resolves a deletion, including one of
  two adjacent deleted blocks while the other stays acceptable.
  It also proves the patched start keeps a document's trailing empty
  paragraph out of the diff. `humanize-selection.test.ts` proves, on the same
  build, that a selection widens to whole blocks, refuses code, and that the
  proposal reviews as exactly one change on a document ending in a list;
  `use-humanize.test.tsx` covers the request's refusals (review open, not
  prose, document changed, cancelled, rebuilt editor) and both failure
  ladders; `server/humanize.test.ts` and `server/routes/humanize.test.ts`
  cover stream draining, the cut-off refusal and status mapping. One real
  request through `server/humanize.ts` reached the live service on 2026-09-22
  and returned a whole rewrite in about two seconds. Unproven: the shared
  per-address rate limit under real use, and rewrite quality.
- **Driven Runtime Pass (Humanize, 2026-09-22):** the built application, with
  its own user data and port, opened a seeded folder from Recent, opened its
  Markdown draft in Edit mode, and took real mouse input. A drag from a
  paragraph across the code block into the list, then Humanize on the
  selection toolbar, showed the refusal notice naming prose and left the
  document untouched; Dismiss cleared it. A drag over one paragraph and
  Humanize showed the running notice, and within seconds the live service's
  rewrite opened as a review of three changes, all inside that paragraph,
  with the code block and the list after it unmarked. Screenshots were
  reviewed by eye; the pass records no timing beyond "seconds".
- **Driven Runtime Pass:** isolated built-app passes cover preview reuse/keep,
  history, draft creation/rename, and kept-only tab restoration. Earlier journal
  restoration passes apply to the removed snapshot feature, not current durability. A separate window-origin
  API pass proves one success/one conflict for same-version saves and missing
  asset refusal; it does not drive editor typing or conflict-dialog decisions.
  The 2026-09-15 v2.7.0 retry exercised the built service with a real Python/MFS
  daemon: consecutive versioned saves, stale-write rejection with source
  preservation, empty-source removal from keyword results, and rejection of
  blank Agent identity and cross-project writes. No embedding key was configured;
  this pass does not establish real-provider latency or ranking quality.
- **Documents runtime pass (2026-09-15):** the built desktop app used an isolated
  real project to exercise hidden-tab autosave, undo after tab switching, external
  disk conflict, marker refusal and explicit merge completion, New tab close,
  rename rebinding, immediate Markdown publication, and undo after six other
  kept Markdown editors. No Agent/provider fixture was needed. The source files
  and visible editor contents were checked; this was not a packaged release.
- **Inline revision runtime pass (2026-09-18):** the built renderer in Electron
  opened an isolated Markdown project on the X11 display. A controlled
  window-origin `suggest_edits` request left the Plan.md source unchanged on disk, then
  its Documents tab showed one inline deletion/insertion and the whole-review
  controls. The dark desktop composition was inspected by eye with both Chat
  and Documents visible. Accept all saved the exact proposed text to disk.
  This pass did not use a live Agent provider or a packaged build.
- **Per-change Reject runtime pass (2026-09-20):** the built renderer in
  Electron on macOS, with an isolated HOME, user-data directory and port, opened
  a seeded Markdown project and its document, then a window-origin
  `suggest_edits` request parked a proposal holding one pure deletion of a
  wrapped sentence and one replacement. Real mouse input hovered the deleted
  text, revealed its card and clicked Reject: the card and the strikethrough
  went away, the bar dropped to one suggested change, and the file on disk was
  unchanged. Accept on the remaining card closed the review and autosave wrote
  exactly the expected text, the kept sentence included. The light composition
  was inspected by eye. No live Agent provider or packaged build was used.
- **AI Eval:** not required.
- **Release Check:** representative complex PDF/DOCX/media in packaged viewers.
- **Gap:** packaged multi-format viewer behavior and large-project resource
  use remain unproven. The runtime pass above covers the changed text/Markdown
  flow, not every format or every interruption. See
  [conflict recovery](architecture.md#source-transactions).
- **Detached-draft runtime pass (2026-09-17):** the built renderer in Electron, with
  an isolated HOME, its own user-data directory and port, drove one real project: open
  a Markdown file, switch to Edit, type, autosave (41 bytes on disk), then delete it
  from outside the app and keep typing. The chip reported the draft as unsaved, Cmd+W
  asked "Close without saving?" naming the file instead of doing nothing, Cancel kept
  the tab and the draft, Restore file recreated the source with the draft in it, the
  next edit autosaved again, and a second Cmd+W closed the tab with no question.
  Not driven: the native window-close/quit barrier, because a renderer-side
  `window.close()` bypasses the main process's close event (proven with an
  always-refusing release handler), and CDP cannot deliver the native gesture. The
  only product caller of `window.close()` is the bug-report window, which holds no
  drafts.
- **Detached drafts:** `document-lifecycle.test.ts` covers the autosave stop, the
  close and release questions, the restore that creates the file, and the comparison
  that replaces it when the source came back. `work-preservation.test.tsx` covers the
  reader's path through the chip and the dialog. A transaction regression proves the
  host contract both depend on: a versioned save to a deleted source is refused, and
  only a write carrying no base version recreates it. The save barrier refuses a release
  while such a draft is open, so quitting needs the reader to restore or discard first
  and then repeat the quit; that refusal is proven at the renderer layer only, and no
  packaged build has been driven through this journey.
- **Known issues — source/viewers:** Markdown relative images lack folder-scoped resolution/upload/lightbox; heading
  ids are assigned by order without identity cross-check. PDF placeholder/observer
  counts are unbounded. Active-line paint is not focus-scoped.
  Markdown retention remains a format-name exception outside the registry.
- **Known issues — work continuity:** sandboxed HTML owns its internal scroll
  position; host reading-position capture does not cross that boundary. Sidebar
  resizing is pointer-only. Native close tracks document
  load rather than separate save-handler readiness, with failure/timeout keeping
  the window open. Recovery is a React remount, not a native reload protocol.
- **Documents implementation (2026-09-15):** focused regressions cover explicit
  merge completion with no marker autosave, version-checked Keep-my-version,
  hidden-tab autosave, retained CodeMirror undo, New tab close routing, preview
  refresh preservation, and failed-open preservation of preview/history.
  `app/workflows/mutate-documents.test.ts` covers all-tabs retention on a later
  save refusal, confirmed rename identity/order, deletion, and scope retirement.
  `workspace/infrastructure/file-operation.test.ts` covers receipt-only retries;
  `server/routes/file-mutations.test.ts` drops a real rename response and checks
  its receipt and safe replay against a newly created file at the old path.
  These controlled tests do not establish packaged behavior or large-project
  resource usage. Activated Markdown editors now remain alive until their tabs
  close; memory use with many complex open documents needs measurement.
- **Durability limit:** the keychain-backed draft journal is removed by product
  decision. Automatic saves, versioned conflict handling, and native save barriers
  remain. Process crashes and shell remounts can lose text not yet saved to source.
  No existing keychain item or old snapshot is read, migrated, or deleted.
- **Known issues — trust:** executable source HTML and remote subresources remain
  weaker than intended isolation. The current opaque frame is not approval to
  expand script/network authority.

## J04: Preparation

**Intel compatibility (2026-09-17):** unsupported-system status bypasses download
and retry, while supported Intel component installation still verifies the
architecture-specific manifest and works offline. `extractor-runtime.test.ts`
owns those outcomes; `local-component-group.test.tsx` verifies the explanation
and absence of a misleading Retry action. Hosted Intel macOS 15 packaging passed
signed/notarized component execution, fixture PDF/OCR, and offline reuse.
Representative OCR quality and live release download remain release checks.
An isolated Electron render of the production recovery component and built
styles confirms readable wrapped copy and no Retry control for unsupported
systems. This checks the component composition, not a real Intel PDF journey.

**Status persistence (2026-09-16):** SQLite failures reject reads/writes rather
than reporting durable cancellation. Failed terminal writes remain pending in
process memory and are replayed after storage repair before discovery proceeds.
`conversion-status.test.ts` exercises corrupt storage, cancellation refusal,
repair without restart, persistence after reopen, and explicit reprocessing.
An unrepaired process crash cannot durably preserve a failed write.

**Contextual component recovery (2026-09-16):** `workspace-panes.tsx` composes
`local-component-recovery.tsx` beside a pending PDF/image, using the existing shared
installation port. Its test verifies no implicit retry, explicit retry, and
removal after installation. The installation owner and source cancellation are unchanged.

**Intent:** [J04](../design-docs/journeys/README.md#j04-prepare-a-hard-to-read-file).

**Implementation:** Renderer: `renderer/src/features/preparation/public.ts`.
Host/services: `server/conversion-dispatch.ts`, `server/conversion-scheduler.ts`, `server/extractor-runtime.ts`, `server/sync.ts`.

**Status:** Release-dependent.

- **Contract Test:** `pnpm test:config`, `pnpm test:conversion-scheduler`,
  `pnpm test:python`, and `pnpm test:package-inputs` cover format completion,
  freshness, checkpoints, cancellation including descendants,
  native worker wiring, and bounded component install/retry/offline reuse.
- **Driven Runtime Pass:** PDF/OCR recovery (2026-09-15) covers
  failed first demand, no polling retries, one Settings retry, next-launch
  download/resume, and a later offline process with zero downloads. It uses a
  retained component build and controlled transport; picker/key storage are
  substitutes.
- **AI Eval:** no shared extraction-quality Eval claimed; correctness requires
  format-specific fixtures or datasets.
- **Release Check:** representative native PDF/OCR/DOCX, live component
  delivery/notarization, and no console/focus theft on Windows.
- **Background fixes (2026-09-16):** `server/background-recovery.test.ts`
  exercises production conversion/indexer wiring without waiting for semantic
  completion and verifies OCR cancellation waits for a stubborn real descendant.
  PDF and OCR share the same process-tree completion barrier. Component tests
  cover active/failed source cancellation, preserved peer demand, explicit
  component ownership, shutdown, and next-launch recovery. The affected backend
  suite passes 146 tests; retrieval passes 25 tests.
  A source-runtime pass with real Python/MFS and an isolated local embedding
  endpoint accepts two prepared files, frees each heavy lane, and returns both
  in keyword search while embedding remains blocked. Extracted text is a fixture;
  this does not establish OCR quality or packaged cross-platform behavior.

Media preparation is retired; see the [removal record](../docs/history/media-transcription-removal.md).
Direct media playback remains part of J03, without transcript or conversion.
An isolated macOS built Electron/server pass (2026-09-15) played a generated WAV,
showed the unavailable state for invalid MP4 bytes, and admitted only the Markdown
fixture to real MFS. This does not establish packaged codec coverage.

## J05: Search

**Search setup (2026-09-16):** unconfigured search exposes a direct Settings
Advanced entry. `project-search.test.tsx` checks that invoking setup preserves
the keyword query and does not submit semantic search.

**Intent:** [J05](../design-docs/journeys/README.md#j05-search-and-open-source-evidence).

**Implementation:** Renderer: `renderer/src/features/retrieval/ui/project-search.tsx`, `renderer/src/features/retrieval/ui/search/backends.ts`.
Host/services: `server/retrieval/index.ts`, `server/indexer.mfs.ts`, `python/stashbase_daemon.py`.

**Status:** Partial.

- **Contract Test:** `pnpm test:retrieval`, `pnpm test:python`, and the scoped
  project/config/renderer suites cover exact filtering, hybrid mechanics,
  current-source mapping, namespace isolation including nested projects,
  missing/blank/stale identity refusal, provider-independent keyword search,
  and current/failed/cancelled preparation. A real-daemon deletion-failure
  probe verifies cleared text cannot leak old evidence and identical save retries.
  A local blocked embedder exercises independent keyword/status responsiveness.
  Release-based setup was verified on 2026-09-15: MFS `v0.1.0` replaced the
  Git-sourced installation, matched its archive URL and package version, and
  remained installed on a second setup run without reinstallation.
- **Driven Runtime Pass:** no-key built-app passes prove keyword-only UI and
  Settings entry, exact retrieval over the then-bundled guide, separate project results, omitted
  scope refusal, nested namespace retirement/update, and deleted-source filtering.
  Nested ownership was repeated on 2026-09-14 against MFS `357fe252`, and setup
  provenance matched the pin after replacement and a no-op rerun. These use the
  development Python runtime, not packaged sidecars or real embedding providers.
- **AI Eval:** `pnpm eval:semantic-retrieval` runs the versioned
  [dataset](../evals/semantic-retrieval/README.md) through production interfaces,
  reporting distinct-source Recall@3/MRR, misses, unexpected hits, and selected
  keyword comparisons. Multi-chunk fixtures expose chunking changes. Activation
  requires three retained runs for each supported BYOK provider.
- **Release Check:** credentialed OpenAI/OpenRouter evaluations; paid and variable
  provider requests are not source CI.
- **Background fixes (2026-09-16):** an unreadable-subtree regression verifies
  incomplete enumeration cannot remove existing projections. Real sync
  orchestration tests inject daemon retirement during upsert and deletion,
  verifying rebind, retry, and a successful result without false file failures.
  The redundant `folderReady` set is removed; successful daemon status establishes
  readiness directly. Runtime keyword availability during blocked embedding is
  covered by the J04 pass above.
- **Gap:** no retained baseline, so thresholds remain in calibration; see
  [issue #176](https://github.com/liliu-z/stashbase/issues/176).

## J06: Agent

**Default Agent billing:** Settings -> Agents exposes Plans and billing through
`settings/hooks/use-account.ts` and `settings/ui/agents/agents-panel.tsx`. The
website and hosted API own Checkout, subscription state, and paid allowance
ceilings; the existing allowance query refreshes the desktop. The panel test
checks the fixed external destination. Hosted API integration tests cover
account isolation, idempotent Checkout recovery, paid-through expiry, tier changes
without usage resets, and settlement after cancellation. The built Settings Story
was visually inspected with a signed-in fixture; built website browser checks
covered sign-in return, Checkout/Portal navigation, and mobile layout with mocked
auth and API responses. Real Stripe test-mode validation covered the half-price
first invoice, full allowance, upgrade/downgrade, configured-only Portal offers,
minimum-expiry rejection recovery, and cancellation. Regression checks cover
invoice pagination, customer reconciliation locks/backoff, independent Stripe
maintenance/deletion jobs, audited catalog changes, and pricing-page restoration
after cached browser navigation, re-authentication after payment, token refresh
while opening Checkout, and disabled purchase during unavailable status. Checkout
switching retires the previous payable session before opening another; regressions
cover ambiguous creation, expiration failure, and early expiration. The allowance
hook refreshes on desktop window focus and removes its listener on unmount.
The hosted API repository's `dev:billing` command starts a test-only local stack;
the website repository's Astro billing integration reuses the production
handlers with a loopback transport. Local runtime checks covered the actual pricing page,
Stripe CLI webhook forwarding, scheduler processing of a paid half-price test
invoice, full fixture allowance, and child-process shutdown. These checks used
an SDK-created test subscription. A subsequent user-driven local sign-in and
Checkout completed a $5 half-price Plus test purchase; provider and local records
agreed on the active subscription and paid-through date, with all three payment
events processed and the full fixture allowance available. This establishes the
local initial-purchase flow, not live collection or packaged desktop handoff.
The API's repeatable `billing:verify` command passed real Stripe test-clock
renewal, failed collection, payment recovery after store restart, cancellation at
period end, and paid prorated tier changes against an isolated PostgreSQL ledger.
Allowance expiry uses the simulated timestamp explicitly. Read-only readiness
checks and protected billing queue/failure/staleness metrics support release
operations. A PostgreSQL regression covers queued and late webhook acknowledgement
when account deletion retires the billing identity.
An isolated real Stripe Portal browser pass completed Plus -> Pro -> Plus with
prorated invoices and period-end cancellation. The payment-method page did not
render a card form in the automated browser after retries, so card replacement
remains unverified; SDK payment recovery does not establish that browser action.
That Portal pass exposed timestamp-based cancellation missing from the local
indicator; the provider now handles an explicit cancellation at the current
period end, with regression and real-provider projection checks.
Real live-mode payment,
production renewal collection, browser card replacement, and packaged cross-browser account handoff remain release
checks; local and Stripe test-mode checks do not establish those behaviors.


**Agent switching:** `application/session/controls.ts` resets runtime-specific
choices without adding a composer notice. The session recovery test switches a
Codex draft with model, effort, and skill selections to Default, verifying the
draft survives and no context issue is introduced. A driven built-Storybook pass
also switched a Codex draft with a selected model and High effort to Default,
confirming the draft remained and no notice appeared. This uses controlled ports,
not a packaged app or live provider. All 12 renderer gates, host types, Electron
tests and smoke, service builds, and documentation validation passed.

**New-chat thinking effort (2026-09-16):** project preferences persist explicit
effort separately for each Agent. Workspace/session tests reproduce High reverting
to Medium, verify the next Codex connection receives High, preserve project/runtime
isolation and restart choices, and keep history/catalog defaults from changing the
preference. Host-route tests exercise persistence, invalid input, explicit Default,
and effort updates without switching the project's preferred Agent.
An isolated built-main/host/renderer pass selected Codex High through the composer,
verified the real preferences route persisted it, created a new chat and inspected
its `effort=high` socket request, then reloaded the renderer and created another
chat with High retained. The catalog/socket were controlled; this is not a live
Codex provider run. Validation: all 12 renderer gates, 57 configuration tests,
96 protocol tests, host types, service builds, and documentation checks passed.

**Claude model choice (2026-09-18):** `server/agent.ts` applies a model only when
one was chosen; with nothing chosen the runtime keeps the model the user's Claude
settings name. Reproduced against Claude CLI 2.1.220 with its user settings naming
Fable 5.1: a bare session ran Fable, the SDK's `setModel(undefined)` switched the
session to Opus 5 with 1M context, and an explicit Fable id ran Fable. A pick made
while the runtime is still starting is held for catalog discovery instead of being
refused, and the init event's release name (`claude-fable-5-1`) maps onto the
catalog's context variant so the composer keeps its label. Host tests cover the
untouched runtime, the held pick, and the name mapping; the renderer transport
re-sends a model picked while the socket was still opening. The reproduction was
a scratch SDK script against the live CLI, not the packaged application.

**Runtime update (2026-09-18):** `server/agent-turn-failure.ts` classifies a
runtime too old for its model as `runtime-outdated` (observed live: Claude
2.1.220 refusing Fable 5.1 with a 400 naming 2.1.251 as required).
`server/agent-runtime-installer.ts` runs the runtime's own updater in place
through the bootstrap coordinator, then re-verifies the executable and
reconnects MCP; the updater was verified on an isolated npm-prefix copy of
2.1.220, which moved to 2.1.276 with a clean exit. The listing carries the
installed version and whether an in-app update exists. The failed turn offers
Update Claude through `hooks/use-agent-runtime-update.ts`, which waits for the
runtime to be ready, reconnects the conversation so the service spawns the
updated executable, and resends the refused request; Settings → Agents shows
the version and the same Update. Tests cover the coordinator's update paths, the
updater command runner against a real shell, the classifier, the version cache,
descriptor and schema fields, the hook's reconnect-and-resend and refused-update
paths, the transcript's action swap, and the Settings action. Codex offers the
same Settings update through its own update subcommand, verified on an isolated
npm-prefix copy of 0.153.4 that moved to 0.155.0; its catalog comes from the
installed app-server, so an old Codex hides newer models rather than refusing
them, and the chat-side update action never triggers for it. A Codex model
chosen while its catalog is still being read is now held for that read instead
of being refused as unavailable. Not proven: the packaged application running
a real update end to end.

**Newer-model offer (2026-09-23):** Claude learns from its server which models
an account may use, including ones the installed build is too old to run, and
caches that answer in `~/.claude.json` as `additionalModelOptionsCache`.
Observed on 2.1.276 with Opus 5.5 released: the cache holds
`{value: "cc-update-required-1", label: "Opus 5.5 (disabled)", description:
"Update to 2.1.280+ to use Opus 5.5", disabled: true}`, while the SDK
`initialize` handshake omits disabled entries (five entries, none disabled) and
a live turn on `--model opus` reported `canonicalModel: claude-opus-5`. So the
fact is local but not in the catalog: `server/claude-model-catalog.ts` reads it
from the file beside the user settings it already reads, cached by mtime,
and passes the runtime's own model name and sentence through unchanged.
StashBase compares no versions of its own, so it can never claim a requirement
the runtime did not state. Every unreadable shape is silence. The offer reaches
Settings → Agents as the row's leading sentence beside the Update it already
carried, and the chat as `ui/upgrade-offer.tsx` above the composer, which runs
the same in-place update through `use-agent-runtime-update.ts` with no refused
request to resend and is dismissed for the window. Tests cover the disabled
filter, the label's parenthetical, every malformed shape, a missing and an
unparseable file, the mtime re-read that withdraws the offer after an update,
the row's copy, and the card's update call, dismissal, completion, and failure.
Codex reports no equivalent, so it is never offered one. Driven through
`/api/terminal/clis`: a fixture `CLAUDE_CONFIG_DIR` naming the disabled entry
produced the offer on the Claude row and on no other, and the live withdrawal
was observed when the CLI auto-updated to 2.1.280 mid-session, after which the
cache dropped the entry, the listing dropped the offer, and the catalog began
resolving `opus[1m]` to `claude-opus-5-5[1m]`. Not proven: the offer rendered
in the running application, and the cache's freshness for a reader who has
never run a Claude turn from StashBase.

**Tool-attempt presentation (2026-09-16):** `ui/transcript/activity.tsx` omits failed
tools from chat, including summaries and expanded details. Activity tests cover
a subsequent running, successful, or failed call, empty-group suppression,
and changed-file results only after success. Transcript tests keep a
terminal turn failure and its retry action visible, and retain progress after a
running tool fails. No retry identity is inferred
from a shared file path; the native runtime still owns execution and retries.
The `FailedAttemptThenSuccess` Story covers the reported failed-edit/success layout.
An isolated built-main/host/renderer pass with controlled Agent socket events
verified failed-only activity disappears, the successful file result and final
reply remain visible, expanded activity excludes the failure, and a subsequent
network turn failure retains its retry action. Both collapsed and expanded
layouts were inspected. This proves presentation, not real-provider retry behavior.
Validation: 35 focused tests passed; the subsequent combined validation passed
all 12 renderer gates, including coverage.

**Shell and subagent writes (2026-09-21):** a Claude Writer subagent created
a draft through a Bash heredoc, so no tool named the file: the turn
showed no file result, nothing reported the write, and the daemon's tree
revision never moved, so Files kept the stale listing. `domain/file-change.ts`
now asks, when a turn settles, whether it ran a call that could have written
unseen (a command, a subagent, or any tool it does not parse; reads, listings,
searches, and questions are excluded), and `application/session/events.ts`
reports the folder as possibly changed. `use-folder-refresh.ts` takes that
report down the existing Agent-write path: re-read the listing, reconcile the
folder, re-read listing and status. A file result and its Open still require a
named write; a shell-written file has none by design and appears in Files
instead. Tests cover the classification, the settled-turn report against a
read-and-reported-write turn, and the hook's reconcile with no named source.
Validation: the complete `pnpm check` matrix passed in one run, including all
12 renderer gates with coverage, `pnpm test:electron`, host types, and the built
Electron smoke. An isolated built-app pass on macOS then wrote a Markdown file
into an open project from outside any file tool and posted the window-origin
`/api/sync` this report triggers: the reconcile added exactly that file, the
tree revision moved, and `/api/files` listed it. Not proven: a live runtime
turn through the built desktop, because no runtime signs in under an isolated
home; the renderer's report itself rests on the tests above.

**Work in progress presentation (2026-09-16):** a running turn is narrated by the
activity group that closes the transcript: `ui/transcript/tool-presentation.ts`
names the step in hand while the group is live and returns to the aggregate
summary once the turn settles, and `ui/transcript/transcript.tsx` marks that
group live from the turn rather than from any single call's status, so the
header keeps moving between two calls. The standing thinking indicator now
stands in only when no live group or decision card closes the transcript.
Transcript tests cover the reported still frame between calls, the settled
header, and a pending decision; presentation tests cover the running step,
parallel calls, refused calls, and one-ellipsis clipping of a long command.
The `StillWorking` Story shows the live and settled headers together.
A built-Storybook pass inside Electron's Chromium confirmed the live header
reads the step just taken while the settled group beside it keeps its summary.
That pass renders the group alone; a streaming turn against a real provider,
where the header advances call by call, remains unverified.
Validation: all 12 renderer gates passed, including coverage and Story
accessibility, and documentation checks passed.

**Request and attachment lifetime (2026-09-16):** the hosted broker binds
requests to the active turn's cancellation signal before reading the body.
Retirement closes local requests and aborts upstream work; token acquisition and
refresh recheck that signal before forwarding. Broker tests cover cancellation
during token acquisition, refresh, and an upstream request. Active-process
attachment batches survive age cleanup; old batches from previous processes
remain temporary. The attachment route test ages a live upload and verifies its
bytes survive while an abandoned batch is removed. OS/external deletion is not
prevented, and historical metadata does not restore attachment bytes.

**Intent:** [J06](../design-docs/journeys/README.md#j06-start-and-continue-an-agent-chat).

**Implementation:** Renderer: `renderer/src/features/agent/application/workspace-runtime.ts`, `renderer/src/features/agent/application/session-runtime.ts`.
Host/services: `server/agent-contract.ts`, `server/agent-adapters.ts`, `server/agent-runtime-installer.ts`.
Project choice and first Send: `renderer/src/features/agent/application/project-agents.ts`,
`renderer/src/features/agent/hooks/use-agent-access.ts`,
`renderer/src/features/settings/hooks/use-account.ts`, `server/routes/agent-preferences.ts`.

**Status:** Release-dependent.

- **Contract Test:** `pnpm test:agent`, renderer, project-operation, MCP, and
  config suites cover setup/consent, authentication, scope, permissions,
  queue/turn/history ownership, stop/retirement, failure classification,
  instructions, and transcript/layout state. Automatic grep/hybrid selection
  follows current key configuration; explicit/provider failures do not silently
  change strategy. Instructions save for later mounts, not the current session.
  `pnpm test:opencode:native` completes a turn with the bundled executable and a
  local fake gateway; broker suites cover token/turn isolation, retry, and credits.
  Focused first-send tests cover project-default selection, durable explicit
  choices, preference failures, retained drafts, one continuation after access,
  cancellation on edits/navigation, and waiting for native setup readiness.
  Account waiters share one browser flow and cancel independently; route tests
  exercise registered-project validation and preserve corrupt configuration.
- **Driven Runtime Pass:** isolated built-app seeded-Claude-history passes
  exercise restore, copy/edit actions, timestamps, and Chat-pane controls without
  a live signed-in runtime. A window-authorized read pass (2026-09-14) proves
  source/prepared-path parity and stale/deleted-source refusal with seeded PDF
  output, not a native preparation or model turn.
  A built-app pass (2026-09-15) with an isolated project and controlled Agent
  HTTP/socket events verifies draft reachability, mode switches, paused queues
  after Stop/failure/connection loss, same-session reconnect without resend,
  history restore, title search, folded activity, math, and return to latest.
  It uses production main/renderer code, not a live provider or signed package.
  A project-first pass (2026-09-16) through the built main, renderer, and host
  verifies Welcome without a composer, native-picker entry (with a controlled
  picker result), draft retention across Documents/Chats, Default first-send
  sign-in prompting, and cancellation without losing the draft. Built HTTP/WS
  checks reject missing, retired, aggregate, and unregistered session scopes;
  registered-project history still loads. Isolated credentials leave installed
  Codex history unavailable; this pass does not establish authenticated native
  history or a real-provider turn.
  A built Storybook pass in Electron (2026-09-17) checks the neutral permission
  card in light and dark themes. Allow and Reject remove the decision controls,
  show Running and Denied respectively, and return focus to the heading. This
  verifies the rendered card and its controlled reply callback, not native
  Agent execution.
  Clarifying questions (2026-09-18): focused renderer tests cover the question
  card's answers keyed by question text, multi-select and typed answers joined
  as the runtime reads them, Answer held until every question has one, Skip
  denying, and answers kept on the settled call; the Claude adapter test proves
  answers reach only the question tool's updated input, and the socket schema
  accepts them. A built Storybook pass in Electron drives the card in light and
  dark: single and multi-select choices, the Other line, Answer replacing the
  controls with Running, and the settled row opening to the questions and
  answers. This is the rendered card and its reply callback, not a live
  Claude turn.
- **AI Eval:** mechanics do not establish prompt adherence or writing quality;
  see J10 and J12.
- **Release Check:** signed bundled OpenCode executability plus a fake-gateway
  turn, a real hosted OpenQuill turn/credit response, external CLI installation
  and browser authentication, and runtime-supported clipboard image attachment.
  This is attachment support, not the removed clipboard screenshot capture.
- **Interaction contract:** session-owned queues advance after success and pause
  on Stop/failure/connection loss. Focused runtime tests cover refusal, retained
  drafts and context, explicit continuation, unknown outcomes, restored identity,
  and protected titles. Sidebar title search includes drafts; arrows follow
  project visits. Thinking/routine tools fold per turn, with approvals, failures,
  and file results visible. Markdown supports math and scoped file navigation.
- **Limits:** historical attachment metadata cannot recover upload bytes; reuse
  shows unavailable items and requires replacement or explicit removal. Direct
  Retry requires the exact retained request; restored-only requests use Reuse. Unknown
  outcomes require reconnect/review and deliberate continuation. Local transport
  acceptance is not proof that native work finished. Real-provider cancellation,
  reconnect timing, writing quality, and packaged behavior need the checks above.


- **Installation/runtime fixes (2026-09-16):** focused regressions in
  `server/__tests__/agent-runtime-recovery.test.ts` cover unrelated commented and
  quoted TOML tables, multiline strings, idempotence, refusal without writes,
  retained login-shell discovery after elapsed time, and real POSIX descendant
  termination after its leader exits. Codex session tests verify that a process
  crash does not disable subsequent runtime access. Installer tests retain
  cancellation, authentication, output verification, and temporary-file cleanup.
  Validation: 195 Agent tests, 145 Settings tests, 97 protocol tests, host types,
  service build, and documentation checks pass. The full renderer gate is not
  green: first-send conventions and unused exports remain; seven failures in
  four chat/document test files all pass when rerun together (22 tests).
  A built-app pass with an isolated home and controlled HTTP responses verifies
  provider-owned rows, failed installation followed by explicit retry, and the
  remaining failure controls. It does not execute an official installer.
  Private-runtime discovery/manifests/uninstall and development source overrides
  are removed; official installations remain provider-owned. Real provider login,
  official installer downloads, and packaged cross-platform shutdown remain
  release checks, not established by these local fixtures.

## J07: Converge

**Intent:** [J07](../design-docs/journeys/README.md#j07-converge-chat-into-a-document).

**Implementation:** Renderer: `renderer/src/features/agent/application/session-runtime.ts`, `renderer/src/features/documents/application/document-runtime.ts`, `renderer/src/app/composition/layout/workspace-panes.tsx`.
Host/services: `server/project-file-mutations.ts`, `server/text-file-transaction.ts`,
`server/document-revisions.ts`, `server/project-operations/index.ts`.

**Status:** Release-dependent.

- **Contract Test:** `pnpm test:agent`, `pnpm test:mcp`,
  `pnpm test:project-files`, and `pnpm test:renderer` establish permission, version, and write boundaries, including literal
  dollar-sequence replacement.
- **Composition Test:** `agent-convergence.test.tsx` exercises both a Chat file
  result's Open action and a reply's local file link: each selects Documents,
  shows the file, and retains the same conversation and unfinished follow-up.
- **Driven Runtime Pass:** isolated built-app window-authorized write/edit
  (2026-09-14) persists literal replacements with version checks. It proves the
  file boundary, not a real conversation producing a requested draft/revision.
  A controlled built desktop pass (2026-09-16), with a fixture Agent transport
  and real document services, clicks both Open and a local Markdown link from
  Chats. Both select Documents and display the file while retaining the same
  Agent session and unfinished follow-up.
  The 2026-09-18 inline revision pass in J03 drove a controlled proposal through
  the built desktop and accepted it to disk; a real Agent turn producing that
  proposal and its matching Chat card remain unproven at runtime.
- **Proposing or writing (2026-09-22):** a real Claude conversation edited an
  open draft with the native edit tool and then with `edit_file`, and reached
  `suggest_edits` only at its end. Its StashBase tools had been deferred behind
  Claude's tool search, so it held their names without descriptions, and the
  routing policy said nothing about writes. `server/agent-mcp.ts` now writes
  Claude's entry with `alwaysLoad`, and `server/agent-runtime-instructions.ts`
  states when a Markdown revision is proposed and when a file is written.
  `pnpm test:agent` covers the policy reaching a Claude session and the config
  write keeping a user's other settings. A controlled Claude CLI probe with tool
  search forced on read the description of `suggest_edits` with the flag and
  held only its name without it. Not proven: that a real runtime follows the
  guidance turn after turn. It is a standing instruction, not a gate, and no
  conversation was driven after the change.
- **AI Eval:** requested writing quality belongs to J10. Existing deterministic
  orchestration evidence is not document-specific diff evidence.
- **Release Check:** real-runtime requested draft/revision followed by editor save.
- **Validation:** the pre-commit coverage run passes all four Canvas cases and
  all 1,456 renderer tests. The initial full-suite run exceeded the default test
  timeout while the isolated case passed; the composition cases now allow time
  for workspace startup and their bounded surface waits under coverage load.
  The remaining renderer gates, host/service tests, types, service builds, and
  built Electron smoke checks passed.

## J08: External MCP

**Intent:** [J08](../design-docs/journeys/README.md#j08-connect-an-external-agent-through-mcp).

**Implementation:** Renderer: `renderer/src/features/settings/ui/mcp/mcp-access-panel.tsx`.
Host/services: `server/project-operations/index.ts`, `mcp/server.ts`, `server/routes/mcp-http.ts`, `server/mcp-http-service.ts`.

**Status:** Partial and release-dependent.

- **Contract Test:** `pnpm test:mcp`, `pnpm test:project-files`, and
  `pnpm test:retrieval` cover transport/operation parity, authorization, scoped
  direct/prepared reads, bounded windows, format/encoding restrictions, mutations,
  and reconcile. Current/stale/cancelled/orphaned prepared evidence is covered.
- **Driven Runtime Pass:** a 2026-09-16 isolated source HTTP client initializes
  MCP, lists tools, reads a registered Markdown file through production Project
  Operations, rejects an outside-project read, and verifies token rotation.
  This is a controlled protocol client, not a third-party Agent or packaged launcher.
- **AI Eval:** retrieval quality is J05; client generation is outside app ownership.
- **Release Check:** packaged launcher, copied configuration, URL access, and a
  representative external client.
- **Gap:** deterministic boundaries have focused evidence; third-party connection
  and packaged launcher use remain unproven by those suites.
- **Listener retirement (2026-09-16):** disabling Docker access closes active
  connections as well as the listener. A real incomplete HTTP request in the
  MCP suite verifies disable and subsequent enable; the removed audio-search
  assertion has been updated to current format support.

## J09: Bug report

**Report entry (2026-09-16):** native Help owns report initiation. The Settings
shortcut and unused workspace-renderer bridge consumer were removed; the native
Help entry and separate report-review window remain.

**Intent:** [J09](../design-docs/journeys/README.md#j09-prepare-and-hand-off-a-bug-report).

**Implementation:** Renderer: `renderer/src/features/bug-report/application/review-runtime.ts`.
Host/services: `electron/bug-report-service.cjs`, `electron/bug-report-handoff.cjs`, `electron/bug-report/review-ipc.ts`.

**Status:** Partial and release-dependent.

- **Contract Test:** [collection](../electron/bug-report-collection.test.cjs),
  [review authority](../electron/bug-report-review.test.cjs),
  [redaction](../electron/bug-report-redaction.test.cjs), and
  [handoff](../electron/bug-report-handoff.test.cjs) establish privacy,
  snapshot approval, and artifact ownership, including spaced-path redaction.
- **Driven Runtime Pass:** built review opened from Settings, prepare/back/cancel;
  isolated Electron smoke covers privacy refusal/correction, sanitized log preview,
  Downloads copying, delayed-save edits, and approval locking using synthetic
  logs, a fixture capture window, and temporary Downloads. Export repair is
  focused filesystem evidence, not a packaged external handoff.
- **AI Eval:** not required.
- **Release Check:** packaged native capture, review, Downloads copy, browser handoff.

## J10: Core loop

**Intent:** [J10](../design-docs/journeys/README.md#j10-turn-a-local-project-into-durable-agent-assisted-work).

**Implementation:** Renderer: `renderer/src/app/composition/folder/use-agent-environment.ts`, `renderer/src/app/composition/folder/refresh-folder.ts`.
Host/services: `assets/agent-instructions/default.md`; follow J02/J03/J05/J06/J07 owners for the exercised path.

**Status:** Partial and release-dependent evidence for implemented writing.

- **Contract Test:** J02/J06 establish entry and Agent ownership, J03/J07 writing,
  and J04/J05/J08 supporting references/client paths. These do not prove usefulness.
- **Driven Runtime Pass:** no complete enter project → brainstorm → requested
  writing → return pass, especially from an empty project without a wiki/index.
- **AI Eval:** Gap. No representative useful-idea-development and requested-writing
  Eval over empty and reference-filled projects. Grounding is required when
  sources are used, not a prerequisite for every brainstorm. J05 is narrower.
- **Release Check:** packaged empty-project discussion, requested draft,
  inspection/edit/save, and return; also a reference-assisted native-runtime task.
  These verify writing and revision, including a proposed revision reviewed inline.

## J11: Conversation to project

**Intent:** [J11](../design-docs/journeys/README.md#j11-turn-a-conversation-into-a-project).

**Status:** Retired. No unbound conversation entry, Instructions scope, native
migration, or history override remains. The stable ID records removal, not a gap
or future commitment. Explicit MCP directory creation remains under J08.

**Implementation:** `server/agent-contract.ts`, `server/routes/agent-sessions.ts`,
`renderer/src/features/agent/application/workspace-runtime.ts` enforce project-first
sessions. Native history is in `server/claude-history.ts`, `server/codex-history.ts`,
and `server/opencode-agent.ts`.

**Evidence:** Agent contract tests reject absent/aggregate/unbound scope; workspace
runtime tests cover Welcome without a session and entry into the first project.
Provider quality and packaged behavior remain separate J06 evidence requirements.

## J12: Build Wiki Pages

**Intent:** [J12](../design-docs/journeys/README.md#j12-build-wiki-pages-from-a-local-folder).

**Implementation:** Renderer: `renderer/src/features/agent/ui/workspace.tsx`, `renderer/src/features/agent/application/session-runtime.ts`.
Host/services: `assets/agent-instructions/default.md`, `server/project-file-mutations.ts`, `server/sync.ts`.

**Status:** Partial and release-dependent.

- **Contract Test:** renderer suites cover runtime gates, explicit typed wiki
  requests, retained requests during setup, blank-chat runtime
  adoption, and sending without waiting for folder preparation. Agent, file, and
  data validation covers approvals, confinement, reconciliation, and admission.
- **Driven Runtime Pass:** real-app gated composer retains a typed Build Wiki
  request through runtime setup and restores Send without sending automatically.
  No real Agent page-generation turn is part of this pass.
- **AI Eval:** Gap. No representative mixed-format Eval of completeness, source
  links, useful pages, requested scope, and preservation of existing wiki content.
- **Release Check:** real packaged OpenQuill setup and generated-page review;
  optional BYOK indexing and an external Agent are separate secondary checks.
- **Gap:** model quality remains unproven; persistent ready/stale wiki state,
  scheduled rewriting, and an Update Wiki Pages mode are not product promises.

## J13: Gallery download

**Intent:** [J13](../design-docs/journeys/README.md#j13-download-a-ready-made-wiki-from-the-gallery).

**Implementation:** Renderer: `renderer/src/app/composition/gallery/use-gallery-shop.tsx`, `renderer/src/features/workspace/hooks/use-project-entry.ts`.
Host/services: `server/routes/gallery.ts`, `server/github-import.ts`, `electron/multi-window.cjs`.

**Status:** Partial.

- **Contract Test:** `pnpm test:protocols`, `pnpm test:renderer`, and
  `pnpm test:project-files` cover bounded whole-index
  parsing/fallback, image-host and redirect restrictions, cached browsing, copy
  serialization, and shared GitHub acquisition/publication rollback. The Electron
  smoke also loads the built Gallery UI through `app://renderer`, decodes cover,
  hero, and thumbnail images, and selects another screenshot using controlled
  proxy bytes with production CSP and native request authorization. See
  [Gallery boundary](architecture.md#gallery).
- **Driven Runtime Pass:** clean-profile bundled browsing and detail/Instructions
  inspection without account/runtime. A separate isolated built-app pass
  (2026-09-14) copies real `octocat/Hello-World` via a controlled Gallery index,
  registers it, opens a second bound window, and preserves the shop's null binding.
  Injected window-open failure preserves the copy/registration. OS key/URL setup
  is substituted; packaged delivery is not exercised. An isolated macOS source
  Electron pass (2026-09-15) loads the built UI through the production app
  protocol, browses the live published index, and visually verifies the ECCV
  2026 Orals hero and all three thumbnails. The original failure was relative
  image URLs resolving to bundled files, followed by CSP blocking the daemon
  image URL. Both are covered by the built-renderer smoke above. A further
  isolated pass (2026-09-15) hovered a shelf card carrying a long description
  and measured two rendered lines; restoring the `block` class beside the clamp
  in the same window returned four, which is what the shelf showed before.
- **AI Eval:** not required; acquisition does not generate content.
- **Release Check:** published index, CDN screenshots, real copy, and new window
  in one packaged pass.
- **Gap:** published delivery still needs verification in a signed installer. Wire fields
  `learnMore`, `starterPrompts`, `contents`, and `files` have no app surface.
  The shared flow now owns Gallery acquisition, conflict recovery, and window
  entry. The older separate-window runtime pass above predates this policy;
  the new J02 built-app pass verifies Welcome reuse, explicit conflict recovery,
  and retry without reacquisition. Packaged validation remains a release check.
- **Gallery review (2026-09-15):** reviewed the working tree at `ab8d4c9b`
  through catalog loading, details, clipboard, and shared project acquisition.
  Focused renderer and host/protocol suites passed 29 tests. Two temporary
  controlled probes reproduced the cache and selected-entry issues below;
  they were removed after review. This pass did not repeat live CDN or packaged
  verification.
- **Gallery recovery implementation (2026-09-15):** `use-gallery.test.tsx` covers
  reconnect after a failed catalog load. `gallery-refresh.test.tsx` covers
  reopening recovery, updated detail/copy identity, and withdrawal of a selected
  entry. `gallery/ui/recovery.test.tsx` covers clipboard refusal/retry, retired
  prompt feedback, and screenshot retry through the original proxy. The detail
  now labels the generating request **Prompt**, and missing metadata refers to
  a project. The unused copy-error prop chain and obsolete separate-window
  comments were removed; acquisition failures remain in the shared entry dialog.
- **Gallery recovery runtime pass (2026-09-15):** a native window loaded the
  built renderer through `app://renderer` and recovered a failed catalog and
  failed screenshot through the authorized local proxy. A controlled clipboard
  refusal kept the prompt readable, and retry displayed confirmation for the
  correct text. Service/clipboard failures were fixtures, not live CDN or OS
  permission failures. The standard Electron smoke also passed cover, hero,
  thumbnail decoding and selection with production CSP. Installed delivery
  remains a release check.

## Maintenance Rule

Update this map when ownership, evidence, status, or a residual check changes.
Keep stable Jxx anchors; record decisive behavior and substitutions, not copied
assertions/counts or execution diaries. Detailed new runs belong to the owning
change record. [UI Release Sanity](../release-checklists/ui-sanity.md) owns the
packaged checklist. Documentation validation checks links and reciprocal routes,
not the truth of a test's claims or intent metadata.

## Cross-cutting Gaps

- **Native crash recovery (2026-09-16):** confirmed renderer termination
  releases its save barrier; a live renderer timeout still blocks close.
  Lifecycle tests cover reload and refusal, and an isolated real Electron
  `forcefullyCrashRenderer` pass confirms Close destroys the crashed window.
  Text that had not reached its source file remains unrecoverable.
- **Remaining-area follow-up (2026-09-16):** Agent preferences and embedder
  route tests now belong to `test:config`; obsolete manual file-order storage,
  synchronous upload naming, and unwired legacy smoke scripts were removed.
  Node owns atomic MCP launcher generation at startup and readiness/Settings.
  The root linter remains required by architecture fixtures and current lint
  resolution; removing it activates a different tool version. Real providers, signed releases, and cross-platform
  update installation remain separate evidence requirements.

- No measured startup, interaction, long-task, disposal-memory, or bundle-size
  budgets. Token/source gates do not measure runtime performance.
- HTTP has no bounded reconnect ladder; recovery is polling or explicit retry.
  Settings lacks a local render boundary, so a render failure remounts the shell.
- No automated painted contrast, overlay stacking, or composed density/icon/fill
  consistency gate. The separate `pnpm test:renderer:a11y` sweep runs Story
  interactions and structural axe checks once in default/light appearance;
  it is part of `check:web`, not the focused renderer suite. Neither it nor
  token checks establishes painted behavior.
- Full journey automation and pixel baselines are absent. Electron smoke
  exercises launch/preload and selected boundaries. A future journey harness must
  use current preload/registry contracts and state its Jxx intent. J10/J08/J12
  still require the flow/client/quality evidence described above.

These are engineering or evidence limitations, not additional product features.
