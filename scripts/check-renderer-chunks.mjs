import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(repoRoot, 'web', 'dist-app');
const manifestPath = path.join(outputRoot, '.vite', 'manifest.json');
/* Guardrail against a heavy module slipping into the always-loaded shell,
 * not a freeze on shell features. Raised 400 → 416 KiB when the activity
 * rail became the titlebar controls + a sidebar Settings row; 416 → 418
 * when the active-folder header gained the folder-switcher trigger and
 * its menu-item builder (the menu body itself stays in the lazy
 * ManagedMenu chunk). Both are eager chrome by definition. 418 → 424 for
 * save-conflict resolution and desktop updates: the resolver surface, the
 * update banner, and the General settings panel are all lazy, but the parts
 * that decide WHETHER to show them are not — the conflict actions live in
 * the document action set, and the clipboard-capture handoff lives in the
 * shell's own hook. 424 → 425 for the "Link to file…" picker: its body
 * (ManagedLinkFilePicker, listed as a required dynamic entry below) stays
 * lazy, but the always-mounted gate that owns the open/close event and its
 * slash-menu trigger wiring is eager by the same shell-UI rule as Quick
 * Open's own gate. 425 → 426 when this branch merged main's
 * Choose-Folder-on-bare-windows work: `ChooseFolderButton` sits below the
 * always-mounted New Chat button and `FolderSwitcher`'s menu-item builder
 * moved into the shared `libraryMenuItems` module — both eager chrome by
 * the same rule as the folder-switcher trigger above, landing on top of
 * this branch's own Link-to-file picker gate rather than instead of it.
 * 426 → 427 when the agent panel moved off `react-aria-components` onto the
 * same Base UI primitives the rest of the app uses. This one is not a new
 * feature: consolidating on one component library hoists Base UI's shared
 * internals (useRenderElement, useButton, event details) out of the lazy
 * chat chunk and into the shared graph the entry already pulls, costing
 * ~300 bytes here. It buys a 55 KB cut to the ChatPane chunk (144 → 89) and
 * removes the dependency outright, so the app ships less code overall — the
 * initial slice just carries a slightly larger share of the shared runtime
 * every eager surface was already using.
 * Not raised for the design-system pass that moved the app's hand-rolled
 * markup onto the shared primitive layer: it lands ~400 bytes UNDER the
 * 427 figure, because a primitive whose internals the entry already pulls
 * is cheaper than the bespoke recipe it replaces.
 * 427 → 428 when the last native `<select>` became the Base UI one. Every
 * caller is lazy (Settings, the audio viewer), and the entry chunk itself
 * got 1,925 bytes SMALLER — the raise is pure chunk-splitting overhead.
 * `useRegisterFieldControl`, `useControlled` and `useBaseUiId` were already
 * in the eager graph, inlined into the entry by the primitives that use
 * them; the moment a lazy chunk shared them too, Rolldown extracted all
 * three into shared chunks (+2,859 bytes) that are counted separately. So
 * this one buys no new eager code, only a different arrangement of the
 * same code — and unlike the raise above it does NOT make the app ship
 * less overall, since Base UI's select is genuinely larger than the native
 * element it replaces. What it buys is a select that follows `data-theme`,
 * which a native popup painted in the OS palette never could.
 * One conversion in the design-system pass did not survive this check and
 * is worth knowing about before
 * anyone retries it — putting the document `TabStrip` on the shared `Tabs`
 * primitive added 22,780 bytes here (Base UI's `Tabs*`/`Composite*`
 * modules plus the `react-dom` and `useOpenChangeComplete` chunks they
 * pull), 5% of this budget, for a keyboard contract that strip already
 * implemented. It stays hand-rolled; `code-review/renderer-styling.md`
 * carries the rule and `TabStrip.tsx` the reason.
 * 428 → 429 adds the always-visible third runtime metadata and
 * included-Agent recovery action.
 * 429 → 430 for the file row's "Move to…" picker — the keyboard path to
 * the drag-onto-a-folder move. Its body (ManagedMoveFilePicker, listed as
 * a required dynamic entry below) stays lazy; the always-mounted gate
 * that owns the open event is eager by the same shell-UI rule as Quick
 * Open's and Link-to-file's gates, measured at ~1 KB of initial JS.
 * 430 → 434 for the HTML-semantics pass across the eager shell: the
 * shared focus trap the always-mounted overlays now run (FindBar's veils,
 * lightbox, crash card), ARIA state on menus/tabs/trees (aria-checked,
 * aria-owns, posinset), live regions on previously silent status text,
 * and the keyboard equivalents for pointer-only gestures (Delete-to-close,
 * tab reorder, keyboard context-menu anchoring) — ~3.7 KB of eager code
 * that is contract, not feature, and cannot move to a dynamic entry.
 * 434 → 435 adds first-class TXT routing and its distinct tree glyph; the
 * editor, decode-error state, and conflict surface remain together behind
 * the required `PlainTextViewerPane` dynamic entry below.
 * 435 → 437 for truthful workspace-tree capability. The generic viewer body
 * remains a required dynamic entry below; the measured cost here is the
 * eager tree's generic/excluded capability state, explanation, selection
 * routing, and the ONE reveal affordance every restricted entry shares —
 * an unreadable file, an undownloaded cloud placeholder, and a symlink
 * previously rendered identically to a working file. All of it must exist
 * before a row can be rendered or opened. The reveal also moved from a
 * tree.css descendant rule onto the row group, which is utilities rather
 * than a stylesheet the budget never counted.
 * 437 → 438 for the Files panel's Show Hidden Files preference — the
 * folder menu's checkable item, the tree's hidden-row marking, the toggle
 * action, and the listing-carried visibility flag, ~0.9 KB of eager code.
 * All of it is always-mounted chrome by the same rule as the folder menu's
 * other items: the menu body stays in the lazy ManagedMenu chunk, but the
 * item list, row classes, and the action they dispatch exist before any
 * row renders.
 * Raise it only for shell UI that must load with the window — anything a
 * user can open on demand belongs in a dynamic entry above. */
const initialJsBudgetBytes = 438 * 1024;
const expectedEntries = [
  'src/features/agent-panel/components/ChatPane.tsx',
  'src/features/agent-panel/components/AgentMathMarkdown.tsx',
  'src/features/documents/components/CrepeDocument.tsx',
  'src/features/documents/components/JsonDocument.tsx',
  'src/features/documents/components/PlainTextViewerPane.tsx',
  'src/features/documents/components/GenericFileViewer.tsx',
  'src/features/documents/components/json/JsonTreeView.tsx',
  'src/features/documents/components/PdfViewerPane.tsx',
  'src/features/documents/components/DocxPreview.tsx',
  'src/features/documents/components/AudioPreview.tsx',
  'src/features/search/components/ManagedLibrarySearch.tsx',
  'src/features/search/components/ManagedQuickOpen.tsx',
  'src/features/documents/components/ManagedLinkFilePicker.tsx',
  'src/features/workspace/components/ManagedMoveFilePicker.tsx',
  'src/app/components/ContextMenu.tsx',
  'src/common/components/DocumentOutline.tsx',
  'src/common/components/SemanticIndexingNotice.tsx',
  'src/features/preparation/components/EmbeddingSetupCallout.tsx',
  'src/features/account/components/SidebarAccountRow.tsx',
  'src/features/settings/components/embedder/RequireApiKeyModal.tsx',
];

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function chunkSize(entryKey) {
  const entry = manifest[entryKey];
  if (!entry?.file) throw new Error(`renderer manifest entry is missing: ${entryKey}`);
  const chunkPath = path.join(outputRoot, entry.file);
  const stat = fs.statSync(chunkPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`renderer chunk is missing or empty: ${entry.file}`);
  }
  return stat.size;
}

for (const source of expectedEntries) {
  const entry = manifest[source];
  if (!entry?.isDynamicEntry) {
    throw new Error(`renderer build is missing dynamic entry: ${source}`);
  }
  chunkSize(source);
}

const initialEntries = new Set();
function collectStaticImports(entryKey) {
  if (initialEntries.has(entryKey)) return;
  initialEntries.add(entryKey);
  const entry = manifest[entryKey];
  if (!entry) throw new Error(`renderer manifest import is missing: ${entryKey}`);
  for (const imported of entry.imports ?? []) collectStaticImports(imported);
}

const rendererEntry = Object.entries(manifest).find(([, entry]) => entry?.isEntry)?.[0];
if (!rendererEntry) throw new Error('renderer manifest is missing its entry chunk');
collectStaticImports(rendererEntry);
const initialJsBytes = [...initialEntries].reduce((total, entryKey) => total + chunkSize(entryKey), 0);
if (initialJsBytes > initialJsBudgetBytes) {
  throw new Error(
    `renderer initial JS is ${initialJsBytes} bytes, exceeding the ${initialJsBudgetBytes}-byte budget`,
  );
}

console.log(
  `[renderer-chunks] verified ${expectedEntries.length} dynamic entries; `
    + `initial static JS ${initialJsBytes}/${initialJsBudgetBytes} bytes`,
);
