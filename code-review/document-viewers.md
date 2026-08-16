# Document Viewers

> Review contract for non-Markdown source viewers, preview freshness, failure
> states, navigation, and document-content trust boundaries.

## Viewer Contract

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
- Transient external files open with a temporary preview grant scoped strictly
  to the requesting window identity. They are read-only, out-of-folder, and
  stay out of library indexing and preparation pipelines. Browser-loaded grant
  assets carry the window context in their URL path prefix (`/asset-preview-grant/__window/<windowId>/<grantId>`).

## Trust Boundary

Markdown, Agent Markdown, and DOCX-derived HTML are sanitized by their owning
renderers. Viewer messages validate the expected frame Window before applying
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
  it, so intermediate animation frames cannot overwrite the saved position.
  Scale is bounded; worker and asset URLs retain window/folder identity.
- DOCX fetches source bytes, parses in a renderer Worker, sanitizes output, and
  falls back to durable prepared HTML after a `20 s` direct-preview deadline.
  Server preparation has its own `60 s` worker deadline.
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
| Viewer dispatch | `web-src/src/components/MainPane.tsx` |
| Primary viewers | `PdfPreview.tsx`, `DocxPreview.tsx`, `HtmlPreview.tsx`, `ImagePreview.tsx`, `ImageLightbox.tsx`, `AudioPreview.tsx`, `JsonDocument.tsx`, and the lazy `json/JsonTreeView.tsx` controller |
| Preview-control Modules | `web-src/src/components/audio/`, `web-src/src/components/findIframe.ts`, `previewChunkHighlight.ts`, `pdfText.ts`, `pdfFindController.ts`, `web-src/src/lib/previewIframe.ts`, and `previewMessages.ts` |
| Worker/Sanitizer Seam | `web-src/src/workers/docxPreview.worker.ts`, `shared/html-sanitization.ts` |
| Server asset/preparation Adapters | `/asset` and `/derived-asset` routes, `server/docx.ts`, media preparation Modules |
| Focused evidence | `web-src/src/__tests__/pdf-text.test.ts`, `audio-playback.test.ts`, `audio-transcript.test.ts`, `json-document.test.ts`, `json-source-model.test.ts`, plus `e2e/journeys/formats-media.spec.ts` and `markdown-json.spec.ts` |

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

Related journeys: [J03](../design-docs/user-journeys.md#j03-read-and-edit-source-documents)
and [J04](../design-docs/user-journeys.md#j04-prepare-a-hard-to-read-file).
Related contracts: [Markdown Rendering](markdown-rendering.md),
[Data Lifecycle](data-lifecycle.md), and [Renderer Workspace](renderer-workspace.md).
