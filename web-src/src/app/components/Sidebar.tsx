import '@/common/styles/tree.css';
import {
  ChevronDownIcon,
  FolderIcon,
  MoreHorizontalIcon,
  NewFileIcon,
  OutlineIcon,
  SquaresFourIcon,
  StarIcon,
} from '@/common/components/icons';
import { electronBridge } from '@/common/lib/electronBridge';
import { useAppActions, useWorkspace } from '@/store/contexts/AppContext';
import { useSemanticIndexingNotice } from '@/store/hooks/useSemanticIndexingNotice';
import { folderRefsEqual } from '@/store/lib/folderPath';
import { basename, shortenFolderPath } from '@/common/lib/paths';
import { SidebarAccountRow } from '@/features/account';
import { NewChatButton, launcherRowClass } from '@/features/agent-panel';
import { EmbeddingSetupCallout } from '@/features/preparation';
import {
  FileTree,
  FolderHeaderMenu,
  RemoveFolderModal,
  useFolderFavorite,
  useFolderRemoval,
  folderPickerFlows,
  useLibraryReconcile,
  useOpenFolderWindow,
} from '@/features/workspace';
import { useOutlineDefaultExpansion } from '@/app/hooks/useOutlineDefaultExpansion';
import { useDocumentOutline } from '@/common/components/DocumentOutlineContext';
import { LazyLoadBoundary, lazyWithRetry } from '@/common/components/ErrorBoundary';
import { Button } from '@/common/components/ui/button';
import { SectionHeading } from '@/common/components/ui/section';
import { FILE_MIME } from '@/common/lib/dragMime';
import { Suspense, useCallback, useState, type DragEvent } from 'react';
import { cn } from '@/common/lib/utils';

const DocumentOutline = lazyWithRetry(() =>
  import('@/common/components/DocumentOutline').then((mod) => ({ default: mod.DocumentOutline })));
const SemanticIndexingNoticeView = lazyWithRetry(() =>
  import('@/common/components/SemanticIndexingNotice').then((mod) => ({ default: mod.SemanticIndexingNoticeView })));

/**
 * The sidebar is one Files panel — the active folder's file tree — with
 * no activity rail: the sidebar toggle, search, and the library folder
 * switcher live in the shell's titlebar controls (`TitlebarControls.tsx`),
 * search itself in the library search popup (`ManagedLibrarySearch.tsx`),
 * and the account (with Settings beside it) in the panel's bottom row.
 */
export function Sidebar() {
  return (
    /* Explicit h-full so the inner file list (flex-1) knows how much to
     * grow into; overflow-hidden clips content as the grid column
     * resizes / collapses to zero width — without it, file names
     * visually spill into the main pane mid-transition.
     * `group/sidebar` drives the hover-reveal of the header action
     * icons (see the side-actions class strings below). */
    /* Named landmark: the chat pane is a second `complementary` region
     * ("Agent chat"), and two same-role landmarks are indistinguishable
     * in a screen reader's landmark list without accessible names. */
    <aside aria-label="Library" className="sidebar group/sidebar relative flex h-full min-h-0 min-w-0 flex-row overflow-hidden border-r border-border bg-pane">
      {/* macOS Electron only (display:none elsewhere): the quiet band at
        * the column's top that the traffic lights float over, doubling as
        * the window drag region now that there is no titlebar strip.
        * Structural rules live in globals.css (Electron chrome
        * exemption) — `-webkit-app-region` needs a real element. */}
      <div className="sidebar-drag-zone" aria-hidden="true" />
      {/* `sidebar-panel` carries the titlebar clearance (globals.css). */}
      <div className="sidebar-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <FilesPanel />
      </div>
    </aside>
  );
}

/* Header action icons stay invisible until the pointer is over the
 * sidebar, mirroring VS Code's quiet explorer toolbar. Stays a class
 * string: it is a reveal rule on ONE cluster in this file, and the cluster
 * swaps it for a plain `flex gap-0.5` whenever a menu is open (icons must
 * not vanish under an open menu). A component would have to take that
 * override as a prop and forward it, which is the class string again with
 * an element around it. */
const sideActionsClass =
  'flex gap-0.5 opacity-0 transition-opacity duration-fast group-hover/sidebar:opacity-100 group-focus-within/sidebar:opacity-100';

/* Section header toggle: a quiet, normal-case label whose chevron sits in
 * the same 16px leading slot the pill rows use, so the header text lines
 * up with the row text gutter below it. Rotation lives on the chevron slot
 * (not `[&_svg]` on the button) so other glyphs in the header stay put —
 * callers rotate the slot from the same state that drives aria-expanded.
 *
 * A sanctioned exemption from the `Button` primitive: this control is the
 * full width of its own tinted strip, and the strip is what says "header".
 * (The ghost recipe's expanded tint is aria-haspopup-gated now, so it no
 * longer bites a steady-state disclosure like this one; the exemption
 * stands on geometry alone.) Adopting the primitive would still mean
 * cancelling its height, padding, weight, justification and hover fill. The
 * header answers the pointer by changing its ink and swapping its glyph for
 * a fold chevron; it is a disclosure heading, not a control chip. */
const sectionToggleClass =
  'inline-flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left '
  + 'text-muted-foreground hover:text-foreground focus-visible:text-foreground';

/** The Explorer view. The active folder zone (current folder header +
 * file tree) and the active Markdown document outline share this one
 * sidebar as stacked sections; library membership lives in the titlebar's
 * folder switcher. */
function FilesPanel() {
  const state = useWorkspace();
  const { activeTab } = state;
  const { actions } = useAppActions();
  const { outline } = useDocumentOutline();

  const hasMarkdownDocument = activeTab?.file?.format === 'md';
  // Tri-state: `null` means the embedder has not been read yet, and only a
  // definite `false` should pull in the notice chunk. The card re-checks
  // before rendering; this just decides whether loading it can matter.
  const embeddingSetupPossible = state.embedderHasKey === false;
  // The outline block belongs to an OPEN DOCUMENT inside an open
  // folder. A bare workspace (chat only, nothing open) drops it, as
  // does a window with no folder — nothing there has an outline, and
  // the sections below should hold the eye instead.
  const showOutline = !!state.folderPath && !!activeTab?.file;

  const documentKey = hasMarkdownDocument && activeTab?.file
    ? `${activeTab.file.folder ?? ''}:${activeTab.file.name}`
    : null;
  const hasHeadings = outline.headings.length > 0;
  const [outlineExpanded, setOutlineExpanded] = useOutlineDefaultExpansion(documentKey, hasHeadings);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" id="sidebar-panel-files">
      <NewChatButton />
      {/* One launcher group under New Chat: every row shares the New Chat
        * row's launcher recipe (`launcherRowClass` — same ghost row, same
        * 16px leading slot around a 14px glyph, labels on the shared
        * gutter line), and gap-1 repeats the 4px step the -mt-2 already
        * sets between New Chat and this group. pb-1 keeps that same step
        * below, so in a folder window the folder header lands exactly
        * where the (hidden) Choose Folder row would sit — one rhythm down
        * the whole column. */}
      <div className="-mt-2 flex flex-none flex-col gap-1 px-1.5 pb-1">
        {/* Gallery — a quiet standing row that raises the Gallery OVERLAY
          * over the workspace (`openGallery`), a side-effect-free
          * destination rather than a place of its own in the sidebar. */}
        <Button
          variant="ghost"
          size="sm"
          className={launcherRowClass}
          onClick={() => actions.openGallery()}
        >
          <span className="inline-flex size-4 flex-none items-center justify-center">
            <SquaresFourIcon className="size-3.5 text-muted-foreground" />
          </span>
          <span className="min-w-0 truncate">Gallery</span>
        </Button>
        {/* Choose Folder — the launcher row for "bring your own", the
          * Gallery's sibling on a BARE window's first screen. Gone once
          * a folder is open: there it would mean an in-place switch,
          * which is the titlebar Library switcher's job — unlike the
          * Gallery row above (a side-effect-free destination), a
          * workspace-mutating action does not earn a standing seat.
          * Same row idiom; the ellipsis is the opens-a-dialog
          * convention (native picker, which can also create). */}
        {!state.folderPath && (
          <Button
            variant="ghost"
            size="sm"
            className={launcherRowClass}
            onClick={() => { void folderPickerFlows(actions, electronBridge())?.openExistingFolder(); }}
          >
            <span className="inline-flex size-4 flex-none items-center justify-center">
              <FolderIcon className="size-3.5 text-muted-foreground" />
            </span>
            <span className="min-w-0 truncate">Choose Folder…</span>
          </Button>
        )}
      </div>
      {/* Explorer sections mirror VS Code's compact disclosure rows. The
        * folder zones and the active document's outline intentionally share
        * one navigation surface; neither becomes a floating editor
        * companion. */}
      <ActiveFolderSection>
        {/* Shown for as long as SOME document is open (see
          * `showOutline`) — not just Markdown ones — so switching tabs
          * never shifts the sections below under the pointer; a file
          * that cannot have an outline says so in the empty note. It
          * carries the dock's mt-auto anchor; the dock reads outline →
          * Library → account, each a fixed block with a top hairline
          * (they sit flush, so whitespace cannot separate them here).
          * The expanded list is the Library treatment — a capped
          * internal scroller, not a growing section. */}
        {showOutline && (
        <section className="mt-auto flex flex-none flex-col overflow-hidden border-t border-border">
          {/* Same narrow tinted strip as the Library header below. */}
          <div className="group/outline flex min-h-[26px] items-center justify-between gap-1.5 bg-muted/45 pr-2 pl-3.5">
            {/* A disclosure HEADING, which is what this strip has always
              * been — so the heading element wraps the toggle rather than
              * the label being a bold-ish span inside it, and the sidebar
              * finally has an outline a screen reader can skim. `font-normal`
              * holds the deliberate look below: the tinted band is what says
              * "header" here, and weight on top made the bottom dock the
              * heaviest ink in a quiet sidebar. */}
            <SectionHeading level={2} className="flex min-w-0 flex-1 font-normal">
            <button type="button" className={sectionToggleClass} aria-expanded={outlineExpanded} aria-controls="sidebar-outline-section" onClick={() => setOutlineExpanded((expanded) => !expanded)}>
              {/* Same treatment as the Library header: glyph at rest,
                * fold chevron under the pointer. */}
              <span className="inline-flex size-4 flex-none items-center justify-center">
                <OutlineIcon className="size-3.5 group-hover/outline:hidden" />
                <span className={cn('hidden items-center justify-center transition-transform duration-fast group-hover/outline:inline-flex [&_svg]:size-3.5', !outlineExpanded && '-rotate-90')}><ChevronDownIcon /></span>
              </span>
              {/* text-base — the SAME size as the rows: with the app-wide
                * icons beside them, a smaller label reads shrunken rather
                * than subordinate. Regular weight, not medium: this label
                * sits on its own tinted strip, and that band already says
                * "header" — weight on top made the bottom dock's lines the
                * heaviest ink in a quiet sidebar. */}
              <span className="min-w-0 flex-1 truncate text-base text-muted-foreground">Document Outline</span>
            </button>
            </SectionHeading>
          </div>
          {/* FIXED height (VS Code's outline view), not a content cap:
            * an expanded outline is always the same block, so switching
            * between documents with different heading counts never
            * moves the Library rows below. Same 154px as the Library
            * list's cap — the two dock lists read as one rhythm. */}
          <div id="sidebar-outline-section" className={outlineExpanded ? 'flex h-[154px] min-h-0 flex-col overflow-hidden' : 'hidden'}>
            {hasHeadings ? (
              <LazyLoadBoundary
                className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
                label="document outline"
                resetKey={activeTab?.id ?? 'none'}
              >
                <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">Opening outline…</div>}>
                  <DocumentOutline headings={outline.headings} activeId={outline.activeId} onSelect={outline.onSelect} />
                </Suspense>
              </LazyLoadBoundary>
            ) : (
              /* Inline, so a permanently-visible empty block never pulls
                * in the lazy outline chunk — that loads only once a real
                * outline exists. ml-[38px] is the shared label gutter. */
              <p className="my-1 mr-3 ml-[38px] text-sm text-muted-foreground">
                {hasMarkdownDocument ? 'No headings' : 'No outline for this file'}
              </p>
            )}
          </div>
        </section>
        )}
      </ActiveFolderSection>
      {/* Authorization for search by meaning is APP-WIDE, not a property of the
        * open folder, so it sits in the bottom chrome above the account
        * row rather than inside the file tree. Wedged between a folder header
        * and its own files it read as a fact about those files, and it
        * pushed the tree — the thing the panel exists for — down the
        * screen for a secondary notice. */}
      {embeddingSetupPossible && (
        <Suspense fallback={null}>
          <EmbeddingSetupCallout />
        </Suspense>
      )}
      {/* No mt-auto here: a dock block above always carries the bottom
        * anchor, and this row simply sits under it. */}
      <Suspense fallback={<div className="h-[45px] flex-none border-t border-border" aria-hidden="true" />}>
        <SidebarAccountRow />
      </Suspense>
    </div>
  );
}

/** The sidebar's folder zone — exactly one of two states, plus the folder
 *  menu and removal dialog they share.
 *
 *  ACTIVE ZONE — when this window has a folder open: the current folder's
 *  header row (explorer toolbar, drop target, ⋯ menu) with its file tree
 *  beneath. It shares the sidebar's one pane surface — the inset pill rows,
 *  not a surface split, carry the hierarchy.
 *
 *  NO-FOLDER ZONE — otherwise: an empty spacer. The way into a folder is
 *  the Choose Folder launcher row in the top group (bare windows only)
 *  and the titlebar Library switcher; membership lives in the switcher,
 *  so the sidebar renders NO list of other member folders.
 *
 *  `children` (the Document Outline section) renders after the zone, which
 *  is what puts it below the working context and above the bottom-most
 *  global chrome. */
function ActiveFolderSection({ children }: { children?: React.ReactNode }) {
  const state = useWorkspace();
  const { actions, dispatch } = useAppActions();
  const semanticNotice = useSemanticIndexingNotice();
  const { pendingRemoval, removing, requestRemoval, cancelRemoval, removeFolder } =
    useFolderRemoval(dispatch, actions.toast);
  const toggleFavorite = useFolderFavorite(dispatch, actions.toast);
  const { canOpenInNewWindow, openInNewWindow } = useOpenFolderWindow(actions.toast);
  const isCurrent = useCallback(
    (path: string) => !!state.folderPath && folderRefsEqual(state.folderPath, path),
    [state.folderPath],
  );

  const activePath = state.folderPath;

  // Background reconcile covers every non-current member — membership is
  // no longer rendered as rows, and recovery must not depend on what is
  // on screen, so this loop runs unconditionally.
  const otherRootPathsKey = state.recent
    .filter((entry) => !isCurrent(entry.path))
    .map((entry) => entry.path)
    .join('\n');

  useLibraryReconcile(true, otherRootPathsKey);

  const removeTarget = pendingRemoval
    ? removalDialogTarget(pendingRemoval, state.homeDir ?? '')
    : null;

  const activeName = activePath ? basename(activePath) : '';
  const activeFavorite = !!activePath
    && !!state.recent.find((r) => folderRefsEqual(r.path, activePath))?.favorite;

  return (
    <>
      {activePath ? (
        /* ACTIVE ZONE — the window's current folder. It takes ALL the
         * room the bottom dock leaves (flex-1) and scrolls the tree
         * internally; a content-height cap would strand blank space
         * between the tree and the dock. Same quiet pane surface as the
         * rest of the sidebar — the pill rows carry the hierarchy, so no
         * hairline or surface split. */
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ActiveFolderHeader
            name={activeName}
            path={activePath}
            favorite={activeFavorite}
            canOpenInNewWindow={canOpenInNewWindow}
            onToggleFavorite={() => toggleFavorite(activePath)}
            onOpenInNewWindow={() => openInNewWindow(activePath)}
            onRemove={() => requestRemoval(activePath)}
          />
          {/* Collapsing hides the list but leaves the `expanded` set in
            * state untouched, so re-expanding restores every inner
            * folder's prior open/closed state. */}
          {!state.folderCollapsed && (
            <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {semanticNotice && (
                <Suspense fallback={null}>
                  <SemanticIndexingNoticeView {...semanticNotice} />
                </Suspense>
              )}
              <FileTree />
            </div>
          )}
        </section>
      ) : (
        /* NO-FOLDER ZONE — deliberately empty: the add-folder flows live
         * in the top launcher group's Choose Folder row and in the
         * titlebar Library switcher, so this zone carries no second
         * launcher column. The spacer keeps the chat group pinned to the
         * top of the column. */
        <section aria-hidden className="min-h-0 flex-1" />
      )}
      {children}
      {removeTarget && (
        <RemoveFolderModal
          name={removeTarget.name}
          path={removeTarget.path}
          pathLabel={removeTarget.displayPath}
          removing={removing}
          onCancel={cancelRemoval}
          onConfirm={() => removeFolder(removeTarget.path)}
        />
      )}
    </>
  );
}

/** What the remove-folder confirm modal names: the folder plus its complete,
 *  home-shortened path, so the location that stays on disk is unambiguous. */
export function removalDialogTarget(
  path: string,
  homeDir: string,
): { path: string; name: string; displayPath: string } {
  return { path, name: basename(path), displayPath: shortenFolderPath(path, homeDir) };
}

/** The active zone's header row — the window's current folder. Carries the
 *  classic explorer toolbar (new note / new folder / sync / fold) plus the
 *  same ⋯ folder menu as the library rows. The `#sideHead` id and
 *  `drop-target` state class stay CSS-driven: `useGlobalDragDrop` toggles
 *  `drop-target` imperatively on #sideHead, sharing the tree's exempted
 *  drop styling (see common/styles/tree.css). The header carries no persistent
 *  selected surface — its position above the tree already marks it as the
 *  current folder. */
function ActiveFolderHeader({
  name,
  path,
  favorite,
  canOpenInNewWindow,
  onToggleFavorite,
  onOpenInNewWindow,
  onRemove,
}: {
  name: string;
  path: string;
  favorite: boolean;
  canOpenInNewWindow: boolean;
  onToggleFavorite: () => void;
  onOpenInNewWindow: () => void;
  onRemove: () => void;
}) {
  const state = useWorkspace();
  const { actions, dispatch } = useAppActions();
  const [sideHeadDrop, setSideHeadDrop] = useState(false);
  // The ⋯ menu open: hold the hover-revealed action cluster visible
  // while its portalled popover is up.
  const [menuOpen, setMenuOpen] = useState(false);

  function onSideHeadDragOver(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(FILE_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    setSideHeadDrop(true);
  }
  function onSideHeadDragLeave() { setSideHeadDrop(false); }
  function onSideHeadDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setSideHeadDrop(false);
    const internal = e.dataTransfer.getData(FILE_MIME);
    if (internal) {
      void actions.moveFile(internal, '');
    }
    // External imports are handled by the global drop listener which
    // computes its target from the cursor's `.tree-row.folder` /
    // `#sideHead` closest. We don't double-handle here.
  }

  return (
    <div
      id="sideHead"
      className={cn(
        /* pr-0.5 (not pr-1): with the row's mx-1.5 that lands the action
         * cluster on the same 8px right inset as the Library header and
         * its rows, so every action icon in the sidebar shares one
         * column. */
        'side-head group/head mx-1.5 flex min-h-7 flex-none items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 hover:bg-muted',
        sideHeadDrop && 'drop-target',
      )}
      onDragOver={onSideHeadDragOver}
      onDragLeave={onSideHeadDragLeave}
      onDrop={onSideHeadDrop}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 text-foreground">
        {/* Chevron at rest, rotating with the fold state — the SAME
          * disclosure mark every folder row below wears, so the header is
          * not the odd one out. Folder identity is carried by the name
          * (and the titlebar switcher), not by a glyph. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-4 flex-none rounded-sm p-0 text-muted-foreground hover:bg-transparent"
          aria-label={`${state.folderCollapsed ? 'Expand' : 'Collapse'} files in ${name}`}
          aria-expanded={!state.folderCollapsed}
          onClick={(e) => { e.stopPropagation(); dispatch({ type: 'FOLDER_FOLD_TOGGLE' }); }}
        >
          <span className={cn('inline-flex items-center justify-center transition-transform duration-fast [&_svg]:size-3.5', state.folderCollapsed && '-rotate-90')}><ChevronDownIcon /></span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-w-0 flex-1 shrink justify-start truncate p-0 text-left text-base font-medium text-foreground hover:bg-transparent hover:text-foreground active:translate-y-0"
          aria-label={`Select ${name} folder root`}
          title={path}
          onClick={(e) => { e.stopPropagation(); dispatch({ type: 'ACTIVE_FOLDER', path: '' }); }}
        >{name}</Button>
        {favorite && (
          /* The label goes on a `role="img"` wrapper, not on the icon: every
            * glyph in `icons.tsx` takes `className` alone and hardcodes
            * `aria-hidden="true"`, so the `aria-label` this used to pass was
            * dropped on the floor and the star announced nothing. TypeScript
            * could not catch it either — it skips excess-property checks on
            * hyphenated JSX attribute names. */
          <span role="img" aria-label="Favorite" className="inline-flex shrink-0">
            <StarIcon className="size-3 fill-current text-muted-foreground" />
          </span>
        )}
      </span>
      {/* Only the high-frequency actions stay on the row — new note and
        * the ⋯ menu (which carries new-folder / sync / fold-all for
        * this folder). Chat history moved to its ONE standing entry in
        * the chat pane's header: sessions are the chat pane's material,
        * and a hover-revealed copy here was a second rule for the same
        * function. */}
      <div className={menuOpen ? 'flex gap-0.5' : sideActionsClass}>
        <NewNoteButton />
        {/* Static ⋯ placeholder while the lazy menu chunk loads — same
          * footprint, so the hover-revealed cluster never shifts. */}
        <Suspense fallback={
          <span className="inline-grid size-6 flex-none place-items-center text-muted-foreground" aria-hidden="true">
            <MoreHorizontalIcon className="size-3.5" />
          </span>
        }>
          <FolderHeaderMenu
            name={name}
            path={path}
            favorite={favorite}
            canOpenInNewWindow={canOpenInNewWindow}
            onOpenChange={setMenuOpen}
            onToggleFavorite={onToggleFavorite}
            onOpenInNewWindow={onOpenInNewWindow}
            onRemove={onRemove}
          />
        </Suspense>
      </div>
    </div>
  );
}

/** "+" icon in the sidebar header that creates a new Markdown note in
 *  the active folder. HTML notes were dropped once their editor went
 *  away, so there's no format picker — one click, one .md draft. */
function NewNoteButton() {
  const state = useWorkspace();
  const { actions } = useAppActions();
  const target = state.activeFolder || state.folder || 'folder root';

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="text-muted-foreground"
      title={'New note in ' + target}
      aria-label={'New note in ' + target}
      onClick={() => void actions.newNote()}
    ><NewFileIcon className="size-3.5" /></Button>
  );
}
