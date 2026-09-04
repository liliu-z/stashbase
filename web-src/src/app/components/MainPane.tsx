import { useEffect, useState } from 'react';
import { EditIcon, PreviewIcon } from '@/common/components/icons';
import { useAppActions, useWorkspace } from '@/store/contexts/AppContext';
import { DocumentViewer } from '@/features/documents';
import { EmptyTabLanding, TabStrip } from '@/features/workspace';
import { FindBar } from '@/features/search';
import { readPreferredAgent } from '@/common/lib/agentPreference';
import { electronBridge } from '@/common/lib/electronBridge';
import { basename } from '@/common/lib/paths';
import { Button } from '@/common/components/ui/button';
import { StatusMessage } from '@/common/components/ui/status';
import { cn } from '@/common/lib/utils';

/**
 * Right rail. Layout from top to bottom:
 *   • TabStrip                   (when any tab is open)
 *   • main-body                  (preview / md editor / empty-tab landing)
 *   • absolute-positioned chrome (top-right, `top-chrome` to clear the
 *     tab strip): the md edit toggle + save status, and the PDF control
 *     slot. `top-chrome-banner` is the same offset plus the out-of-folder
 *     identity banner; both are derived from one token (globals.css).
 *
 * When there are no tabs at all, `.main.no-file > *` hides every child so
 * the pane is a clean canvas.
 */
export function MainPane({ workspaceHidden = false }: { workspaceHidden?: boolean }) {
  const state = useWorkspace();
  const { activeTab } = state;
  const { actions } = useAppActions();
  const cur = activeTab?.file ?? null;
  const editMode = activeTab?.editMode ?? false;
  const saveStatus = activeTab?.saveStatus ?? { text: '', cls: '' };
  // "Saved" is a tick, not a standing state: fade it out shortly after it
  // lands (the store keeps the status for tab dots and tests; this is
  // presentation only). Everything else — Saving…, Unsaved, errors —
  // stays visible for as long as the store says so.
  const [saveTickVisible, setSaveTickVisible] = useState(true);
  useEffect(() => {
    setSaveTickVisible(true);
    if (saveStatus.cls !== 'saved') return;
    const timer = setTimeout(() => setSaveTickVisible(false), 2000);
    return () => clearTimeout(timer);
  }, [saveStatus.cls, saveStatus.text, state.activeTabId]);
  const hasTabs = state.tabs.length > 0;
  const emptyTab = !!activeTab && !cur;
  // Out-of-folder tab (a library search hit viewed without switching the
  // window's folder): a quiet identity banner with the one escape hatch —
  // open that folder in its own window.
  const outOfFolder = cur?.folder ?? null;
  function openTabFolderInNewWindow() {
    if (!outOfFolder) return;
    void (async () => {
      const opened = await electronBridge()?.openFolderWindow?.(outOfFolder);
      if (!opened) actions.toast('New window is only available in the desktop app.', { level: 'error' });
    })();
  }
  // The edit toggle (read/write swap plus the save tick) — Markdown, JSON
  // and .txt own their content, so they get it; a generic code file is
  // read-only by product rule and never does.
  const showsEditToggle = !!cur
    && (cur.format === 'md' || cur.format === 'json' || cur.format === 'txt')
    && !cur.folder
    && !cur.error
    && !activeTab?.conflict;

  // Reserve room for the absolute-positioned chrome (edit toggle / PDF
  // controls / the Untitled strip at `top-chrome`, height 24px) so editor
  // / preview content doesn't render underneath it.
  //
  // Derived from whether chrome ACTUALLY renders, not from a list of
  // formats that usually have some. A blocklist reserved the band for
  // every viewer except HTML and image, so a read-only code file — which
  // renders no top chrome at all — opened under 32px of empty `--bg`
  // white sitting on top of the editor's `--pane` surface: a bright strip
  // between the tab strip and the code, marking out a control row that
  // was never there.
  //
  // 32px is the floor, not a taste call. The chrome starts at
  // --chrome-top (44px at the default interface size) while the tab strip
  // above it grows with that preference (35.7 / 37.6 / 40.4px) — 44 is
  // already as high as the chrome can start without the largest strip
  // covering it, so the band has to span 44 - 35.7 + 24. Every control
  // that lives in it is therefore 24px; put a 28px one back and it hangs
  // into the document.
  const chromeBand = hasTabs && (showsEditToggle || cur?.format === 'pdf' || emptyTab);

  return (
    <main
      className={cn('main', !hasTabs && 'no-file', cur && `fmt-${cur.format}`)}
      aria-hidden={workspaceHidden || undefined}
      inert={workspaceHidden || undefined}
    >
      {hasTabs && <TabStrip />}
      {outOfFolder && (
        /* Full-width identity strip flush under the tab strip (the DOCX
         * status-row idiom). The absolute chrome below shifts down past it
         * (see chromeTop). */
        <StatusMessage tone="info" className="z-chrome flex min-h-8 shrink-0 items-center gap-2.5 rounded-none border-x-0 border-t-0 px-3.5 py-1.5">
          <span className="min-w-0 flex-1 truncate">
            In <span className="font-semibold">{basename(outOfFolder)}</span> — viewing a file outside the current folder.
          </span>
          <Button variant="outline" size="xs" className="shrink-0" onClick={openTabFolderInNewWindow}>
            Open Folder in New Window
          </Button>
        </StatusMessage>
      )}
      {/* Content host for every viewer (iframe preview / split editor).
        * Single-cell grid because a Chromium quirk: when an iframe with
        * `position: absolute; inset: 0` sits inside a flex child, its
        * internal initial-containing-block resolves to 0×0 — the iframe
        * ELEMENT renders at full size but everything inside it (`<html>`,
        * `<body>`, the user's content) lays out at zero. Grid cells give
        * children a definite size unambiguously, sidestepping that bug.
        * The `main-body` class itself is the structural hook for
        * `.main.no-file > :not(.main-body)` in workspace.css. */}
      <div
        className={cn('main-body grid min-h-0 min-w-0 flex-1 grid-cols-[1fr] grid-rows-[1fr] overflow-hidden', chromeBand && 'pt-8')}
        role={activeTab ? 'tabpanel' : undefined}
        id={activeTab ? 'document-panel' : undefined}
        aria-labelledby={activeTab ? `document-tab-${activeTab.id}` : undefined}
      >
        {!hasTabs && !state.folderPath && (
          /* Bare window with no open document (chat leads the layout;
           * this pane only shows once the chat panel is hidden). The
           * Library switcher and the chat's Templates gallery own the
           * add-folder actions — this stays a quiet pointer. */
          <div className="grid h-full place-items-center p-10 text-center text-base text-muted-foreground">
            <p className="m-0 leading-loose">Open a folder from the Library switcher to get started.</p>
          </div>
        )}
        {!hasTabs && !!state.folderPath && (
          <div className="grid h-full place-items-center p-10 text-center text-base text-muted-foreground">
            <div>
              <p className="m-0 leading-loose">Start a conversation or choose a document from Files.</p>
              <div className="mt-3.5 flex justify-center gap-2">
                <Button onClick={() => actions.openAgent(readPreferredAgent())}>
                  Start chat
                </Button>
                <Button
                  variant="outline"
                  onClick={() => window.dispatchEvent(new Event('stashbase-open-quick-open'))}
                >
                  Open document
                </Button>
              </div>
              <p className="mt-3.5 mb-0 leading-loose">
                Drop files or folders anywhere to stash them, or click{' '}
                {/* Inline ghost-accent "+" — a small rounded-square add-button
                  * so the sentence reads as unmistakably clickable. `pb`
                  * optically lifts the low-sitting "+" glyph to centre.
                  *
                  * The Button primitive with an accent tint over it: the
                  * className carries only the surface's own decisions (an
                  * inline box that sizes off the sentence it sits in, and
                  * the accent palette), while the press scale, the focus
                  * ring, and the transition come from the recipe — which is
                  * what this button was missing while it was hand-rolled. */}
                <Button
                  variant="ghost"
                  size="xs"
                  className="mx-1 size-[1.5em] cursor-pointer rounded-sm border-accent p-0 pb-[0.14em] align-middle leading-none text-accent hover:bg-accent/10 hover:text-accent dark:hover:bg-accent/10 [font-size:inherit]"
                  /* Same naming rule as the sidebar's NewNoteButton — a bare
                   * "+" announces nothing. */
                  aria-label={'New note in ' + (state.activeFolder || state.folder || 'folder root')}
                  onClick={() => { void actions.newNote(); }}
                >+</Button>{' '}
                for a new note.
              </p>
            </div>
          </div>
        )}
        {emptyTab && <EmptyTabLanding />}
        {/* One Documents surface, whatever the open file is. Which viewer
          * a format gets, and which of them load lazily, is the Documents
          * feature's business — this pane only supplies the tab state and
          * the cell to fill. */}
        <DocumentViewer
          tabs={state.tabs}
          activeTab={activeTab}
          activeTabId={state.activeTabId}
          editorHistory={state.editorHistory}
        />
      </div>
      {emptyTab && (
        // Centered placeholder strip for an empty (Untitled) tab —
        // absolute + 50% transform centers it relative to .main, in the
        // same slot a breadcrumb path would occupy.
        <div className="absolute top-chrome left-1/2 z-chrome flex h-6 max-w-[calc(100%-220px)] -translate-x-1/2 items-center overflow-hidden text-base whitespace-nowrap text-muted-foreground">
          <span className="px-1 py-0.5">Untitled</span>
        </div>
      )}
      <FindBar />
      {showsEditToggle && (
        /* Floating actions in the main pane's top-right — sits below the
         * tab strip (unconditionally present whenever there's an open
         * file, so a fixed offset is safe). The edit toggle lives here on
         * its own; the save status tucks in next to it while editing. */
        <div className="absolute top-chrome right-3.5 z-chrome flex items-center gap-2">
          {editMode && saveStatus.text && (
            /* "Saved" / "Renaming…" share the default muted grey — green
             * felt too celebratory for a routine autosave tick. Errors
             * turn red so they break the visual rhythm. */
            /* `role="status"` (an implicit polite live region): the save
             * tick — and more importantly a save ERROR — is otherwise
             * invisible to a screen reader mid-edit. Styling unchanged. */
            <span role="status" className={cn('text-sm transition-opacity duration-standard', saveStatus.cls === 'error' ? 'text-destructive' : 'text-muted-foreground', saveStatus.cls === 'saved' && !saveTickVisible && 'opacity-0')}>
              {saveStatus.text}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            title={editMode ? 'Switch to Reading View' : 'Switch to Live Editing'}
            aria-label={editMode ? 'Switch to Reading View' : 'Switch to Live Editing'}
            onClick={() => { void actions.toggleEditMode(); }}
          >
            {/* Read mode → edit icon, edit mode → preview icon (eye), so
              * the button always shows the action it does. The pencil
              * glyph's artwork fills nearly its whole 24×24 viewBox while
              * the preview glyph leaves more margin — scale it down to
              * match the preview's optical size (layout box unchanged). */}
            {editMode ? <PreviewIcon /> : <EditIcon className="scale-85" />}
          </Button>
        </div>
      )}
      {cur && cur.format === 'pdf' && (
        // Slot that PdfPreview portals its zoom / page-count chrome
        // into — sits on the same row as back/forward + breadcrumb
        // so we don't waste a row on viewer chrome. The out-of-folder
        // banner pushes the slot down when present, onto the second of
        // the two shared chrome offsets.
        <div
          className={cn('pointer-events-none absolute right-3.5 left-3.5 z-chrome flex items-center justify-stretch gap-2', outOfFolder ? 'top-chrome-banner' : 'top-chrome')}
          id="pdf-chrome-slot"
        />
      )}
    </main>
  );
}
