# Preparation

## User Outcome

Hard-to-read local formats become usable as search and Agent context while the
original file remains visible, openable, and authoritative.

## Scope and Non-goals

Preparation covers PDF extraction, image OCR, durable DOCX text derivation,
audio/video transcription, compatible audio preview generation, progress, and
recovery. An opt-in clipboard screenshot becomes an ordinary image source only
after explicit acceptance, then follows the same OCR path. Together with Search
and Retrieval, preparation forms the local RAG layer. It does not own the
visible source preview, content-editing capability, or semantic ranking. The
[Documents format matrix](documents.md#format-capability-matrix) is the
canonical product-facing boundary between direct-text, prepared-text, and
preview-only behavior.

Users do not manage generated text, checkpoints, model internals, or index
artifacts.

## Current Experience

- Markdown and JSON use source text directly. HTML supplies an in-memory text
  representation for retrieval. They do not gain visible derived files.
- PDF, image, DOCX, audio, and supported video sources may gain AppData-derived
  text. PDF and media derived text also serves Agent reading; source identity
  remains unchanged.
- Clipboard-image offers are disabled by default. When enabled in Settings,
  StashBase notices copied images only while focused and asks before importing;
  dismissal writes nothing. Accepted screenshots remain visible image sources
  while OCR stays derived.
- Preparation runs in the background with interactive and open-folder work
  preferred over library background work.
- Direct DOCX preview and ordinary media playback do not wait for durable
  search preparation.
- Users see preparing, ready, blocked, failed, cancelled, and retryable states
  only when they change the next action. Missing optional capabilities do not
  turn the source itself into a failed file.
- Reprocess is explicit. Large PDF and media work can reuse valid resumable
  checkpoints after transient interruption while manual retry resets the work
  that must be recomputed.

## Experience Contract

- Preparation can improve a source but never replace it or make basic browsing
  depend on it.
- A direct-text readable format never becomes dependent on durable Preparation.
  A prepared-text readable format never exposes its derived representation as
  an editable source.
- A derived result is current only when its format-specific completion and
  source-freshness contract succeeds. File existence or an in-memory status is
  not completion truth.
- Conversion completion and AI Index readiness remain separate states.
- Explicit cancellation remains stopped until the user retries. Transient
  interruption is rediscoverable.
- Optional native tools and state stores degrade to actionable status rather
  than blocking folder entry.
- Ambient capture remains opt-in and reversible. Failure to read the setting or
  clipboard fails closed rather than enabling monitoring or creating a source.

## Cross-area Seams

- [Documents](documents.md) owns source preview and editing.
- [Search](search.md) consumes current source or prepared text as evidence.
- [Workspace](workspace.md) keeps background readiness quiet during browsing.
- Data correctness lives in
  [Data Lifecycle](../../code-review/data-lifecycle.md).

## Contribution Direction

### Next

- Make progress, partial readiness, cancellation, and recovery clearer.
- Improve diagnostics and format-specific fallbacks.
- Add a format only when it materially improves local Agent context.

### Coordinate First

- Derived-data ownership, cleanup, reconcile, retry, or scheduler semantics.
- New native tools or resource-intensive extractors.
- Making visible preview depend on preparation.

### Not Planned

- Asking users to organize generated artifacts.
- Replacing a source with a converted file.
- Treating an artifact's existence alone as proof of readiness.

## Related Journeys and Contracts

Journeys: [J04](../user-journeys.md#j04-prepare-a-hard-to-read-file) and the
[J10](../user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work)
core loop.

Contracts: [Data Lifecycle](../../code-review/data-lifecycle.md),
[Document Viewers](../../code-review/document-viewers.md), and
[Settings and Config](../../code-review/settings-config.md).
