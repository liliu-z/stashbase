import { useRef, useState, type DragEvent } from 'react';
import { basename } from '../lib/paths';
import { useApp } from '../store/AppContext';

const TAB_MIME = 'application/x-stashbase-tab';

/**
 * Tab strip at the top of the main pane — one chip per open tab plus a
 * `+` button. Left-click activates, `×` (or middle-click) closes, `+`
 * pushes an empty tab (Obsidian-style). The active tab gets a stronger
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
 */
export function TabStrip() {
  const { state, actions, dispatch } = useApp();
  const [dragId, setDragId] = useState<string | null>(null);
  // `dropTarget` carries both the target tab id and which side of the
  // chip the cursor is on. Storing this lets us paint the indicator
  // without re-deriving from event coords on every render.
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: 'before' | 'after' } | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  function onDragStart(e: DragEvent<HTMLDivElement>, id: string) {
    e.dataTransfer.effectAllowed = 'move';
    // setData is required for Firefox to fire any subsequent drag events.
    try { e.dataTransfer.setData(TAB_MIME, id); } catch { /* unwriteable in some test envs */ }
    setDragId(id);
  }

  function onDragEnd() {
    setDragId(null);
    setDropTarget(null);
  }

  function onTabDragOver(e: DragEvent<HTMLDivElement>, targetId: string) {
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

  function onTabDrop(e: DragEvent<HTMLDivElement>, targetId: string) {
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

  function onStripDragOver(e: DragEvent<HTMLDivElement>) {
    // Allow drop on the trailing empty area of the strip — interpret as
    // "append to the end". We only react when the drag is actually a
    // tab (dragId set), so external file drags fall through.
    if (!dragId) return;
    e.preventDefault();
  }

  // TODO(09⏳02 b/c): drag-to-split (drop a tab on the right edge of the
  // main pane → vertical split) and drag-to-window (drag a tab out →
  // spawn a new window). Both couple to multi-window state; only the
  // in-strip reorder (a) is implemented here.
  function onStripDrop(e: DragEvent<HTMLDivElement>) {
    if (!dragId) return;
    // Drops on a tab chip are handled (and stopPropagation'd) by onTabDrop;
    // this only fires for the trailing empty area → append to the end.
    e.preventDefault();
    dispatch({ type: 'TABS_REORDER', id: dragId, beforeId: null });
    onDragEnd();
  }

  return (
    /* Layout metrics live in .tab-strip / .tab-strip-inner CSS —
     * electron/tab-strip-layout-smoke.cjs consumes mainpane.css raw. */
    <div className="tab-strip">
      <div
        className="tab-strip-inner"
        role="tablist"
        aria-label="Open documents"
        ref={stripRef}
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
          const cls = 'tab'
            + (isActive ? ' active' : '')
            + (isDragging ? ' dragging' : '')
            + (dropEdge === 'before' ? ' drop-before' : '')
            + (dropEdge === 'after' ? ' drop-after' : '');
          return (
            <div
              key={t.id}
              className={cls}
              id={`document-tab-${t.id}`}
              role="tab"
              aria-selected={isActive}
              aria-controls="document-panel"
              tabIndex={isActive ? 0 : -1}
              draggable
              title={t.file ? (t.file.isExternal ? t.file.absolutePath : (t.file.folder ? `${t.file.folder}/${t.file.name}` : t.file.name)) : 'Empty tab'}
              onClick={() => { void actions.activateTab(t.id); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void actions.activateTab(t.id);
                  return;
                }
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault();
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
              <button
                type="button"
                className="tab-close"
                title="Close tab"
                aria-label={`Close ${label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void actions.closeTab(t.id);
                }}
              >×</button>
            </div>
          );
        })}
        <button
          type="button"
          className="tab-new"
          title="New tab"
          onClick={() => { void actions.newTab(); }}
        >+</button>
      </div>
    </div>
  );
}
