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

**Desktop analytics:** `server/telemetry.ts` owns admission, identity, sessions,
opt-out and durable delivery; `server/telemetry-state.ts` validates envelopes and
maps PostHog payloads. `server/routes/telemetry.ts` restricts renderer intake to
renderer-owned activity. `server/hosted-account.ts` supplies verified sign-in,
sign-out and hosted subscription facts. File/project routes capture identity
before work; `file-save.ts` distinguishes unchanged saves. Renderer foreground
input is observed by `platform/telemetry.ts` through `app/composition/use-desktop-usage.ts`.
Document runtime changes and active reading-surface interaction report content-free
engagement; Agent usage correlates start/terminal results with a random turn ID.
Settings General discloses account linking and the shared usage/error opt-out.

`server/telemetry.test.ts` covers anonymous-to-account links, restart continuity,
logout/direct account switching, delayed outcomes, offline queue replay, stable
UUID/time/version, retryable/permanent refusals, capacity/expiry, corrupt config,
opt-out cancellation, active days without restart, session expiry and subscription
poll suppression. Its subprocess replaces outbound transport before importing the
production owner and exercises Electron's packaged test-suppression environment.
Renderer telemetry tests exercise trusted foreground input, quiet background days,
listener disposal, bounded edit reporting and refusal of host-only facts.
Document lifecycle tests distinguish editing from reconciliation/no-change callbacks;
Agent usage tests cover correlation and terminal coalescing. All collection tests
use isolated configuration and fake/local transport, never production PostHog.

Error classification remains in `server/error-diagnostics.ts`; host/renderer error
adapters feed the same collector. Tests cover bounded causes/codes, unquoted private
names, stack paths, non-JSON asset failures and HTTP response failures without
request payloads. Known gaps: real PostHog person-merge/deduplication behavior has
not been exercised with this schema, signed multi-window account changes remain a
packaged check, and bounded delivery cannot prove all real-user activity. Silent
reading is unobserved; completed turns do not establish usefulness; subscription
observations do not establish new payment revenue.

A 2026-10-09 built-source desktop pass used an isolated application/profile,
temporary project and intercepted outbound transport. Native document editing
and saving emitted foreground, engagement and changed-save events. Settings
showed the account-linking disclosure and one shared switch. After disabling it,
another edit saved successfully while capture count stayed fixed; persisted
analytics state contained only `enabled: false`. Captures contained neither the
fixture text nor its path. The complete renderer gate, host boundary suites,
types, services build and real Electron smoke passed. This local sink establishes
desktop wiring, not provider ingestion or signed-package identity merging.

**Resident update checks:** `electron/update-manager.cjs` owns startup, 15-minute
checks and a shared five-minute foreground/wake throttle. `electron/main.cjs`
binds native focus and power-resume events. Manager tests cover discovering a
release without restarting, concurrent windows, in-flight announcements, opt-out,
manual override, disposal and explicit-only downloads. Real N→N+1 package updates
remain the release checklist's platform-specific evidence.

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
  `scripts/electron/dev.test.mjs` builds real boundary sources in an isolated
  fixture and loads them in a substitute desktop child, covering missing/stale
  development output and refusing launch after a build failure. It does not
  establish native Electron or renderer behavior.
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
- **Appearance at launch (2026-09-27):** Electron main keeps the last applied
  appearance beside the workspace session, sets `nativeTheme` and the
  spellchecker before the first window opens, and hands the record to each new
  window, which applies it before its first render. The window background,
  native chrome, theme tokens, fonts, and sizes therefore match on first paint.
  `electron/window/appearance.test.cjs` covers restore, refusal, spellcheck, and
  repaint; `electron/renderer/runtime.test.cjs` covers the first-paint argument;
  `use-appearance-surface.test.ts` covers handing each applied record to the desktop.
- **Appearance customization (2026-09-27):** themes, fonts, reading layout,
  reduce motion, and editor aids. `shared/protocols/http/appearance.test.ts`
  holds every theme to WCAG AA text contrast; `server/routes/appearance.test.ts`
  covers persistence, per-field fallback, and refusal of font names that could
  escape CSS; `electron/text-services/text-services.test.cjs` covers font listing,
  capability refusal, and the spelling menu; `appearance-panel.test.tsx` and
  `writing-aids.test.ts` cover the Settings rows, font picker, word count, and
  focus-mode marking. **Gap:** font enumeration on macOS and Windows and native
  spellcheck suggestions are unproven by a driven pass on those platforms.
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
  readiness. GitHub/Gallery acquisition now uses file snapshots; the J13 archive
  tests own transport/extraction evidence. Native tests cover Welcome reuse,
  self/peer focus, occupied-window
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
- **External tree refresh (2026-10-08):**
  `renderer/src/app/composition/folder/use-folder-refresh.ts` refreshes the active
  listing and reconciles the explicit folder on window focus, even without a
  visibility or tree-version change. `use-folder-focus-refresh.test.tsx` covers
  external additions/renames/deletions, throttling, overlapping focus, sync failure,
  project switch/closure, late success/failure completion, and listener cleanup.
  Scope retirement aborts the focus request so a retired project's failure cannot
  replace the current project's notice. The regression was
  reproduced in the running macOS app: `li-kb/journal` existed on disk and in
  the host listing, but the Files tree retained its earlier three entries.
  A built macOS runtime pass opened a temporary project and kept its Markdown
  document open. After external additions and native window switching, the host
  logged reconciliation of the new source; both the accessibility tree and a
  screenshot confirmed the new directory, empty directory, and binary in Files
  with the original document still open. Rename/deletion coverage is automated;
  real-provider indexing quality and large-project reconciliation cost remain unproven.
  A 2026-10-09 integrated built-app pass repeated external directory/source and
  empty-directory additions with a Markdown document open. Hiding and returning
  to the isolated macOS window refreshed Files and retained the open document.
  The 20 focused refresh/preparation tests, all 12 renderer gates, host types,
  Electron contracts, and documentation validation passed after adding failure
  retirement on project switch and closure.
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

**Chinese IME composition (2026-10-11):** `ui/markdown/outline-adapter.ts`
renders heading anchors through ProseMirror decorations and removes Milkdown's
competing heading-id synchronizer. Direct heading DOM writes previously made
the editor reparse nearby composing text and lose Chromium's IME replacement
range. A temporary Electron probe reproduced `c初始` after composing `初始` in
a paragraph between headings; disabling those writes removed the residue.
`document-input.test.tsx` checks unique outline-compatible Chinese anchors and
that rendering them publishes no document edit. The built Markdown surface was
driven in Electron with native Chromium composition updates from `c` through
`chu'shi`, followed by committing `初始`, in both a paragraph and a heading.
Rendered text and the live Markdown buffer contained only the committed word;
one Undo removed it, and updated heading anchors matched the outline's slugs.
The rendered surface was reviewed by eye. This isolated source-runtime probe
does not establish Sogou-specific candidate-window behavior, disk saves, or
packaged delivery.

**Currency and math (2026-10-08):** `ui/markdown/math.ts` replaces Crepe's
single-dollar math interpretation. `math.test.ts` runs the real Milkdown editor
and verifies price rendering/save preservation, inline double-dollar math, and
block/fence round trips. An isolated built macOS source app opened a fixture
with multiple dollar amounts, an inline formula, and a block formula. After a
normal text edit, the saved file retained every price and both double-dollar
forms; the rendered editor and formula preview were reviewed by eye. This is
source-runtime evidence, not packaged delivery.

**Intent:** [J03](../design-docs/journeys/README.md#j03-read-and-edit-source-documents).
The [Documents design](../design-docs/journeys/documents.md) owns navigation, continuity,
and recovery behavior; the evidence below establishes its exercised paths.

**Implementation:** Renderer: `renderer/src/features/documents/ui/source/registry.tsx`, `renderer/src/features/documents/application/document-runtime.ts`, `renderer/src/features/documents/ui/markdown/document.tsx`.
The Markdown reading bar composes the Settings-owned
`renderer/src/features/settings/ui/appearance/reading-text-menu.tsx`; durable
font and size presets cross `shared/protocols/http/appearance.ts` to
`server/app-config.ts` and are stamped on the document root by
`renderer/src/shared/runtime/appearance-surface.ts`.
Inline review: `renderer/src/features/documents/domain/revision.ts`,
`renderer/src/features/documents/ui/markdown/use-revision-review.tsx`,
`renderer/src/features/documents/ui/markdown/revision-adapter.ts` over a patched
`@milkdown/plugin-diff` (`patches/`).
Turn review: `renderer/src/features/documents/application/open-revision.ts`
(`openTurnChangeReview`), `infrastructure/turn-change-api.ts`, and the reversed
labels and colours in `ui/markdown/revision-adapter.ts`, `review-bar.tsx` and
`document.css`; host `server/turn-changes.ts` and `server/routes/turn-changes.ts`.
Ask Agent on a selection: `renderer/src/features/documents/ui/markdown/selection-markdown.ts`
and `selection-toolbar.ts`, bound in `renderer/src/app/shell.tsx`, which saves the
documents, shows the chat pane, and hands the passage to the Agent workspace.
The same `selection-toolbar.ts` owns the leading Text/Heading 1–3 block menu;
Milkdown's block command remains the document mutation owner.
A save refused against a version a deleted file no longer has, whose reload confirms
the source is gone, enters the document's `detached` state and stops autosave.
`application/draft-settlement.ts` turns a close or a release of such a tab into the
question rendered by `ui/workspace/discard-draft-dialog.tsx`, and `document-runtime.ts`
owns the explicit restore, which re-attempts the ordinary save before creating the file
so a source that came back is compared instead of overwritten.
Host/services: `server/file-save.ts`, `server/text-file-transaction.ts`,
`server/turn-changes.ts`, `server/routes/turn-changes.ts`.

**Status:** Release-dependent.

- **Contract Test:** `pnpm test:renderer`, `pnpm test:project-files`,
  `pnpm test:electron`, and `pnpm test:electron:smoke` cover format capabilities, source identity,
  hidden-file policy, tab/history behavior, save barriers, shared version
  authority, conflicts, and failure handling.
  `server/__tests__/file-listing.test.ts` exercises root and nested project
  configuration/skills with hidden-file visibility both off and on, sync/async
  listing parity, protected/derived exclusions, and unchanged index eligibility.
  `server/routes/files.test.ts` verifies preference changes through folder-explicit
  workspace requests, including project isolation and refusal of unregistered roots.
  `pnpm test:config` covers strict durable preferences.
  `reading-text-menu.test.tsx`, the Appearance domain/infrastructure/surface
  suites, `shared/protocols/http/appearance.test.ts`, and
  `server/routes/appearance.test.ts` cover the reading menu's font/size writes,
  immediate surface application, rollback, strict wire values, and preservation
  of unrelated preferences.
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
  paragraph out of the diff.
  `selection-toolbar.test.ts` runs the Heading menu against a real Milkdown
  editor, covering toolbar order, the checked block kind, paragraph/heading
  conversion, menu dismissal, and Ask Agent as the last item.
- **Project configuration visibility runtime pass (2026-09-30):** the built
  macOS source app used isolated configuration and a supplied folder-picker result.
  All five recognized configuration directories appeared with hidden files off.
  Toggling off → on → off showed and hid an unrecognized dot-directory, retained
  the configuration directories, kept caches unexpandable, and hid VCS/product state.
  Files opened a writing skill under the fixture's `.agents` directory; Quick Open
  found and opened a `.claude` skill. The expanded tree and document were reviewed by eye.
  A release-candidate rerun on 2026-10-04 after integrating current main confirmed
  all five default-visible directories and opened the `.agents` writing skill
  through the built desktop tree; its rendered document was reviewed by eye.
  Telemetry was unavailable in the isolated test configuration.
  These passes did not exercise a native picker or a packaged, signed application.
- **Reading typography runtime pass (2026-09-26):** the built macOS source app,
  with isolated configuration and telemetry disabled, opened this repository's
  README in Documents. The document reading menu changed Serif to Sans and the
  default size to Large without closing; the document root reported both new
  values, the computed prose face changed to Inter, and the isolated durable
  configuration retained `readingFont: sans` and `readingTextSize: large`.
  A full-window screenshot was reviewed by eye for the reading bar, open menu,
  selected presets, and enlarged document composition. This pass did not use a
  packaged, signed application or exercise a failed preference write.
- **Heading menu runtime pass (2026-09-26):** the built macOS source app, with
  isolated configuration and telemetry disabled, opened a fixture Markdown file
  in the normal Documents and Chat split. Selecting its blocks and choosing
  Heading 2 converted them to H2, and reopening the menu marked Heading 2 as the
  current choice. A later pass the same day, after Humanize was removed,
  selected prose in the same split: the toolbar read Heading, the formatting
  marks, then Ask Agent on one 401px line, and its open menu checked Text.
  With the document pane forced to 420, 360 and 320px, it stayed on one line
  at 420px and below that kept the formatting groups whole on the first row
  with Ask Agent on a second, never clipped by the pane. Clipped screenshots in light and dark were reviewed
  by eye. These passes did not use a packaged, signed application or exercise
  undo and save-conflict recovery.
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
- **Turn-only review (2026-10-08):** the proposal tool, transient store,
  consumptive delivery routes/poll, and Accept/Reject chat controls are retired.
  The document retains the shared diff engine with fixed Undo/Keep controls,
  version/frontmatter refusal, and byte-preserving Keep. `open-revision.test.ts`,
  `document-revision.test.tsx`, and `use-turn-review.test.tsx` exercise the retained
  entry and failure paths. Earlier proposal-only runtime passes no longer
  establish the current entry. Current runtime evidence belongs with J07.
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
- **Focus-scoped current line (2026-10-01):** the code editor (plain text and JSON)
  and Markdown code blocks paint the current line only while their editor has
  focus, so a document the caret has left no longer shows a second marked line.
  A temporary harness in Electron's Chromium mounted both editors with the
  shipped theme and stylesheet and read the computed background: before the
  change it stayed painted after focus moved away; after it, focused lines keep
  the hover color and unfocused lines are transparent. happy-dom does not apply
  CodeMirror's focus class or theme, so no unit test owns this.
  A built-app Electron pass (2026-10-02) opened plain-text, JSON, and Markdown
  files in an isolated project/profile. Real mouse input focused and blurred
  the source editors via the file tree, then moved from a Markdown code block
  to prose and between two code blocks. Computed line and gutter backgrounds
  were the hover color only in the focused editor and transparent otherwise;
  refocusing restored the highlight. The light composition was inspected by eye.
- **Known issues — source/viewers:** Markdown relative images lack folder-scoped resolution/upload/lightbox; heading
  ids are assigned by order without identity cross-check. PDF placeholder/observer
  counts are unbounded.
  Markdown retention remains a format-name exception outside the registry.
- **Known issues — work continuity:** sandboxed HTML owns its internal scroll
  position; host reading-position capture does not cross that boundary. Native
  close tracks document
  load rather than separate save-handler readiness, with failure/timeout keeping
  the window open. Recovery is a React remount, not a native reload protocol.
- **Keyboard sidebar resizing (2026-10-01):** the sidebar's edge rail is a
  focusable separator reporting its width and bounds; arrow keys step it 16 px,
  the same step as the Agent pane seam, within 272–360 px, and never collapse it.
  The rail now renders inside the sidebar's landmark, measured at the same
  position in the sidebar, floating, and inset variants.
  `sidebar.test.tsx` covers the bounds, clamping, the reported width, the
  width-change callback, and shrinking from the provider's 288 px default.
  A harness in Electron's Chromium with the shipped stylesheet
  pressed real Tab and arrow keys: focus reached the rail, the panel and saved
  width moved 300 → 332 → 272, the edge hairline took the focus colour, and the
  rail's tooltip stood beside it and closed when focus left.
  A built-app Electron pass (2026-10-02) opened an empty project with an
  isolated profile, reached the rail with real Tab input, resized from 288 px
  with arrow keys, held both bounds without collapsing, and verified a 328 px
  rendered width, native session-file persistence, and restoration after reload.
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

- **Low-credit calls (2026-10-11):** the hosted API's account-locked reservation
  reduces output to fit account/monthly and turn capacity while retaining input
  cost. API ledger tests cover positive remaining balance, concurrent last-credit
  reservations, release, and turn limits; gateway tests verify the provider gets
  the approved ceiling. `server/__tests__/hosted-agent-broker.test.ts` covers
  accurate insufficient-credit/turn wording through the OpenCode translator and
  retained recovery kinds. These fixtures do not establish real-provider response
  quality or complete Agent tasks with very small output budgets.

**Default empty completion (2026-10-11):** the reported local transcript records
successful reads followed by an assistant message with zero output tokens,
no text/tools, and `finish: unknown`; the adapter previously reported success.
A sanitized panel replay failed before the fix. `hosted-agent-broker.ts` now
retries only an empty model call once, preserving tool results and turn identity;
it never replays output or executed tools. `opencode-agent.ts` fails unknown
completion and retains error/turn attribution through native cleanup. The pinned
OpenCode smoke drives a real MCP write, an empty continuation, and successful
recovery with exactly one write; two empty attempts produce a visible failure,
and the same session accepts another turn. Broker tests cover fragmented SSE,
streaming output, bounded buffering, cancellation, and accounting identity.
The built desktop renderer and host were driven in Electron with an isolated
project/account fixture and controlled model transport: one real MCP write,
empty continuation, recovered reply, and changed-file card; a subsequent pair
of empty responses showed the incomplete-turn explanation and retained the file.
Both settled surfaces were reviewed by eye with telemetry unavailable.
This establishes local recovery and native protocol behavior. The original raw
upstream response was not retained, so the provider-side cause of the empty
generation remains unproven; no live-provider or packaged desktop pass is claimed.

**First-send setup diagnostics (2026-10-09):** the access prompt previously
replaced a known bootstrap failure with a generic connection sentence.
`infrastructure/catalog-api.ts` now retains its stage and explanation;
`application/connect-agent.ts` carries them in `AgentSetupRefused`, and
`application/failure-messages.ts` presents the failed step and diagnostic in
`ui/access-dialog.tsx`. Transport causes and unexpected Error messages likewise
remain visible as plain text. The dialog wraps details, expands for failure,
and bounds its height without truncating the message. A mounted regression
first failed on the generic sentence, then passed with the download reason,
retained draft, and successful retry; the wire adapter covers MCP details and
the `SetupFailure` Story covers multiline composition/accessibility. A built
macOS Electron pass used an isolated home, empty project, and controlled Codex
executable: its login failure displayed the step, auth host, and ECONNREFUSED
in the same prompt; Not now preserved the draft. This proves error propagation
and UI recovery, not the original reporter's underlying Codex failure.

**Default permissions and desktop commands (2026-10-08):** Default now declares
Ask/Edit/Plan and maps each turn to an OpenCode profile. Edit uses the shared
realpath-aware project-write predicate; commands, deletion, and broader access
still need approval. Plan denies mutating and delegated tools. Auto remains
unavailable because OpenCode has no native risk reviewer. MCP approvals wait
for the same call's running arguments, which the real runtime can emit after
its permission request. Grants apply once to a pending id; Stop rejects late
grants. A reproduced duplicate idle event could finish the next optimistic
turn before native work began; the translator now requires native busy before
ordinary completion, while acknowledged interruption settles a pre-busy turn.
The bundled runtime restores common CLI directories through `agentCliPath`
without inheriting credentials or injection flags. The desktop-PATH regression
failed with `zsh:1: command not found: node`, then passed with the fix.
`opencode-agent.test.ts` covers mode changes, scoped/symlink writes, delayed
arguments, duplicate approvals/idle, and interruption. The driven native smoke
uses the pinned executable, a fake model gateway, and an isolated MCP writer:
approved Node exits zero under a desktop PATH; Edit writes automatically, Plan
rejects MCP and shell writes, and Ask confirms writes after switching back.
Its fixture shares one native-realpath temporary directory between the SDK and
Chat binding, asserts the SDK's returned scope, and uses file URLs for generated
ESM imports on Windows.
This establishes adapter/native protocol behavior, not live-model judgment,
the owner's X script, or a released desktop build.

**Explicit external reads (2026-10-07):** `agent-runtime-instructions.ts` now
makes the bound project the default read/search scope and routes explicitly
requested external paths through native tools under runtime permissions.
`opencode-runtime.ts` asks for external-directory access; `agent.ts` no longer
redirects an external prepared PDF/DOCX to project-scoped MCP. The Claude adapter
regression failed with the previous policy and external-PDF redirect, then passed
with the fix. A driven bundled OpenCode read exposed an ignored
`permission.asked` event; the adapter now translates it into the shared approval
flow. The native smoke reads an external fixture through the real runtime,
receives the translated approval, grants it once, and verifies the file content
reaches the fake model gateway. Host/renderer types, Agent and installed native
protocol tests, service/renderer builds, Electron tests and built desktop smoke
passed. These checks do not establish
live-provider compliance with the prompt or a packaged desktop approval flow.

**Valid-stream interruption (2026-10-06):** a live desktop WebSocket capture
recorded the renderer sending `close` immediately after an ordinary text delta
at 00:41:40 local time, while the host subsequently delivered the remaining
text and a successful `turn-end`. Every received frame passed the shared schema.
`infrastructure/session-api.ts` had included event consumers in its invalid-frame
catch, relabeling their exceptions and closing the native session. It now delivers
validated events outside that catch. The adapter regression verifies that a
consumer exception preserves its original error, does not enter invalid-response
recovery, and does not prevent the next terminal event from being delivered.
The exposed consumer exception was React's maximum update-depth guard during
text delivery. An isolated browser App reproduced it when the captured turns
arrived over a real WebSocket; timer-based delivery did not. React instrumentation
located the pending updates in `ChatHistoryPopover`: `useConversationHistory`
flattened the unstable `useQueries` result array on every render, repeatedly
resetting the list cursor during streaming. Query-level combination now preserves
unchanged history data. The keyboard regression fails before this change because
ArrowDown selects the first chat again, and passes afterward. Both captured turns
then completed over the same real WebSocket without a consumer exception. This
fixture uses local captured messages and fake non-Agent ports; packaged behavior
and unrelated network interruptions remain unverified.
All renderer checks passed across the gate and reruns, including 1,638 tests
with coverage and 146 Story accessibility cases, plus documentation and built
Electron smoke. The isolated worktree needed an explicit allowlist for linked
dependencies; two test workers resolved three timeout-only failures. The fix was
then copied unchanged into the primary checkout, where both new regression
suites also passed.

**Interrupted-turn cause (2026-10-05):** `ui/work-status.tsx` now exposes the
closed/failed connection's reported cause beside Outcome unknown; the separate
connection notice had been suppressed in this state, hiding useful runtime
errors. The mounted workspace regression covers a native exit during a turn,
retained partial output and draft, one reconnect action, continued uncertainty
after reconnection, and no automatic prompt replay. `InterruptedTurn` provides
the composition fixture. The reported live chat preserved its complete reply in
Claude history while the renderer stopped displaying it partway through; the
host stayed up across that interruption. Neither the hotel network nor a specific
native/transport failure has been established as the cause of that incident.
Validation passed all 12 renderer gates, documentation checks, and the built
Electron smoke. The built Storybook fixture was inspected in Chrome with its
specific cause and single recovery action visible. This verifies presentation
with controlled events, not the cause or repair of the reported interruption.

**Claude background completion (2026-10-05):** `server/agent.ts` requests native
session-state events and waits for `idle` before publishing `turn-end`, retaining
the latest result for the outcome. A live Claude 2.1.280 SDK probe reproduced a
successful waiting reply before a background Agent finished, followed by another
result after its continuation. With state events enabled, `idle` followed that
continuation; interrupting during the wait stopped the child and emitted `idle`
without another result. Adapter regressions cover the waiting interval, child
completion before the parent reply, queue admission, duplicate idle, a failed
continuation, and cancellation racing acknowledgement. Result-only native CLIs
retain their existing terminal behavior. Validation passed 226 Agent tests,
host types, Electron boundary tests and built smoke, and documentation checks.
The live probe exercised the SDK protocol, not the application UI; the changed
journey through the built desktop and packaged behavior remain unverified.

**Default Agent billing:** Settings -> Agents shows the subscription, reached also
from the sidebar account menu, through
`settings/hooks/use-billing.ts` and `settings/ui/agents/subscription-rows.tsx`.
`server/hosted-account.ts` calls the hosted billing plans, status, Checkout, and
Portal endpoints with the desktop session and admits only Stripe-hosted pages;
`server/routes/account.ts` exposes them to the renderer. The hosted API owns
Checkout, subscription state, and paid allowance ceilings; the website remains a
separate purchase path. A host test covers the bearer token, one refresh after
401, and refusal of a non-Stripe or non-HTTPS page. Panel tests cover Checkout
for a chosen plan, waiting until the status read confirms paid rights, the
following allowance refresh, Portal for a subscriber, and a refused Checkout that
keeps the plans and reads rights again. Hook regressions cover returning after a
long Checkout and a refused browser launch; panel coverage keeps management
reachable during confirmation and retries a failed handoff. Host tests cover a
stalled billing request and recovery; native tests cover browser launch timeout
and strict billing-return classification. A driven built Storybook pass on
2026-10-11 checked the canceled-renewal label and management feedback at the
28rem settings width. The built pricing return was checked without a browser
session or billing API, retaining the app-return link. The website return button needs no
browser login. Live discounted Checkout and cancellation with the patched desktop
and deployed services remain unverified. A macOS v2.15.7 release-package pass on
2026-10-11 opened Plans and billing, launched live Checkout, and returned the
management button from its opening state to a usable retry state. The free
account's live Portal rendered after a browser reload; first-load reliability
was not established. Automated custom-scheme navigation was blocked by the
browser tool, so this pass does not establish the native return handoff.
A sidebar test opens it from the account
menu's Plans and billing. The one-time sign-in banner is
`settings/hooks/use-account-offers.ts`, appended to the notice strip by
`app/composition/layout/workspace-notice-strip.tsx`; the host stores answered
offers in `server/app-config.ts`. A host test covers sign-in answering it,
sign-out keeping it answered, and the Developer tools reset; an App test covers
Not now. A macOS source-runtime pass on 2026-10-05 used the built renderer and
an isolated empty configuration: the banner appeared without a project, Not now
removed it, and it stayed dismissed after a clean quit and relaunch. The signed-out
Agents panel remained usable. The built subscription and turn-change Stories were
also visually inspected. The subscription fixture entered its slow-confirmation
state after the two-minute wait, kept Subscribe hidden, resumed waiting with
Refresh, and restored the plans with Stop waiting. A website test covers the
app-return hint without a browser session. Real Checkout from the packaged app
and promotion entry at Checkout from that path remain unverified. Hosted API integration tests cover
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
A repeat browser-driven sandbox pass on 2026-10-11 used the current signed-in
account, `STASHBASE50`, and Stripe's test Visa. Checkout charged a $5 test invoice
after a $5 discount and automatically returned to the local pricing page showing
Plus through 2026-11-11. Stripe and the local projection agreed; all three payment
events were processed within two seconds of receipt, with none pending, and the
full $1 fixture allowance was retained. The Mac locked before the subsequent
Portal/cancellation UI check, leaving that repeat check unverified. This local
stack does not change the account's production subscription.
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
The 2026-09-28 merge onto current main passed the complete renderer gate
(the architecture check was rerun after repairing the isolated Electron install),
host types, 61 configuration/account tests, Electron tests and built-output smoke,
and documentation validation. A browser pass through the merged built Settings
Story confirmed the signed-in subscription entry, credit balance, and existing
Agent controls. This uses controlled account ports, not live desktop login.
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

**Runtime update (2026-10-09):** `server/agent-turn-failure.ts` classifies a
runtime too old for its model as `runtime-outdated` (observed live: Claude
2.1.220 refusing Fable 5.1 with a 400 naming 2.1.251 as required).
`server/agent-runtime-installer.ts` runs the provider's official native installer
for both installation and Update through one cancellable bootstrap coordinator,
then verifies the native launcher, confirms discovery selects it, and reconnects
MCP. An npm installation switches to native without an extra choice or removing
the old npm copy. `server/agent-cli.ts` prioritizes native launchers over npm
copies, rejects npm shims as native installation output, and preserves explicit
executable overrides. Overrides outside the native layout disable in-app updates.
The listing carries the installed version and whether an in-app update exists. The failed turn offers
Update Claude through `hooks/use-agent-runtime-update.ts`, which waits for the
runtime to be ready, reconnects the conversation so the service spawns the
updated executable, and resends the refused request; Settings → Agents shows
the version and the same Update. Focused tests cover native selection, npm-copy
preservation, installation/update verification, failure retry (including partial
first installs), the classifier, the version cache,
descriptor and schema fields, the hook's reconnect-and-resend and refused-update
paths, the transcript's action swap, and the Settings action. Failed updates carry
`retryAction: update` through the wire adapter to the mounted Settings panel;
Retry runs the installer again rather than reconnecting the old executable.
Codex uses the same installer-based update; its catalog comes from the installed
app-server. An old catalog can hide newer models, but the native
configuration can still name one and fail at inference (see the Codex recovery
entry below). A Codex model
chosen while its catalog is still being read is now held for that read instead
of being refused as unavailable.

A macOS arm64 Electron pass used the built renderer, preload, and server with an
isolated home and controlled installer scripts served for the official URLs.
Settings → Agents updated an existing npm Claude fixture; an injected download
failure showed Retry, which downloaded again and selected the native fixture.
Codex Update likewise selected its native fixture. Both rows refreshed their
versions and readiness, with no migration choice. Command logs showed native
verification/authentication, no npm updater call, and unchanged npm executables.

This proves the application flow with controlled downloads, not provider
distribution behavior. Not proven: a real update through the packaged app, or
the native update journey on Windows and Linux.

**Onboarding recovery (2026-10-09):** Both native providers now gate readiness on
their asynchronous status commands and expose provider browser login. A turn's
authentication refusal restores the sign-in action without clearing credentials.
The setup coordinator rejects conflicting explicit operations with HTTP 409;
identical operations share progress. Installation/download deadlines retire the
owned process tree before Retry can start another attempt. Version discovery and
post-install verification no longer block the shared server. MCP configuration
uses the provider's effective custom home through `server/agent-config-paths.ts`.
Bounded setup diagnostics retain installer stdout/stderr and nested fetch causes;
Settings and chat Update preserve HTTP errors. Every chat update entry respects
the runtime's update capability, including failed turns and proactive offers.

Focused host regressions exercise fresh Claude sign-in with a CLI fixture,
conflicting login/Update, actual installer timeout and process retirement before
retry, concurrent asynchronous version reads, custom-home config preservation,
and stdout/network diagnostic propagation. Renderer regressions exercise Claude
bootstrap-to-login, HTTP diagnostics through the real adapters/presenters, and
unsupported update offers in a mounted workspace. These fixtures establish
StashBase's decisions and recovery, not real-provider browser authentication or
Windows package-manager migration and executable-lock behavior.

A driven built-Electron pass used an isolated home, custom provider config
directories, and controlled CLI/official-URL installer fixtures. First-send
Claude sign-in failure displayed its ECONNREFUSED cause in the access prompt;
Not now preserved the draft. Settings sign-in retry reached Ready. A Claude
Update script failed with stdout-only EACCES and exit 13; both were visible on
the row, and Retry selected native 2.1.300 from npm 2.1.81. Codex Update selected
native 0.162.0 from npm 0.153.4. Both final versions and Ready states were seen
in Settings. Fixture logs confirmed native verification/authentication, intact
npm copies, no updater subcommands, and MCP writes only in the custom provider
config files. No real provider credentials or browser authorization were used.

**Codex model compatibility recovery (2026-10-04):** an older runtime using
`gpt-6.1-sol` from native configuration reported missing model metadata and then
a ChatGPT model rejection. The prior classifier emitted a plain turn error, so
the chat offered only Retry. `server/codex-session-runtime.ts` now associates
those two native messages by model within the app-server generation and sends
the existing `runtime-outdated` recovery kind. This exposes Update Codex through
the existing updater/reconnect/resend flow without rewriting the user's model.
Adapter regressions replay the reported warning and JSON error through terminal
notifications, failed completion, and RPC rejection; warnings alone, another
model's warning, service-tier warnings, and unrelated errors do not trigger it.
The native error is retained, warnings remain advisory, and a failed turn settles
once. The signal offers an update attempt, not a claimed minimum version or
guaranteed account access. Not proven: a real Codex update and successful provider
turn through the packaged application for this failure.

**Model-picker update entry (2026-10-04):** `ui/composer/thinking.tsx` also
offers the native updater in the model list before a turn fails, using the
host's `updatable` capability and `use-agent-runtime-update.ts`. The mounted
workspace regression starts with only an older model, invokes Update Codex,
then verifies reconnection publishes the replacement catalog and keeps the
unsent draft without sending a prompt. A refused update preserves the draft
and connection and reports its failure in the picker. The `ModelPicker` Story
covers the entry's composition and accessibility. These use controlled ports;
they do not establish which models a real updated Codex account can access.
The built Storybook model picker was inspected in Chrome: the update action
appears below the model choices. This is a
source UI check with controlled ports, not an installed Codex update.

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

**General file attachments (2026-09-23):** attachment-capable runtimes accept
ordinary local files from the picker, drop, and clipboard instead of limiting the
composer to images and PDFs. Focused renderer tests cover an arbitrary MIME type,
an image preview, and a text-file card; history tests keep unknown-extension files
inside transient attachment storage as name-only cards while leaving arbitrary
external paths in the transcript. Runtime interpretation of binary formats remains
provider-dependent and is not established by local upload acceptance.
Validation: `pnpm check:web` passed all 12 renderer gates; `pnpm test:agent`
passed 204 tests; the attachment route test, host typecheck, and documentation
checks passed.

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
  persona, and transcript/layout state. Automatic grep/hybrid selection
  follows current key configuration; explicit/provider failures do not silently
  change strategy. Choosing a persona resumes that Chat's own conversation so
  it applies from the next turn, and a new Chat starts with the project's last
  choice (`session-runtime.test.ts`, `project-agents.test.ts`,
  `use-agent-persona.test.ts`); the library, seeding, per-session record, and
  socket seam are `server/agent-persona.test.ts`; replay joins the record
  (`agent-history-routes.test.ts`); Claude and Codex compose the Chat's
  persona before the routing policy.
  An isolated built-app pass (2026-10-08, scratch HOME, no runtime signed in)
  chose and switched personas in the composer, wrote a new one (it runs at
  once), opened Browse personas…, read a Markdown sample, added
  Essayist (the page then reads Added and the picker lists it), and deleted the
  running persona (the Chat falls back to None and the project's choice to
  null); the library held the four seeded files plus the added copy. No live
  turn ran, so the socket seam and replay restore are test evidence only, and
  two concurrently started Chats keeping separate personas is
  `project-agents.test.ts` only.
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

**Document context (2026-09-25):** a passage is a context kind in
`renderer/src/features/agent/domain/context.ts`, rendered into the prompt as a
`Selected passages:` block by `domain/prompt-context.ts` and validated only
against scope, listing, and its 6,000-character limit. `application/ask-about.ts`
binds it to the chat in the passage's folder and leaves a composer focus request that survives the pane
mounting. `server/agent-history-attachments.ts` lifts the block back out of
Claude, Codex, and Default (OpenCode) history, and `infrastructure/session-api.ts` turns a replayed
quote under the chat's folder into the same passage chip. The composer's
suggestion of the document in front comes from `activeSource`, which
`use-agent-environment.ts` publishes only in Documents; `domain/draft-context.ts`
decides what is offered and `use-suggested-source.ts` holds the dismissal.
`context.test.ts`, `session-runtime.context.test.ts`, `ask-about.test.ts`,
`session-api.test.ts`, `codex-history.test.ts`, `context-composer.test.tsx`,
`selection-markdown.test.ts`, and `use-agent-environment.test.tsx` own these rules.
A driven built-app pass (2026-09-25, Linux, isolated home, folder dialog stubbed
in the main process) opened a Markdown file beside the Agent pane: the pane
offered it as a dashed suggestion; a selection showed Ask Agent on the
toolbar; Ask Agent bound "tide rises twice" as a passage chip and moved the
caret into the composer; clicking the suggestion turned it into an inline
mention and removed it. The formatting toolbar stays drawn after Ask Agent
moves focus, until the next selection change. Not proven at runtime: a real
turn receiving the passage, and a reloaded chat restoring its chip.
A real Default turn (2026-09-25) received the passage and replied with a
`#:~:text=` citation, but showed the reader's own prompt, context block
included, again as Agent text: OpenCode streams the prompt's text part like a
reply's, and `OpenCodeEventTranslator` forwarded every text part. It now drops
parts of messages OpenCode announced as the user's; `opencode-agent.test.ts`
owns that rule and the history restore.

## J07: Converge

**Intent:** [J07](../design-docs/journeys/README.md#j07-converge-chat-into-a-document).

**Implementation:** Renderer: `renderer/src/features/agent/application/session-runtime.ts`, `renderer/src/features/documents/application/document-runtime.ts`, `renderer/src/app/composition/layout/workspace-panes.tsx`.
Host/services: `server/project-file-mutations.ts`, `server/text-file-transaction.ts`,
`server/project-operations/index.ts`,
`server/turn-changes.ts` (turn baselines at the `attachAgentRuntime` seam), and
`renderer/src/features/agent/ui/transcript/turn-changes-card.tsx`.

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
- **File tool routing (2026-10-08):** shared runtime instructions require
  `edit_file` for existing documents and `write_file` for new ones; `suggest_edits`
  and its approval exceptions are removed from HTTP/MCP and all built-in runtimes.
  Claude retains `alwaysLoad` for StashBase MCP and removes native edit/write
  tools; OpenQuill denies native edits. Codex tool routing remains an instruction,
  not a verified native-tool gate. Shell/subagent writes remain detectable by
  the common turn scan. `project-file-mutations.test.ts` covers edits of empty
  files, nonempty-match rejection and stale versions through real MCP.
- **Driven runtime pass (2026-10-08):** the production renderer in a source
  Electron launch, with a disposable project and a project-local MCP port
  override, completed a real Claude turn through two `edit_file` calls. The
  Chat's Changed in this turn card opened two inline Undo/Keep changes. Undoing
  one and keeping the other saved the expected mixed result; reviewing the
  same turn again refused the now-stale source. This establishes the removed
  proposal path is unnecessary for the Claude flow. It does not establish
  packaged or other-runtime behavior.
- **Turn review (2026-10-04):** every turn on a folder-bound Agent socket is
  bracketed by a Markdown baseline taken before the prompt reaches the runtime
  and a rescan at `turn-end`; the Chat card offers Review per edited file, which
  opens a reversed inline review (Undo/Keep). The runtime policy has Agents
  write directly through the StashBase file tools.
  `server/turn-changes.test.ts` covers created/edited/deleted detection for
  untooled writes, hidden-note and size exclusion, retention, prompt hold and
  ordering, capture failure, and a refused prompt's baseline;
  `server/routes/turn-changes.test.ts` covers scope, expiry and repeatable reads;
  `open-revision.test.ts`, `turn-change-api.test.ts`, `document-revision.test.tsx`,
  `turn-changes-card.test.tsx`, `session.test.ts` and `events.test.ts` cover the
  renderer path. A driven dev-build pass with a real Claude turn showed the card,
  the reversed review with Undo/Keep labels and swapped colours, a per-change
  Undo saving, Keep all, a stale refusal on a second Review, and Keep all. Not proven: Codex and the
  Default runtime driven at runtime (they share the socket seam but were not
  run), a packaged build, and large-vault scan cost per prompt.
- **Citations (2026-09-25):** `renderer/src/features/agent/domain/citation.ts`
  reads a `#:~:text=` phrase from a reply's local link; the transcript hands it
  to `locatePassage` in `use-document-sources.ts`, which opens the file with a
  passage-purpose Find target whose notices `navigation-runtime.ts` words for a
  passage. `server/agent-runtime-instructions.ts` asks every runtime to cite
  that way. `citation.test.ts`, `markdown.test.tsx`, `navigation-runtime.test.ts`,
  and `agent-convergence.test.tsx` (a cited link selects Documents and Find lands
  on the phrase) cover it. Not proven: that a real runtime cites as instructed,
  and a phrase spanning a line break in the rendered text is not found.
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

**Retired interface (2026-10-08):** `suggest_edits` and its HTTP delivery routes
are removed. External clients use the existing write/edit tools; unsupported old
calls fail without writing. Post-write Chat review requires a StashBase-owned
Agent turn and is not promised for standalone external MCP clients.

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
Host/services: follow J02/J03/J05/J06/J07 owners for the exercised path. StashBase ships no workflow prompt; the user's `AGENTS.md` / `CLAUDE.md` owns it.

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
  These verify writing and revision, including saved changes reviewed inline.

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
Host/services: `server/project-file-mutations.ts`, `server/sync.ts`. No packaged
prompt states wiki conventions (a `wiki/` folder, following an existing wiki's
structure); they come from the request or the user's
`AGENTS.md` / `CLAUDE.md`.

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
Personas: `renderer/src/features/gallery/ui/persona-page.tsx`, `renderer/src/features/gallery/domain/persona-snapshot.ts`, `renderer/src/app/shell.tsx` (add through `useAgentPersonaLibrary`).
Host/services: `server/routes/gallery.ts`, `server/github-import.ts`, `server/github-snapshot.ts`, `electron/multi-window.cjs`, `server/agent-persona.ts`.

**Status:** Partial.

- **Contract Test:** `pnpm test:protocols`, `pnpm test:renderer`, and
  `pnpm test:project-files` cover bounded whole-index
  parsing/fallback, image-host and redirect restrictions, cached browsing, copy
  serialization, and shared GitHub acquisition/publication rollback.
  `github-snapshot.test.ts` covers anonymous default-branch archive redirects,
  bounded streaming/extraction, path and symlink confinement, malformed archives,
  cancellation and idle timeout. `__tests__/github-import.test.ts` exercises real
  archive extraction with controlled HTTP bytes, Git unavailable, and publication,
  registration and shutdown recovery. The Electron
  smoke also loads the built Gallery UI through `app://renderer`, decodes cover,
  and detail cover images using controlled
  proxy bytes with production CSP and native request authorization. See
  [Gallery boundary](architecture.md#gallery). Persona parsing (optional array,
  refused ids, unknown icons) is `gallery.test.ts`; the bundled persona
  fallback is `use-gallery.test.tsx`; a Gallery add landing in the picker's
  cache is `use-agent-persona.test.ts`; the two entrances never showing each
  other's shelf is `gallery-refresh.test.tsx`.
- **Snapshot runtime pass (2026-10-09):** an isolated macOS Electron app with
  the built renderer, native boundary and built Node service imported real
  `octocat/Hello-World` through GitHub Import and Gallery Copy with no executables
  on the service's PATH. GitHub Import reused Welcome; Gallery opened a second
  project window while the source kept its project. Both copies contained the
  same README and no `.git`; the copied README opened with its real content.
  Repeating Gallery Copy showed the destination conflict without changing files.
  Gallery index metadata was controlled; archive downloads used real GitHub.
  Telemetry was unavailable in the isolated profile. This is source-runtime
  evidence, not a packaged Windows/Linux or update-path result.
- **Driven Runtime Pass:** clean-profile bundled browsing and detail
  inspection without account/runtime. A separate isolated built-app pass
  (2026-09-14) copies real `octocat/Hello-World` via a controlled Gallery index,
  registers it, opens a second bound window, and preserves the shop's null binding.
  An isolated built-app pass on 2026-10-08 opened Browse personas from the
  composer, read Essayist's sample and prompt, added its library copy, and
  returned to the unchanged Builder selection. The sidebar Gallery showed
  projects only; X Content Starter's detail showed one cover and its About
  introduction with no prompt or thumbnail strip. Both surfaces were inspected
  through the native UI, and project-detail composition was reviewed by eye.
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
