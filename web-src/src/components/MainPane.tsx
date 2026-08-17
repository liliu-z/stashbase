import { Suspense } from 'react';
import { EditIcon, PreviewIcon } from '../icons';
import { useApp } from '../store/AppContext';
import { EmptyTabLanding } from './EmptyTabLanding';
import { FindBar } from './FindBar';
import { HtmlPreview } from './HtmlPreview';
import { ImagePreview } from './ImagePreview';
import { TabStrip } from './TabStrip';
import { LazyLoadBoundary, lazyWithRetry } from './ErrorBoundary';
import { readPreferredAgent } from '../agentPreference';
import { retainedMarkdownTabs } from '../milkdown/retainedTabs';
import { electronBridge } from '../electronBridge';
import { basename } from '../lib/paths';
import { Button } from './ui/button';
import { StatusMessage } from './ui/status';

/** Muted "Loading…" bodies shared by the lazy viewer fallbacks. */
const VIEWER_LOADING_CLASS = 'p-4 text-base text-muted-foreground';
const VIEWER_PADDED_LOADING_CLASS = 'p-6 text-base text-muted-foreground';
const VIEWER_CENTERED_LOADING_CLASS = 'grid h-full place-items-center text-base text-muted-foreground';

const LazyCrepeDocument = lazyWithRetry(() => import('./CrepeDocument').then((mod) => ({ default: mod.CrepeDocument })));
const LazyPdfPreview = lazyWithRetry(() => import('./PdfPreview').then((mod) => ({ default: mod.PdfPreview })));
const LazyDocxPreview = lazyWithRetry(() => import('./DocxPreview').then((mod) => ({ default: mod.DocxPreview })));
const LazyAudioPreview = lazyWithRetry(() => import('./AudioPreview').then((mod) => ({ default: mod.AudioPreview })));
const LazyJsonDocument = lazyWithRetry(() => import('./JsonDocument').then((mod) => ({ default: mod.JsonDocument })));
const LazyConflictResolver = lazyWithRetry(() => import('./ConflictResolver').then((mod) => ({ default: mod.ConflictResolver })));

/**
 * Right rail. Layout from top to bottom:
 *   • TabStrip                   (when any tab is open)
 *   • main-body                  (preview / md editor / empty-tab landing)
 *   • absolute-positioned chrome (top-right, `top: 44px` to clear the tab
 *     strip): the md edit toggle + save status, and the PDF control slot.
 *
 * When there are no tabs at all, `.main.no-file > *` hides every child so
 * the pane is a clean canvas.
 */
export function MainPane({ workspaceHidden = false }: { workspaceHidden?: boolean }) {
  const { state, actions, activeTab } = useApp();
  const cur = activeTab?.file ?? null;
  const editMode = activeTab?.editMode ?? false;
  const saveStatus = activeTab?.saveStatus ?? { text: '', cls: '' };
  const hasTabs = state.tabs.length > 0;
  const emptyTab = !!activeTab && !cur;
  const resourceResetKey = cur ? `${cur.folder ?? ''}:${cur.grantId ?? ''}:${cur.name}:${cur.version ?? ''}` : undefined;
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
  // Reserve room for the absolute-positioned chrome (edit toggle / PDF
  // controls / floating-actions at top:44px, height 24px) so editor /
  // preview content doesn't render underneath it. HTML / image viewers
  // have no top chrome, so they skip the band and fill from just under
  // the tab strip.
  //
  // 32px is the floor, not a taste call. The chrome sits at a fixed
  // top:44px while the tab strip above it grows with the interface-size
  // preference (35.7 / 37.6 / 40.4px) — 44 is already as high as the
  // chrome can start without the largest strip covering it, so the band
  // has to span 44 - 35.7 + 24. Every control that lives in it is
  // therefore 24px; put a 28px one back and it hangs into the document.
  const chromeBand = hasTabs && cur?.format !== 'html' && cur?.format !== 'image';
  const markdownTabs = retainedMarkdownTabs(state.tabs, state.editorHistory, state.activeTabId);

  return (
    <main
      className={'main' + (hasTabs ? '' : ' no-file') + (cur ? ' fmt-' + cur.format : '')}
      aria-hidden={workspaceHidden || undefined}
      inert={workspaceHidden || undefined}
    >
      {hasTabs && <TabStrip />}
      {outOfFolder && (
        /* Full-width identity strip flush under the tab strip (the DOCX
         * status-row idiom). The absolute chrome below shifts down past it
         * (see chromeTop). */
        <StatusMessage tone="info" className="z-5 flex min-h-8 shrink-0 items-center gap-2.5 rounded-none border-x-0 border-t-0 px-3.5 py-1.5">
          <span className="min-w-0 flex-1 truncate">
            In <span className="font-semibold">{basename(outOfFolder)}</span> — viewing a file outside the current folder.
          </span>
          <Button variant="outline" size="xs" className="shrink-0" onClick={openTabFolderInNewWindow}>
            Open Folder in New Window
          </Button>
        </StatusMessage>
      )}
      {cur?.isExternal && (
        <StatusMessage tone="info" className="z-5 flex min-h-8 shrink-0 items-center gap-2.5 rounded-none border-x-0 border-t-0 px-3.5 py-1.5 bg-pane-accent border-border-accent">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">External File</span> — Read-only. Sourced from <span className="font-mono" title={cur.absolutePath}>{cur.absolutePath}</span>
          </span>
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
        * `.main.no-file > :not(.main-body)` in mainpane.css. */}
      <div
        className={'main-body grid min-h-0 min-w-0 flex-1 grid-cols-[1fr] grid-rows-[1fr] overflow-hidden' + (chromeBand ? ' pt-8' : '')}
        role={activeTab ? 'tabpanel' : undefined}
        id={activeTab ? 'document-panel' : undefined}
        aria-labelledby={activeTab ? `document-tab-${activeTab.id}` : undefined}
      >
        {!hasTabs && !state.folderPath && (
          /* No folder open at all (empty library, or an open failure).
           * The sidebar's zero-folder block owns the add-folder action;
           * this pane stays a quiet pointer toward it. */
          <div className="grid h-full place-items-center p-10 text-center text-base text-muted-foreground">
            <p className="m-0 leading-[1.9]">Add a folder from the sidebar to get started.</p>
          </div>
        )}
        {!hasTabs && !!state.folderPath && (
          <div className="grid h-full place-items-center p-10 text-center text-base text-muted-foreground">
            <div>
              <p className="m-0 leading-[1.9]">Start a conversation or choose a document from Files.</p>
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
              <p className="mt-3.5 mb-0 leading-[1.9]">
                Drop files or folders anywhere to stash them, or click{' '}
                {/* Inline ghost-accent "+" — a small rounded-square add-button
                  * so the sentence reads as unmistakably clickable. `pb`
                  * optically lifts the low-sitting "+" glyph to centre. */}
                <button
                  type="button"
                  className="mx-1 inline-grid size-[1.5em] cursor-pointer place-items-center rounded-sm border border-accent bg-transparent p-0 pb-[0.14em] align-middle leading-none font-medium text-accent transition-colors duration-fast [font-size:inherit] hover:bg-accent/10"
                  onClick={() => { void actions.newNote(); }}
                >+</button>{' '}
                for a new note.
              </p>
            </div>
          </div>
        )}
        {emptyTab && <EmptyTabLanding />}
        {markdownTabs.map((tab) => {
          const file = tab.file!;
          const active = tab.id === state.activeTabId;
          return (
            <div
              key={`${tab.id}:${file.folder ?? ''}:${file.name}`}
              className="markdown-tab-layer"
              hidden={!active}
            >
              {tab.conflict ? (
                <Suspense fallback={<div className={VIEWER_LOADING_CLASS} role="status">Loading conflict view…</div>}>
                  <LazyConflictResolver tabId={tab.id} />
                </Suspense>
              ) : (
                <LazyLoadBoundary
                  className={VIEWER_LOADING_CLASS}
                  label="Markdown document"
                  resetKey={`${file.folder ?? ''}:${file.grantId ?? ''}:${file.name}:${file.version ?? ''}`}
                >
                  <Suspense fallback={<div className={VIEWER_LOADING_CLASS} role="status">Opening document…</div>}>
                    <LazyCrepeDocument
                      tabId={tab.id}
                      name={file.name}
                      content={file.content}
                      readOnly={!tab.editMode || Boolean(file.isReadOnly) || Boolean(file.isExternal)}
                      active={active}
                      dirty={tab.dirty}
                      folder={file.folder}
                    />
                  </Suspense>
                </LazyLoadBoundary>
              )}
            </div>
          );
        })}
        {cur && cur.format === 'json' && (
          activeTab?.conflict ? (
            <Suspense fallback={<div className={VIEWER_LOADING_CLASS} role="status">Loading conflict view…</div>}>
              <LazyConflictResolver tabId={activeTab.id} />
            </Suspense>
          ) : (
            <LazyLoadBoundary className={VIEWER_LOADING_CLASS} label="JSON document" resetKey={resourceResetKey}>
              <Suspense fallback={<div className={VIEWER_LOADING_CLASS}>Opening JSON…</div>}>
                <LazyJsonDocument
                  key={activeTab?.id ?? cur.name}
                  tabId={activeTab?.id ?? ''}
                  content={cur.content}
                  readOnly={!editMode || Boolean(cur.isReadOnly) || Boolean(cur.isExternal)}
                  active
                />
              </Suspense>
            </LazyLoadBoundary>
          )
        )}
        {cur && !editMode && cur.format === 'html' && (
          <HtmlPreview key={activeTab?.id} name={cur.name} />
        )}
        {cur && cur.format === 'docx' && (
          <LazyLoadBoundary className={VIEWER_CENTERED_LOADING_CLASS} label="document preview" resetKey={resourceResetKey}>
            <Suspense fallback={<div className={VIEWER_CENTERED_LOADING_CLASS}>Opening document…</div>}>
              <LazyDocxPreview key={activeTab?.id} name={cur.name} />
            </Suspense>
          </LazyLoadBoundary>
        )}
        {cur && cur.format === 'pdf' && (
          // PDFs have no edit mode — the source is a binary file. Only
          // the original PDF is shown: the extracted `.md` is a hidden
          // implementation detail (search hits remap back to the PDF;
          // the derived note must never surface as content). The
          // preparation failure banner + Reprocess live inside PdfPreview.
          <LazyLoadBoundary className={VIEWER_LOADING_CLASS} label="PDF preview" resetKey={resourceResetKey}>
            <Suspense fallback={<div className={VIEWER_LOADING_CLASS}>Loading PDF…</div>}>
              <LazyPdfPreview key={activeTab?.id} name={cur.name} />
            </Suspense>
          </LazyLoadBoundary>
        )}
        {cur && cur.format === 'image' && (
          // Images, like PDFs, are binary — no edit mode.
          <ImagePreview key={activeTab?.id} name={cur.name} />
        )}
        {cur && cur.format === 'audio' && (
          <LazyLoadBoundary className={VIEWER_PADDED_LOADING_CLASS} label="audio preview" resetKey={resourceResetKey}>
            <Suspense fallback={<div className={VIEWER_PADDED_LOADING_CLASS}>Opening audio…</div>}>
              <LazyAudioPreview key={activeTab?.id} name={cur.name} />
            </Suspense>
          </LazyLoadBoundary>
        )}
      </div>
      {emptyTab && (
        // Centered placeholder strip for an empty (Untitled) tab —
        // absolute + 50% transform centers it relative to .main, in the
        // same slot a breadcrumb path would occupy.
        <div className="absolute top-11 left-1/2 z-4 flex h-6 max-w-[calc(100%-220px)] -translate-x-1/2 items-center overflow-hidden text-base whitespace-nowrap text-muted-foreground">
          <span className="px-1 py-0.5">Untitled</span>
        </div>
      )}
      <FindBar />
      {cur && (cur.format === 'md' || cur.format === 'json') && !cur.folder && !cur.isExternal && !activeTab?.conflict && (
        /* Floating actions in the main pane's top-right — sits below the
         * tab strip (unconditionally present whenever there's an open
         * file, so a fixed offset is safe). The edit toggle lives here on
         * its own; the save status tucks in next to it while editing. */
        <div className="absolute top-11 right-3.5 z-5 flex items-center gap-2">
          {editMode && saveStatus.text && (
            /* "Saved" / "Renaming…" share the default muted grey — green
             * felt too celebratory for a routine autosave tick. Errors
             * turn red so they break the visual rhythm. */
            <span className={'text-sm transition-opacity duration-standard' + (saveStatus.cls === 'error' ? ' text-destructive' : ' text-muted-foreground')}>
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
        // banner (min-h-8) pushes the slot down when present.
        <div
          className={'pointer-events-none absolute right-3.5 left-3.5 z-5 flex items-center justify-stretch gap-2 ' + ((outOfFolder || cur.isExternal) ? 'top-[76px]' : 'top-11')}
          id="pdf-chrome-slot"
        />
      )}
    </main>
  );
}
