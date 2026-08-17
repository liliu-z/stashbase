# Bug Reporting

> Review contract for local report collection, sender-bound review authority,
> immutable approval, artifact preparation, explicit handoff, and cleanup.
> Product behavior lives in
> [design-docs/design/bug-reporting.md](../design-docs/design/bug-reporting.md).

## Scope and Owners

- The Electron main process owns report drafts, private collected resources,
  approval snapshots, prepared artifacts, destinations, and cleanup.
- The bug-report Module owns the lifecycle behind a sender-bound Interface.
  Opaque draft and artifact references identify resources but never authorize
  access.
- The dedicated review window, its narrow preload, and its IPC handlers are
  Adapters. The workspace sidebar and native Help menu are entry Adapters. The
  sidebar entry is a secondary utility and may be replaced by an available
  update action; native **Help → Report a Bug…** remains the durable entry.
- The handoff Module accepts only a claimed approved snapshot. It does not
  accept renderer-provided paths, artifact lists, or report objects.

## State and Authority

```text
COLLECTING → REVIEWABLE → REVIEWING
                            ↓ explicit approval + final privacy scan
                         APPROVED SNAPSHOT
                            ↓ main-owned claim and preparation
                         LOCAL HANDOFF
```

- The main process derives the source window from the acting sender. A
  renderer cannot select a different source window or draft.
- Binding a review transfers access to that review window's `webContents`.
  Every read, mutation, preview, approval, reopen, destination, and discard
  request resolves the current draft from the IPC sender.
- Closing the source retires only a draft that has not reached a bound review.
  Closing, cancelling, failing, or discarding the review retires the bound
  draft. A late collection result cannot restore a retired identity.
- Reopening an approved draft discards its snapshot and pending handoff before
  returning to mutable review. A later approval creates a new snapshot.

## Collection and Privacy Invariants

- Screenshot capture is limited to the already-authorized StashBase window,
  retains one lossless PNG, and rejects output above `16 MiB` or `16,384`
  pixels on either edge.
- Diagnostics use a fixed allowlist: application version and mode, Electron
  version, OS platform, release, architecture, and timestamp.
- Collection does not read workspace identity, folder lists, source content,
  Agent transcripts, environment variables, configuration, or credentials.
- Log collection reads at most the final `32 KiB`, drops a leading partial
  line, removes internal runtime-path diagnostics, redacts the exact home path
  and recognized credentials, and independently scans the result.
- The original screenshot buffer, unredacted log, paths, handles, source
  window identity, environment, configuration, and raw collection records do
  not cross the review Interface.
- Preview returns only the safe resource eligible for approval: sanitized log
  text or a bounded lossless PNG data URL. Preview never changes inclusion.
- Collection is best effort per resource. Suspicious or invalid content makes
  that resource unavailable rather than weakening the privacy rule.
- Collected screenshot, diagnostic, log, and report content is never written
  to the application log.

## Review Presentation Invariants

- The review BrowserWindow is local-only and isolated behind its narrow
  preload and CSP. It denies arbitrary navigation and popups. Full-screen
  presentation behavior is owned by [Window Lifecycle](window-lifecycle.md).
- One compact form owns the primary problem field, progressively disclosed
  optional reproduction steps, and an authoritative attachment checklist.
  Unavailable artifacts remain visibly unavailable rather than disappearing.
- Safe log preview is the exact read-only sanitized text eligible for
  approval. Screenshot preview uses the exact retained PNG and supports fit,
  full-size, wheel, and pinch inspection without cropping or changing bytes.
- Previews are collapsed until requested and never alter inclusion. Approved
  presentation locks fields and removes deselected resources from the approved
  view; **Back** explicitly restores mutable review.

## Approval and Handoff Invariants

- Approval atomically captures normalized user fields, approval time, and only
  selected available resources. The snapshot owns immutable copies or
  exclusive private resources and retains no mutable draft views.
- Preparation claims that snapshot atomically and never recollects inputs.
  Closing the review cannot invalidate an already claimed operation.
- Text is scanned again after final formatting and immediately before an
  atomic write. Failure exposes no partial sensitive artifact.
- Retries for one approval are idempotent. One approval reuses one Downloads
  folder; a fresh approval receives a new destination.
- GitHub URLs contain only the approved Problem, optional Steps to reproduce,
  and Environment sections. Artifact bytes, logs, internal identifiers, and
  filesystem paths never enter the URL.
- Preparing, opening GitHub, and downloading are separate explicit actions.
  Preparation alone performs no external action.
- Prepared temporary output is session-scoped and cleared on the next launch.
  Downloads copies are user-owned durable files outside that cleanup root.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Draft Interface | `createBugReportService` and lifecycle state in `electron/bug-report-service.cjs` |
| Collection Modules | `electron/bug-report-screenshot.cjs`, `electron/bug-report-diagnostics.cjs`, `electron/bug-report-log.cjs`, `electron/bug-report-redaction.cjs` |
| Approval/handoff Module | `electron/bug-report-handoff.cjs` |
| Review-window Adapters | `electron/bug-report-review-window.cjs`, `electron/bug-report-review-ipc.cjs`, `electron/bug-report-review-preload.cjs` |
| Presentation Adapters | `electron/bug-report-review-renderer.js`, `electron/bug-report-review.html`, `electron/bug-report-review.css`, `web-src/src/components/SidebarAccountRow.tsx`, and the native menu in `electron/main.cjs` |
| Focused evidence | `electron/bug-report-service.test.cjs`, `electron/bug-report-collection.test.cjs`, `electron/bug-report-redaction.test.cjs`, `electron/bug-report-handoff.test.cjs`, and `electron/bug-report-review.test.cjs` |

## Validation

Run:

```bash
pnpm typecheck
pnpm test:electron
```

Add `pnpm test:renderer` and `pnpm build:web` when the workspace entry changes.
Native packaged capture, review presentation, Downloads handoff, and browser
opening remain the residual [J09 release check](../release-checklists/ui-sanity.md).

Related journey:
[J09](../design-docs/user-journeys.md#j09-prepare-and-hand-off-a-bug-report).
Related contracts: [Window Lifecycle](window-lifecycle.md),
[Architecture](architecture.md), and [Renderer Styling](renderer-styling.md).
