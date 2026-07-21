# Markdown Rendering

This document describes the current read-only Markdown rendering path in the desktop app. It covers source loading, parsing, iframe installation, styling, navigation, find/highlight behavior, drag-and-drop forwarding, and the preview trust boundary. Markdown indexing and data ownership remain in [architecture.md](architecture.md) and [data-layer.md](data-layer.md).

## 1. Scope and ownership

The renderer recognizes `.md` and `.markdown` files as the `md` viewer format. The source file is the user-visible source of truth and is loaded as text through `GET /api/files/*`. Markdown preview does not read a derived representation and does not participate in indexing or conversion.

The implementation is split across these renderer modules:

- [`web-src/src/markdown.ts`](../web-src/src/markdown.ts) is the stable rendering seam. It exports only the document and inline rendering functions used by callers.
- [`web-src/src/markdown/documentRenderer.ts`](../web-src/src/markdown/documentRenderer.ts) owns the ordered document transformation pipeline.
- [`web-src/src/markdown/sanitization.ts`](../web-src/src/markdown/sanitization.ts) owns the document HTML allowlist and task-checkbox normalization.
- [`web-src/src/markdown/previewDocument.ts`](../web-src/src/markdown/previewDocument.ts) owns the complete iframe document wrapper and preview-local CSS.
- [`web-src/src/components/MarkdownPreview.tsx`](../web-src/src/components/MarkdownPreview.tsx) owns iframe installation and preview-specific DOM integration.
- [`web-src/src/lib/previewIframe.ts`](../web-src/src/lib/previewIframe.ts) injects the local asset base and interprets link and image clicks.
- [`web-src/src/components/findIframe.ts`](../web-src/src/components/findIframe.ts) implements in-preview find with the CSS Custom Highlight API.
- [`web-src/src/hooks/useIframeDropForward.ts`](../web-src/src/hooks/useIframeDropForward.ts) forwards operating-system file drops from the iframe to the app window.
- [`web-src/src/lib/previewMessages.ts`](../web-src/src/lib/previewMessages.ts) validates the source window for preview messages.
- [`web-src/src/store/AppContext.tsx`](../web-src/src/store/AppContext.tsx) loads source content and owns navigation, pending anchors, pending search highlights, and find-controller registration.
- [`web-src/src/App.tsx`](../web-src/src/App.tsx) receives preview navigation, image, and external-open messages.

`web-src/src/markdown.ts` also exports `renderMarkdownInline()` for Agent response bodies. Document preview and inline rendering use separate configured `Marked` instances so changes to document parsing cannot alter the chat contract. Inline rendering keeps single-newline line breaks and returns only an HTML fragment rendered in the app DOM. It does not use the Markdown preview iframe, document transformation pipeline, preview CSS, asset base, or preview interactions described below.

## 2. View selection and source loading

`server/format.ts` maps both `md` and `markdown` extensions to the `md` format. `GET /api/files/*` accepts Markdown and HTML note paths, reads their source bytes as text, and returns `{ name, format, content, version }`. Binary bundle assets are rejected by that route and remain available only through `/asset/*`.

`AppContext.loadFile()` calls `api.getFile(name)` for Markdown files and stores the returned source content in the open tab. New Markdown tabs enter **Live Editing** by default; the only alternative is explicit **Reading View**. `MainPane` selects between those two mutually exclusive Markdown surfaces:

- In Reading View, `MainPane` mounts `MarkdownPreview` with the file's folder-relative name and saved source content.
- In Live Editing, `MainPane` mounts the single-pane CodeMirror `CodeEditor`.

The mode control flushes a pending save before entering Reading View. A failed save leaves the tab and its buffer in Live Editing. Returning to Live Editing restores that tab's CodeMirror cursor, selection, scroll position, and undo/redo history; sessions are independent per tab, survive path renames, and are invalidated when a tab is assigned another document, when a clean tab receives an external source update, or when it is closed. There is no split source/preview surface and no separate source-editing mode.

Live Editing is a CodeMirror syntax-tree projection over the same Markdown buffer. It uses the GFM parser so headings, emphasis, strong emphasis, strikethrough, inline code, and horizontal rules receive document typography while inactive. Their source markers are concealed only while a cursor or selection does not intersect the construct; intersecting any part reveals the complete construct source. The projection updates on document and selection changes, does not rewrite or offset the Markdown buffer, and leaves incomplete, malformed, or unrecognized syntax as ordinary editable source. Cmd/Ctrl+B and Cmd/Ctrl+I are CodeMirror commands that respectively toggle strong emphasis and emphasis; each selected-text wrap/removal or empty-cursor paired insertion is one editor transaction.

## 3. Render pipeline

The read-only render path is synchronous until the browser installs the generated iframe document:

```text
folder-relative name + source Markdown
  -> renderMarkdown(content)
       -> configured document Marked instance parses content with package-native footnotes and heading IDs
       -> sanitize parsed body fragment
       -> normalize raw HTML and generated heading IDs in one GitHub-style namespace
       -> complete HTML document + inline preview CSS
  -> injectAssetBase(document, assetBaseUrl(name))
  -> iframe srcDoc
  -> native iframe load handler
       -> install click and keyboard listeners
       -> mark images as previewable
       -> apply pending anchor/highlight/find state
       -> attach file-drop forwarding
```

`MarkdownPreview` memoizes the complete HTML string by `[name, content]`. A source or path change produces a new `srcDoc` document. `loadedHtmlRef` records which HTML string has completed loading so pending anchors and search highlights are never applied to a stale iframe document.

React's iframe `onLoad` prop is not used. A native `load` listener is installed for every HTML identity, with an immediate `readyState === 'complete'` check to cover the race where parsing finishes before the effect attaches. Cleanup removes listeners from both the iframe and the installed document.

## 4. Markdown parser and emitted HTML

The parser is `marked` 18.0.3. Inline parsing keeps its own configured instance; each document render creates a configured parser with the document-only `marked-footnote` and `marked-gfm-heading-id` extensions:

```ts
const documentMarkdown = new Marked({
  gfm: true,
  breaks: false,
});
documentMarkdown.use(markedFootnote({ prefixId: 'footnote:' }), gfmHeadingId(), markedAlert());
const inlineMarkdown = new Marked({ gfm: true, breaks: true });
```

`gfm: true` enables Marked's GitHub Flavored Markdown behavior, including tables, strikethrough, task-list markup, and URL/email autolinking. In document preview, a single source newline inside a paragraph remains a soft break and collapses as ordinary HTML whitespace; two trailing spaces or a trailing backslash still emit `<br>`. Inline Agent output keeps `breaks: true`, where a single newline emits `<br>`.

The current preview renders Marked's standard block and inline constructs:

- ATX and Setext headings.
- Paragraphs with CommonMark soft breaks and explicit hard breaks.
- Strong, emphasis, and strikethrough.
- Inline code and fenced or indented code blocks.
- Ordered, unordered, nested, and task lists.
- Blockquotes and horizontal rules.
- Inline and reference links, autolinks, and email links.
- Images.
- GFM tables and alignment attributes.
- Escapes, entities, and allowlisted raw HTML.

Document preview removes valid, explicitly closed leading YAML frontmatter before parsing. It leaves malformed or unterminated delimiters as visible source. It additionally recognizes `marked-footnote`'s GFM `[^label]` references and `[^label]: definition` blocks. Referenced definitions appear in one trailing semantic footnote section. Its `footnote:` ID prefix is disjoint from GitHub heading slugs, so footnote targets cannot collide with generated heading anchors. The package generates a screen-reader-only section label, reference and backlink data attributes, unique repeated-reference IDs, and backlinks to every originating reference. This extension exists only on the document parser, so inline Agent output treats footnote syntax as ordinary text.

The document parser also uses `marked-alert` for standard GitHub alert blockquotes: `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, and `CAUTION`. Their package-native icon and title markup survives the sanitizer; the outer alert receives a readable landmark label and preview-local color treatment. Alert parsing and styling are document-only, so Agent-message Markdown keeps the source blockquote syntax.

Fenced-code language labels are retained as `language-*` classes. No syntax-highlighting pass runs over those classes.

Marked passes raw HTML into the parsed body, then `sanitize-html` applies a document-oriented allowlist before the preview document is assembled. It preserves ordinary structural and presentational elements, including tables, links, images, `details`, `summary`, `kbd`, `mark`, `sub`, and `sup`, plus the restricted SVG elements and classes emitted by `marked-alert`. It removes scripts, styles, frames and embedded content, forms, metadata, event-handler and inline-style attributes, frame targets, and non-HTTP(S) image protocols. Relative URLs remain valid; links additionally allow `mailto:`. Task-list inputs are normalized to disabled checkboxes. The renderer has no implementations for wikilinks, embeds, math, Mermaid, definition lists, emoji shortcodes, MDX, or explicit heading-attribute syntax.

## 5. Heading IDs and anchors

`marked-gfm-heading-id` generates GitHub-style IDs during document parsing. The raw-HTML renderer removes author-supplied heading IDs before sanitization, then a post-sanitization pass regenerates raw HTML and Markdown heading IDs in one GitHub-style namespace and suffixes collisions. The package footnote label retains its reserved ID so references and accessible descriptions remain intact. Inline Agent output does not install the extension and therefore does not gain heading IDs.

The generated ID is used by same-file links, cross-file links with fragments, outline/search-driven pending anchors, and `scrollIntoView()`. The renderer does not recognize `{#custom-id}` as explicit heading metadata; it remains heading text and contributes to the generated slug.

## 6. Preview document and styles

`renderMarkdown()` returns a complete document:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      ...
    </style>
  </head>
  <body>
    ...
  </body>
</html>
```

The iframe does not inherit the host page's styles, so all Markdown typography is embedded in this document. The current presentation is a white, Notion-influenced reading surface:

- The body uses a `16px/1.7` system sans-serif stack with CJK fallbacks.
- Content is centered with a maximum width of `820px` and `32px 56px 80px` padding.
- Headings use a compact line height, bold weight, and increasing top margins; H1 and H2 have bottom borders.
- Links use an underlined teal color with a stronger underline on hover.
- Footnote references use compact superscript links. The trailing footnote section uses smaller muted text, highlights the targeted entry, and gives references and backlinks a visible keyboard-focus outline.
- Inline code and code blocks use the system monospace stack and warm/light-gray surfaces.
- Code blocks scroll horizontally.
- Blockquotes use a dark left border. GitHub alert blocks use preview-local colored borders, backgrounds, icons, and readable titles.
- Lists, tables, table headers, images, and horizontal rules receive preview-local spacing and borders.
- Images are limited to the reading-column width and keep their aspect ratio.
- Images marked previewable use a zoom-in cursor.

The outer `.viewer-shell` fills the main pane, clips overflow, and supplies a white background. Its iframe is absolutely positioned to fill the shell with no border. Scrolling occurs inside the iframe document.

## 7. Relative assets

Before the HTML is assigned to `srcDoc`, `injectAssetBase()` adds a `<base>` element to the generated `<head>`. `assetBaseUrl(name)` derives the base from the Markdown file's parent directory:

```text
/asset/__window/<window-id>/<encoded-note-directory>/
```

The window ID is embedded in the path rather than the query string so it propagates to relative image and link URLs retained by the sanitizer. The server strips the reserved `__window/<id>/` prefix before resolving the remaining folder-relative path.

`/asset/*` resolves the target within the current folder and streams it with a known MIME type where available. The route supports images, SVG, CSS, JavaScript, JSON, fonts, PDF, audio, and video. Video formats that require range requests are sent with `sendFile()`; other assets use a read stream. Markdown itself is not fetched through `/asset/*` for rendering—the preview uses the source text already returned by `/api/files/*`.

## 8. Iframe and trust boundary

Markdown preview uses:

```html
<iframe sandbox="allow-same-origin" srcdoc="..."></iframe>
```

`allow-same-origin` lets the parent renderer access `contentDocument` and `contentWindow`. The sandbox omits `allow-scripts`, so scripts inside the Markdown document do not execute. The same-origin access is what enables direct click interception, keyboard handling, find ranges, search-result highlights, and file-drop forwarding.

Raw HTML is sanitized before entering `srcDoc`. Sanitization removes executable markup, unsafe URL protocols, embedded content, and document-level navigation vectors; the scriptless iframe remains an independent execution boundary. The generated document has no Content Security Policy. The trusted preview stylesheet and asset `<base>` are added outside the sanitized fragment.

Messages that can cause navigation, lightbox display, or external opening are accepted only when `event.source` is the app window or the current `#previewFrame` window. Message payloads are type-checked again in `App.tsx`. Image lightbox messages accept only HTTP, HTTPS, data, and blob URLs. External-open messages accept only HTTP and HTTPS URLs.

## 9. Link behavior

The parent installs one delegated click listener on the iframe document. `previewClickHandler()` resolves the nearest image first and otherwise resolves the nearest anchor.

Anchor behavior is based on the raw `href` and the browser-resolved URL:

- `#fragment` preserves the iframe's fragment state, then sends `stashbase-nav` for the current Markdown path and requested anchor. The fragment keeps native `:target` presentation active while app state owns the scroll request.
- Same-origin `/asset/*` links ending in `.md`, `.markdown`, `.html`, or `.htm` send `stashbase-nav` with the decoded folder-relative path and optional fragment.
- Other same-origin `/asset/*` links send `stashbase-open-external`; linked PDFs, media, images, and other assets therefore open through the system external-open path rather than changing the app shell.
- HTTP and HTTPS links send `stashbase-open-external`.
- Other schemes are not intercepted by the app-specific handler.

`App.tsx` receives `stashbase-nav` and calls `AppContext.navigateTo()`. A same-file anchor updates the active tab's pending anchor without reloading the file. A different note activates an existing tab or opens a new pinned tab, then stores the pending anchor for the newly mounted preview. Following a note link does not replace the source tab.

External URLs are passed to Electron's `openExternal` bridge when available, with a browser-window fallback. Same-origin asset URLs gain the current window ID as a query parameter when the path does not already carry window context, allowing the external browser request to resolve the correct open folder.

## 10. Images and lightbox

When an iframe document attaches, every image receives `data-stashbase-previewable="true"`. Clicking an image prevents the document's default action and posts `stashbase-preview-image` with its resolved `currentSrc` (or `src`) and alt text.

`App.tsx` validates the message source and URL protocol, then opens the shared application lightbox. This applies to Markdown images and raw HTML `<img>` elements alike. The lightbox behavior lives outside the iframe; the Markdown document itself remains scriptless.

## 11. In-preview find

`MarkdownPreview` registers an iframe-backed `FindController` with `AppContext` for the duration of its mount. The controller resolves the live iframe document on every operation because `srcDoc` replacement invalidates prior `Document` and `Range` objects.

Cmd/Ctrl+F inside the iframe prevents the browser's native find and opens the StashBase find bar. Cmd/Ctrl+G advances to the next result; Shift+Cmd/Ctrl+G moves to the previous result.

Find walks body text nodes while excluding direct text children of `script`, `style`, and `noscript`. It supports literal matching, case sensitivity, and whole-word mode. Matches are stored as DOM `Range` objects and painted with the iframe window's CSS Custom Highlight registry:

- `stash-find` paints non-current matches yellow.
- `stash-find-current` paints the active match blue with white text.

Next/previous navigation wraps and centers the active range in the iframe. When a content reload finishes while the find bar is open, the current query is scheduled again against the new document. Chromium's CSS Custom Highlight API is required; the Electron versions targeted by the app provide it.

## 12. Search-result chunk highlight

A search result can put `{ chunkText }` into the active tab's `pendingHighlight`. The Markdown preview applies it only after the iframe has loaded the current HTML.

The matching path:

1. Normalizes dashes, curly quotes, non-breaking spaces, zero-width spaces, and whitespace runs in the result text.
2. Removes common Markdown wrappers, link destinations, images, fenced code, heading prefixes, and blockquote prefixes.
3. Produces up to three unique 80-character anchors from the beginning, middle, and end of the cleaned text.
4. Flattens iframe body text into a whitespace-normalized string while retaining a mapping back to each source text-node offset.
5. Uses the first exact anchor found to construct a DOM `Range`.

The range is painted as `stashbase-chunk`, smoothly centered, and removed after four seconds. The pending highlight is consumed only when a range is found and installed. The implementation uses the CSS Custom Highlight API and has no fallback path.

## 13. File-drop forwarding

An iframe consumes drag events before the app window's global drop handlers can see them. `useIframeDropForward()` attaches `dragover` and `drop` listeners to each live iframe document.

For operating-system file drops it:

1. Prevents the iframe's default handling.
2. Collects `FileSystemEntry` objects synchronously from `DataTransfer.items` before Chromium invalidates them.
3. Dispatches `stashbase:iframe-drop` on the parent window.

The application's global drag/drop path receives that event and processes it the same way as a drop elsewhere in the app.

## 14. Relationship to editing, search, and indexing

Markdown preview is a renderer-only projection of the current source content:

- Editing happens only in CodeMirror and saves source Markdown through `/api/files/*`.
- Live Editing presentation is a renderer-only CodeMirror decoration layer derived from the Markdown syntax tree. It never serializes a display model back to Markdown; revealing syntax changes only ephemeral decorations, not the source buffer or selection offsets.
- Entering Reading View flushes the pending save before remounting preview; a failed save keeps Live Editing mounted.
- Preview HTML, generated heading IDs, injected styles, find styles, and highlight ranges are ephemeral and never written into the source file.
- Source Markdown, not preview HTML, is the index input.
- Search results refer back to the source Markdown path; pending anchors and chunk text are renderer navigation state stored on the open tab.
- Loading, viewing, searching, or navigating away never writes a Markdown file. A clean Live Editing tab remains eligible for external-deletion pruning; only an edited buffer is retained for recovery. On an actual save, the server retains a source file's UTF-8 BOM presence and its uniform LF or CRLF convention; mixed endings use their dominant convention, and skips the write when that serialization is byte-identical to the source. Raw HTML, frontmatter, malformed Markdown, and unsupported syntax pass through the editor as source text rather than preview serialization.

The parser, preview document, and iframe interactions are entirely renderer-side. The server participates only in source loading/saving and folder-scoped asset streaming.
