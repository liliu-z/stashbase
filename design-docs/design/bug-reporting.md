# Bug Reporting

## User Outcome

People can turn a local failure into a useful, privacy-reviewed report without
enabling telemetry or allowing StashBase to submit anything automatically.

## Scope and Non-goals

This area owns the user-visible report flow: deliberate entry, problem and
reproduction fields, optional artifact review, local preparation, and explicit
handoff destinations. It does not own general diagnostics, telemetry, crash
reporting, GitHub authentication, or automatic issue submission.

Bug-report drafts and prepared temporary artifacts are application state, not
workspace files. They never join the library, search, preparation, or AI Index.

## Current Experience

- Reporting normally starts from the sidebar **Report Bug** action or native
  **Help → Report a Bug…**. When an available update temporarily replaces the
  sidebar's secondary utilities, the native entry remains available; it also
  remains usable when the main workspace renderer is unhealthy.
- StashBase opens a dedicated local review window. It collects the selected
  StashBase window, a fixed environment summary, and a bounded sanitized log
  tail on a best-effort basis; one unavailable artifact does not discard the
  rest of the draft.
- The review is one compact form: a primary problem description, optional
  reproduction steps, and an attachment checklist. Each available artifact
  can be previewed and included or excluded independently. Opening a preview
  never changes its selection.
- **Prepare Report** is the approval point. It freezes exactly the reviewed
  text and selected artifacts, creates only those files locally, and moves the
  same window to a **Report ready** handoff. Nothing is uploaded or submitted.
- **Open GitHub** copies the prepared files into one uniquely named Downloads
  folder and opens a prefilled issue for the user to finish and attach files.
  **Download** creates the same durable copy without opening GitHub.
- **Back** returns to mutable review, discards the previous approval and
  prepared handoff, and requires a fresh approval. Closing the review discards
  its session draft. The temporary report root is cleared on the next launch;
  user-owned Downloads copies remain.

## Experience Contract

- Collection and every external destination require deliberate user actions.
  Reporting never becomes background telemetry or automatic submission.
- The user can inspect the exact safe representation eligible for approval and
  can exclude any optional artifact. Preview and selection remain separate.
- Approval freezes one exact snapshot. Preparation never recollects a window,
  rereads changing inputs, or adds a resource the user did not select.
- The application owns drafts, private resources, preparation, filesystem
  destinations, and cleanup. Renderer views receive only the safe information
  needed to present the current review.
- Logs, diagnostics, user text, and final text artifacts fail closed when the
  privacy scan cannot establish a safe result.
- A source window closing does not invalidate an already opened review. A
  closed or discarded review cannot be revived by a late collection result.

## Cross-area Seams

- [Workspace](workspace.md) owns the sidebar entry and current native window.
- [Architecture](../architecture.md) owns application-state and trust
  boundaries shared with the rest of the product.
- [Bug Reporting](../../code-review/bug-reporting.md) owns draft authority,
  collection bounds, approval snapshots, artifact handoff, and focused tests.
- [Window Lifecycle](../../code-review/window-lifecycle.md) owns native review
  window creation, survival, and retirement.

## Contribution Direction

### Next

- Add a copy-details fallback without introducing report history or automatic
  submission.
- Improve review accessibility and recovery while keeping one compact form.

### Coordinate First

- Any new diagnostic field, artifact type, retention policy, destination, or
  submission mechanism.
- Changes to review authorization, artifact selection, privacy scanning,
  approval, or cleanup.

### Not Planned

- Hosted crash reporting, background telemetry, or automatic uploads.
- GitHub OAuth, access tokens, or direct GitHub API issue creation.
- Full-desktop capture, arbitrary file collection, or Agent transcript export.

## Related Journeys and Contracts

Journey: [J09](../user-journeys.md#j09-prepare-and-hand-off-a-bug-report).

Contracts: [Bug Reporting](../../code-review/bug-reporting.md),
[Window Lifecycle](../../code-review/window-lifecycle.md), and
[Architecture](../../code-review/architecture.md).
