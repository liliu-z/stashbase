import { Suspense } from 'react';
import { EditIcon, PreviewIcon } from '../icons';
import { useApp } from '../store/AppContext';
import { EmptyTabLanding } from './EmptyTabLanding';
import { FindBar } from './FindBar';
import { HtmlPreview } from './HtmlPreview';
import { ImagePreview } from './ImagePreview';
import { TabStrip } from './TabStrip';
import { LazyLoadBoundary, lazyWithRetry } from './ErrorBoundary';

const LazyMarkdownPreview = lazyWithRetry(() => import('./MarkdownPreview').then((mod) => ({ default: mod.MarkdownPreview })));
const LazyPdfPreview = lazyWithRetry(() => import('./PdfPreview').then((mod) => ({ default: mod.PdfPreview })));
const LazyDocxPreview = lazyWithRetry(() => import('./DocxPreview').then((mod) => ({ default: mod.DocxPreview })));
const LazyAudioPreview = lazyWithRetry(() => import('./AudioPreview').then((mod) => ({ default: mod.AudioPreview })));
const LazyCodeEditor = lazyWithRetry(() => import('./CodeEditor').then((mod) => ({ default: mod.CodeEditor })));

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
export function MainPane() {
  const { state, actions, activeTab } = useApp();
  const cur = activeTab?.file ?? null;
  const editMode = activeTab?.editMode ?? false;
  const saveStatus = activeTab?.saveStatus ?? { text: '', cls: '' };
  const hasTabs = state.tabs.length > 0;
  const emptyTab = !!activeTab && !cur;
  const resourceResetKey = cur ? `${cur.name}:${cur.version ?? ''}` : undefined;

  return (
    <main className={'main' + (hasTabs ? '' : ' no-file') + (cur ? ' fmt-' + cur.format : '')}>
      {hasTabs && <TabStrip />}
      <div className="main-body">
        {!hasTabs && (
          // One <p> wrapper so the grid centers a single block and the
          // text keeps normal inline flow — otherwise each <br>/inline
          // child becomes its own grid item and scatters vertically.
          <div className="empty-doc">
            <p>
              Drop files or folders anywhere to stash them<br />
              — Markdown, HTML, PDFs, images, audio —<br />
              or click{' '}
              <button
                type="button"
                className="empty-doc-new"
                onClick={() => { void actions.newNote(); }}
              >+</button>{' '}
              for a new note (⌘N)
            </p>
          </div>
        )}
        {emptyTab && <EmptyTabLanding />}
        {cur && !editMode && cur.format === 'md' && (
          <LazyLoadBoundary className="doc-loading" label="Markdown preview" resetKey={resourceResetKey}>
            <Suspense fallback={<div className="doc-loading">Loading preview…</div>}>
              <LazyMarkdownPreview name={cur.name} content={cur.content} />
            </Suspense>
          </LazyLoadBoundary>
        )}
        {cur && !editMode && cur.format === 'html' && (
          <HtmlPreview name={cur.name} />
        )}
        {cur && cur.format === 'docx' && (
          <LazyLoadBoundary className="docx-preview-loading" label="document preview" resetKey={resourceResetKey}>
            <Suspense fallback={<div className="docx-preview-loading">Opening document…</div>}>
              <LazyDocxPreview name={cur.name} />
            </Suspense>
          </LazyLoadBoundary>
        )}
        {cur && cur.format === 'pdf' && (
          // PDFs have no edit mode — the source is a binary file. Only
          // the original PDF is shown: the extracted `.md` is a hidden
          // implementation detail (search hits remap back to the PDF;
          // the derived note must never surface as content). The
          // preparation failure banner + Reprocess live inside PdfPreview.
          <LazyLoadBoundary className="pdf-loading" label="PDF preview" resetKey={resourceResetKey}>
            <Suspense fallback={<div className="pdf-loading">Loading PDF…</div>}>
              <LazyPdfPreview name={cur.name} />
            </Suspense>
          </LazyLoadBoundary>
        )}
        {cur && cur.format === 'image' && (
          // Images, like PDFs, are binary — no edit mode.
          <ImagePreview name={cur.name} />
        )}
        {cur && cur.format === 'audio' && (
          <LazyLoadBoundary className="audio-preview-loading" label="audio preview" resetKey={resourceResetKey}>
            <Suspense fallback={<div className="audio-preview-loading">Opening audio…</div>}>
              <LazyAudioPreview name={cur.name} />
            </Suspense>
          </LazyLoadBoundary>
        )}
        {cur && editMode && cur.format === 'md' && (
          // Markdown is the only editable format — HTML/PDF/image/DOCX are
          // read-only viewers, including audio. The editor is a single CodeMirror pane
          // (no source+preview split); save is scheduled on every edit.
          <div className="md-editor">
            <LazyLoadBoundary className="doc-loading" label="Markdown editor" resetKey={resourceResetKey}>
              <Suspense fallback={<div className="doc-loading">Loading editor…</div>}>
                <LazyCodeEditor
                  key={activeTab?.id ?? cur.name}
                  tabId={activeTab?.id ?? ''}
                  sessionVersion={activeTab?.editorSessionVersion ?? 0}
                  name={cur.name}
                  initialContent={cur.content}
                  onChange={() => actions.scheduleSave()}
                />
              </Suspense>
            </LazyLoadBoundary>
          </div>
        )}
      </div>
      {emptyTab && (
        <div className="main-breadcrumb empty">
          <span className="seg current">Untitled</span>
        </div>
      )}
      <FindBar />
      {cur && cur.format === 'md' && (
        <div className={'main-floating-actions' + (editMode ? ' editing' : '')}>
          {editMode && saveStatus.text && (
            <span className={'save-status' + (saveStatus.cls ? ' ' + saveStatus.cls : '')}>
              {saveStatus.text}
            </span>
          )}
          <button
            className={'icon-btn edit-toggle' + (editMode ? ' editing' : '')}
            type="button"
            title={editMode ? 'Switch to Reading View' : 'Switch to Live Editing'}
            aria-label={editMode ? 'Switch to Reading View' : 'Switch to Live Editing'}
            onClick={() => { void actions.toggleEditMode(); }}
          >
            <EditIcon className="icon-edit" />
            <PreviewIcon className="icon-preview" />
          </button>
        </div>
      )}
      {cur && cur.format === 'pdf' && (
        // Slot that PdfPreview portals its zoom / page-count chrome
        // into — sits on the same row as back/forward + breadcrumb
        // so we don't waste a row on viewer chrome.
        <div className="main-floating-actions pdf-chrome-slot" id="pdf-chrome-slot" />
      )}
    </main>
  );
}
