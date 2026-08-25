# Document Viewers

> Review contract for non-Markdown source viewers, preview freshness, failure
> states, navigation, and document-content trust boundaries.

## Viewer Contract

- The [Documents format capability matrix](../design-docs/design/documents.md#format-capability-matrix)
  owns the user-visible distinction among preview, Workbench authoring,
  retrieval text, and Agent/MCP access. Viewer dispatch and affordances must
  match it; previewability never implies content editing or text-readable MCP
  access.
- A viewer is selected from the visible source format and retains that source
  as tab identity. Prepared text is evidence and fallback, never a replacement
  tab.
- Binary viewers refetch when the source version changes and reject late work
  from an older tab, folder, worker, or request generation.
- Parse, decode, worker, or preparation failure leaves the source tab visible
  with an explicit, format-appropriate recovery state.
- Find, anchors, search highlights, links, image activation, and keyboard
  commands route through shared application actions. Viewer DOM cannot become
  a second navigation or file-mutation owner.
- Direct preview and durable preparation are independent. A direct DOCX view
  may succeed while searchable extraction is pending or failed; neither state
  may falsely complete the other.

## Trust Boundary

Markdown and Agent Markdown render structured node trees and never inject a
raw HTML string; DOCX-derived HTML is sanitized by its owning renderer through
`shared/html-sanitization.ts`. Viewer messages validate the expected frame Window before applying
navigation, Find, or highlight events. HTTP(S) navigation goes through the
system browser; relative source links stay within authorized library paths.

**Known gap — executable local HTML:** `HtmlPreview` currently serves local
HTML in an iframe with `allow-scripts allow-same-origin`. Document code can run
on the application's loopback origin, may reach same-origin application
surfaces, and may request remote subresources. This is weaker than the Required
document-content boundary above. Do not broaden this capability or treat the
sandbox as isolation. A fix needs an explicit compatibility decision, a
separate origin or equivalent privilege boundary, a remote-resource policy,
and regression coverage for assets, links, Find, highlights, drag/drop
forwarding, and script confinement.

## Format-specific Behavior

- PDF uses source bytes and retains page position across tab activation. A
  programmatic smooth jump owns its requested page until the viewport reaches
  it, so intermediate animation frames cannot overwrite the saved position; an
  instant jump claims nothing and persists its page without waiting for the
  passive page effect. Scale is bounded; worker and asset URLs retain
  window/folder identity. The document is reopened only when the versioned
  source URL changes — never because an application command object changed
  identity. Preparation status and the Reprocess command are computed by the
  viewer dispatch and passed in, so the PDF viewer performs no file mutation
  and holds one scroll owner and no preparation state.
- DOCX fetches source bytes, parses in a renderer Worker, sanitizes output, and
  falls back to durable prepared HTML after a `20 s` direct-preview deadline.
  A parse, fetch, or timeout failure keeps an explicit direct-preview warning
  above the fallback; it does not depend on or fabricate a preparation failure.
  Reprocess remains available only for a real preparation failure. Server
  preparation has its own `60 s` worker deadline.
- Local HTML is served with the viewer bootstrap the frame needs — heading
  ids, anchor scroll, the in-frame Find half, external-link forwarding, and a
  neutral scrollbar rule. Injected chrome is a default, not an override: it
  precedes the document's own styles and carries no `!important`, so a page
  that styles its scrollbars keeps them. None of it reaches the indexed
  plaintext.
- Image viewing uses the shared lightbox and never turns the preview into an
  editable managed asset.
- Audio and supported video use a compatible playback preview when necessary,
  while transcript state follows preparation freshness and source time.
- JSON source text is authoritative. Strict, unique-key JSON at or below
  `512,000` UTF-8 bytes, `20,000` nodes, and depth `80` may expose the lazy Tree
  controller; other input stays openable and saveable in Source mode with an
  actionable reason. Tree values retain raw token spans, and structural edits
  patch only the affected value, property, or array range. The tree never
  materializes the document through `JSON.parse` or persists a serialized
  object. Global Find and the visible tree search share matching semantics;
  typing directly in the simple tree field resets undisclosed case/whole-word
  options. Tree focus is roving; Arrow keys, Home, and End navigate visible
  nodes before keyboard users enter a selected node's edit actions, and closing
  an edit returns focus to that node. Search-result highlights select and reveal
  a matching Tree node; an unrepresentable source range switches to the visible
  Source editor before selection. Both views save through
  [File Transactions](file-transactions.md).

## Implementation Map

| Role | Stable entry points |
|---|---|
| Shared format vocabulary | `shared/file-formats.ts` and dispatch policy in `server/format.ts` |
| Viewer dispatch | `web-src/src/app/components/MainPane.tsx`, `web-src/src/features/documents/components/DocumentViewer.tsx` |
| Primary viewers | `web-src/src/features/documents/components/PdfViewerPane.tsx` (the PDF dynamic entry, composing preparation policy onto the viewer) over `PdfPreview.tsx` with its `PdfChrome.tsx` / `PdfPage.tsx` presenters, `DocxPreview.tsx`, `HtmlPreview.tsx`, `ImagePreview.tsx`, `AudioPreview.tsx`, `JsonDocument.tsx`, the lazy `json/JsonTreeView.tsx` controller, and the shared `web-src/src/common/components/ImageLightbox.tsx` |
| Preview-control Modules | `web-src/src/features/documents/hooks/usePdfDocument.ts`, `usePdfZoom.ts`, `usePdfPageTracking.ts`, `usePdfFindRegistration.ts`, `usePdfPreparation.ts`, `useFileReprocess.ts` (the Reprocess command and its stale-reply guard, shared by the PDF chrome row and the image and DOCX banners), `useAudioFallbackController.ts`, `useAudioTranscriptController.ts`, `web-src/src/features/documents/lib/audioPlayback.ts`, `audioTranscript.ts`, `findIframe.ts`, `previewChunkHighlight.ts`, `pdfText.ts`, `pdfFindController.ts`, `previewIframe.ts`, and `previewMessages.ts` |
| Worker/Sanitizer Seam | `web-src/src/features/documents/workers/docxPreview.worker.ts`, `shared/html-sanitization.ts` |
| Server asset/preparation Adapters | `/asset` and `/derived-asset` routes, `server/docx.ts`, media preparation Modules |
| Focused evidence | `web-src/src/features/documents/__tests__/pdf-viewer.test.ts`, `pdf-text.test.ts`, `audio-playback.test.ts`, `audio-transcript.test.ts`, `json-document.test.ts`, `json-source-model.test.ts`, plus `e2e/journeys/formats-media.spec.ts` and `markdown-json.spec.ts` |

## Validation

Run:

```bash
pnpm typecheck
pnpm test:renderer
pnpm test:conversion-scheduler
pnpm build:web
```

Run `pnpm test:e2e:functional` for viewer selection, valid fixtures, failure
identity, navigation, or Find changes. Packaged complex PDF/DOCX/media and
native codec behavior remain release checks.

Review at least one representative fixture for each behavior class rather than
inferring every capability from one extension: editable prose, editable
structured text, direct preview-only text, binary preview with prepared text,
OCR image, and transcript media. Extension aliases remain lower-level format
detection evidence.

Related journeys: [J03](../design-docs/user-journeys.md#j03-read-and-edit-source-documents)
and [J04](../design-docs/user-journeys.md#j04-prepare-a-hard-to-read-file).
Related contracts: [Markdown Rendering](markdown-rendering.md),
[Data Lifecycle](data-lifecycle.md), and [Renderer Workspace](renderer-workspace.md).
