import { useState, type DragEvent } from 'react';
import '@/features/workspace/workspace.css';
import { basename } from '@/common/lib/paths';
import { Button } from '@/common/components/ui/button';
import { cn } from '@/common/lib/utils';
import { useAppActions, useWorkspace } from '@/store/contexts/AppContext';

const TAB_MIME = 'application/x-stashbase-tab';

/**
 * Tab strip at the top of the main pane — one chip per open tab plus a
 * `+` button. Left-click activates, `×` (or middle-click, or Delete on
 * the focused tab) closes, `+` pushes an empty tab (Obsidian-style);
 * Ctrl/Cmd+Shift+Arrow moves the focused tab (keyboard reorder parity
 * with drag). The active tab gets a stronger
 * background; inactive tabs are muted; long names ellipsize. Every tab
 * is persistent — a sidebar click opens a lasting tab, so there is no
 * italic "preview" state or double-click-to-keep promotion.
 *
 * Tabs are draggable: dropping one onto another inserts it before that
 * target (or appends when dropped on the trailing strip area). The
 * dragged tab carries the rendered chip with it; we draw the drop
 * indicator as a `before` vs `after` accent on the target chip so the
 * insertion point is obvious before commit.
 *
 * All state mutations route through `AppContext` actions / dispatch —
 * this component just renders.
 *
 * NOT on the shared `Tabs` primitive, for bundle reasons only — the same
 * exception `ui/menu-radio.tsx` carries. Both other tab sets in the app
 * (Settings sections, the chat session strip) sit behind an interaction
 * boundary and load lazily, so Base UI's `Tabs` costs them nothing. This
 * strip mounts with the window, and putting it on the primitive pulled
 * Base UI's composite/roving-focus machinery into the initial graph:
 * `Tabs*`, `Composite*`, and the `react-dom` + `useOpenChangeComplete`
 * chunks they drag behind them, ~22.7 KB of always-loaded JS measured on
 * the initial-graph walk in `scripts/check-renderer-chunks.mjs`. That is
 * 5% of the whole eager budget for a keyboard contract this file already
 * implemented and shipped. The roles, the roving tabindex, and the
 * arrow/Home/End/Enter/Space handling below are therefore local. Keep
 * them matching what `ui/tabs.tsx` renders — and keep `.tab[data-active]`
 * as the one selection signal so the stylesheet reads the same on both.
 *
 * Arrow keys SELECT as the caret moves, which is `activateOnFocus` in
 * Base UI's vocabulary and is a per-caller decision there rather than a
 * primitive default (Base UI defaults it OFF). The chat session strip
 * opts in for the same reason this strip has always behaved this way —
 * every pane is already mounted, so moving the caret costs nothing.
 * Settings deliberately does NOT: its panels unmount when inactive and
 * each fetches on mount, so arrowing past one would fire a request. Two
 * behaviors, one per cost model; do not "unify" them without reading
 * `ManagedSettingsModal.tsx` first.
 * `features/workspace/__tests__/accessibility-semantics.test.ts` mounts
 * this against a real DOM and asserts that contract.
 *
 * The strip's LOOK is CSS (`.tab*` in workspace.css), because
 * `electron/tab-strip-layout-smoke.cjs` reads that stylesheet raw to
 * assert the close and new-tab controls share a centre line.
 */
export function TabStrip() {
  const state = useWorkspace();
  const { actions, dispatch } = useAppActions();
  const [dragId, setDragId] = useState<string | null>(null);
  // `dropTarget` carries both the target tab id and which side of the
  // chip the cursor is on. Storing this lets us paint the indicator
  // without re-deriving from event coords on every render.
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: 'before' | 'after' } | null>(null);

  function onDragStart(e: DragEvent<HTMLElement>, id: string) {
    e.dataTransfer.effectAllowed = 'move';
    // setData is required for Firefox to fire any subsequent drag events.
    try { e.dataTransfer.setData(TAB_MIME, id); } catch { /* unwriteable in some test envs */ }
    setDragId(id);
  }

  function onDragEnd() {
    setDragId(null);
    setDropTarget(null);
  }

  function onTabDragOver(e: DragEvent<HTMLElement>, targetId: string) {
    if (!dragId) return;
    if (dragId === targetId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // Edge based on cursor position relative to the chip — left half =
    // insert before, right half = insert after. Cheap getBoundingClientRect.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const edge: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    if (dropTarget?.id !== targetId || dropTarget.edge !== edge) {
      setDropTarget({ id: targetId, edge });
    }
  }

  function onTabDrop(e: DragEvent<HTMLElement>, targetId: string) {
    if (!dragId) return;
    e.preventDefault();
    // Without this the drop bubbles to onStripDrop, whose `dragId` closure
    // still holds this render's value (setDragId(null) lands next render),
    // so it would re-dispatch TABS_REORDER with beforeId:null (append).
    e.stopPropagation();
    if (dragId === targetId) { onDragEnd(); return; }
    const tabs = state.tabs;
    const targetIdx = tabs.findIndex((t) => t.id === targetId);
    let beforeId: string | null;
    if (dropTarget?.edge === 'after') {
      beforeId = tabs[targetIdx + 1]?.id ?? null;
    } else {
      beforeId = targetId;
    }
    dispatch({ type: 'TABS_REORDER', id: dragId, beforeId });
    onDragEnd();
  }

  function onStripDragOver(e: DragEvent<HTMLElement>) {
    // Allow drop on the trailing empty area of the strip — interpret as
    // "append to the end". We only react when the drag is actually a
    // tab (dragId set), so external file drags fall through.
    if (!dragId) return;
    e.preventDefault();
  }

  /** Close a tab from its keyboard (Delete / middle-click parity) or ×
   *  paths, keeping focus in the strip: the neighbour that slides into
   *  the closed tab's slot takes it (previous one when the last tab
   *  closes; nothing when the strip empties). `closeTab` already owns
   *  which tab becomes ACTIVE — this only parks the caret. */
  function closeTabKeepingFocus(id: string) {
    const index = state.tabs.findIndex((tab) => tab.id === id);
    const neighbour = state.tabs[index + 1] ?? state.tabs[index - 1];
    void actions.closeTab(id);
    if (neighbour) {
      requestAnimationFrame(() => document.getElementById(`document-tab-${neighbour.id}`)?.focus());
    }
  }

  /** Keyboard parity for drag-to-reorder: move the focused tab one slot
   *  left/right through the same TABS_REORDER action the drop path
   *  dispatches, and keep focus (and selection state) on the moved tab. */
  function reorderTab(id: string, direction: -1 | 1) {
    const tabs = state.tabs;
    const current = tabs.findIndex((tab) => tab.id === id);
    const target = current + direction;
    if (current < 0 || target < 0 || target >= tabs.length) return;
    // Moving right past one neighbour = insert before the tab AFTER that
    // neighbour (or append at the end); moving left = insert before it.
    const beforeId = direction === 1 ? tabs[target + 1]?.id ?? null : tabs[target].id;
    dispatch({ type: 'TABS_REORDER', id, beforeId });
    requestAnimationFrame(() => document.getElementById(`document-tab-${id}`)?.focus());
  }

  // TODO(09⏳02 b/c): drag-to-split (drop a tab on the right edge of the
  // main pane → vertical split) and drag-to-window (drag a tab out →
  // spawn a new window). Both couple to multi-window state; only the
  // in-strip reorder (a) is implemented here.
  function onStripDrop(e: DragEvent<HTMLElement>) {
    if (!dragId) return;
    // Drops on a tab chip are handled (and stopPropagation'd) by onTabDrop;
    // this only fires for the trailing empty area → append to the end.
    e.preventDefault();
    dispatch({ type: 'TABS_REORDER', id: dragId, beforeId: null });
    onDragEnd();
  }

  return (
    /* Layout metrics live in .tab-strip / .tab-strip-inner CSS —
     * electron/tab-strip-layout-smoke.cjs consumes workspace.css raw.
     * `.tab-strip` IS the strip row: the scrolling tab list and the
     * New-tab control are its two children, so the control stays put
     * while the list scrolls under it. */
    <div className="tab-strip">
      <div
        className="tab-strip-inner"
        role="tablist"
        aria-label="Open documents"
        onDragOver={onStripDragOver}
        onDrop={onStripDrop}
      >
        {state.tabs.map((t) => {
          const isActive = t.id === state.activeTabId;
          // Tab label = the file's basename, extension included (`note.md`,
          // not `note`) — the suffix keeps `.md` vs `.html` vs `.pdf` tabs
          // unambiguous at a glance.
          const label = t.file ? basename(t.file.name) : 'Untitled';
          const isDragging = dragId === t.id;
          const dropEdge = dropTarget?.id === t.id ? dropTarget.edge : null;
          return (
            /* A <div>, not a <button>: the chip carries its own close
             * button and a <button> cannot nest one. The tab role, the
             * roving tabindex, and Enter/Space activation are supplied
             * below — and the drag handlers have always hung here. */
            <div
              key={t.id}
              className={cn(
                // Everything the chip looks like is `.tab` in workspace.css.
                'tab',
                isDragging && 'dragging',
                dropEdge === 'before' && 'drop-before',
                dropEdge === 'after' && 'drop-after',
              )}
              // Explicit ids: the panel is MainPane's single
              // `#document-panel`, and it names the active tab back
              // through this id.
              id={`document-tab-${t.id}`}
              role="tab"
              // The stylesheet's one selection signal, spelled the way
              // Base UI spells it in `ui/tabs.tsx` so `.tab[data-active]`
              // means the same thing on every tab set in the app.
              data-active={isActive ? '' : undefined}
              aria-selected={isActive}
              aria-controls="document-panel"
              // Delete closes the focused tab (APG deletable-tabs
              // pattern) — the × below is pointer chrome only, so this
              // is the closability the tab itself advertises.
              aria-keyshortcuts="Delete"
              tabIndex={isActive ? 0 : -1}
              draggable
              title={t.file ? (t.file.folder ? `${t.file.folder}/${t.file.name}` : t.file.name) : 'Empty tab'}
              onClick={() => { void actions.activateTab(t.id); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void actions.activateTab(t.id);
                  return;
                }
                // Delete closes the focused tab — the pointer-only ×
                // is hidden from the accessibility tree, so this is the
                // keyboard close path.
                if (e.key === 'Delete') {
                  e.preventDefault();
                  closeTabKeepingFocus(t.id);
                  return;
                }
                // Ctrl/Cmd+Shift+Arrow REORDERS (keyboard parity with
                // drag); plain arrows keep navigating below.
                if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                  e.preventDefault();
                  reorderTab(t.id, e.key === 'ArrowRight' ? 1 : -1);
                  return;
                }
                if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault();
                // Moving the caret SELECTS as it goes — `activateOnFocus`
                // in Base UI's vocabulary. The strip has always worked
                // this way; focus-only movement would be a downgrade.
                const current = state.tabs.findIndex((tab) => tab.id === t.id);
                const next = e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? state.tabs.length - 1
                    : (current + (e.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length;
                const nextTab = state.tabs[next];
                if (!nextTab) return;
                void actions.activateTab(nextTab.id);
                requestAnimationFrame(() => document.getElementById(`document-tab-${nextTab.id}`)?.focus());
              }}
              onAuxClick={(e) => {
                // Middle-click closes — matches browser tab behavior.
                if (e.button === 1) {
                  e.preventDefault();
                  void actions.closeTab(t.id);
                }
              }}
              onDragStart={(e) => onDragStart(e, t.id)}
              onDragEnd={onDragEnd}
              onDragOver={(e) => onTabDragOver(e, t.id)}
              onDragLeave={() => {
                // Only clear when the leaving tab was our last target —
                // otherwise transitioning between adjacent tabs would
                // flicker the indicator off and back on.
                if (dropTarget?.id === t.id) setDropTarget(null);
              }}
              onDrop={(e) => onTabDrop(e, t.id)}
            >
              <span className="tab-label">{label}</span>
              {/* Pointer-only chrome, removed from the accessibility
                * tree ON PURPOSE: `role="tab"` treats its children as
                * presentational, so an interactive Button in here was a
                * phantom second tab stop inside the tablist that some
                * AT surfaced and some flattened. Keyboard/AT users close
                * the FOCUSED TAB with Delete (see onKeyDown above, and
                * the tab's aria-keyshortcuts); mouse users keep the ×
                * and its tooltip. */}
              <Button
                variant="ghost"
                size="icon-xs"
                className="tab-close font-normal"
                title={`Close ${label}`}
                aria-hidden="true"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  void actions.closeTab(t.id);
                }}
              >×</Button>
            </div>
          );
        })}
      </div>
      {/* Outside the tablist, deliberately. A `role="tablist"` owns tabs and
        * nothing else, so a New-tab button among them is announced as part
        * of the tab set. Moving it out also delivers what its CSS comment
        * always claimed: inside `.tab-strip-inner` it was a child of the
        * horizontal SCROLLER, so it scrolled away with the tabs it was
        * supposed to stay pinned beside. */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="tab-new font-normal"
        title="New tab"
        aria-label="New tab"
        onClick={() => { void actions.newTab(); }}
      >+</Button>
    </div>
  );
}
