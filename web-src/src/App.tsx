import {
  useEffect,
  Suspense,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Sidebar } from './components/Sidebar';
import { TitlebarControls } from './components/TitlebarControls';
import { MainPane } from './components/MainPane';
import { DropVeil } from './components/DropVeil';
import { EmbedderRequireKeyGate } from './components/EmbedderRequireKeyGate';
import { Hotkeys } from './components/Hotkeys';
import { ClipboardImportModal } from './components/ClipboardImportModal';
import { CascadePromptModal } from './components/CascadePromptModal';
import { AlertConfirmModal } from './components/AlertConfirmModal';
import { Toasts } from './components/Toasts';
import { SettingsPortal } from './components/SettingsModal';
import { QuickOpen } from './components/QuickOpen';
import { LibrarySearch } from './components/LibrarySearch';
import { EditorHistoryNavigator } from './components/EditorHistoryNavigator';
import { DocumentOutlineProvider } from './components/DocumentOutlineContext';
import { ErrorBoundary, LazyLoadBoundary, lazyWithRetry } from './components/ErrorBoundary';
import { OverlayStackProvider } from './components/OverlayStack';
import { ChatSplitter, SidebarSplitter } from './components/WorkspaceSplitters';
import { AppProvider, useApp } from './store/AppContext';
import { useChatLayoutFollowUp } from './hooks/useChatLayoutFollowUp';
import { useClipboardImageOffer } from './hooks/useClipboardImageOffer';
import { useGlobalDragDrop } from './hooks/useGlobalDragDrop';
import { usePreviewMessages } from './hooks/usePreviewMessages';
import { api } from './api';
import { applyAppearance, subscribeToAppearance } from './appearance';
import { electronBridge } from './electronBridge';
import {
  COMPACT_WORKSPACE_QUERY,
  resolveWorkspaceLayout,
} from './workspaceLayout';

const LazyChatPane = lazyWithRetry(() => import('./components/ChatPane'));
const LazyUnsupportedFilesModalGate = lazyWithRetry(() => import('./components/UnsupportedFilesModal'));
const LazyContextMenu = lazyWithRetry(() => import('./components/ContextMenu'));
const LazyImageLightbox = lazyWithRetry(() =>
  import('./components/ImageLightbox').then((mod) => ({ default: mod.ImageLightbox })),
);

/**
 * Top-level shell. Wraps everything in <AppProvider> (the single
 * store) and mounts the global drag-drop / hotkey side effects.
 *
 * There is no landing page: the app boots straight into the workspace,
 * and the sidebar's library list is how folders are added and switched.
 */
export function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <OverlayStackProvider>
          <AppBody />
        </OverlayStackProvider>
      </AppProvider>
    </ErrorBoundary>
  );
}

function AppBody() {
  const { hot: veilHot, activeZone } = useGlobalDragDrop();
  const { state, actions, dispatch } = useApp();
  const { previewImage, closePreviewImage } = usePreviewMessages();
  const { clipboardOffer, saveClipboardOffer, dismissClipboardOffer } = useClipboardImageOffer();
  const initialFolderPending = useRef(new URLSearchParams(window.location.search).has('folder'));
  const compactWorkspace = useCompactWorkspace();
  const hasDocument = state.tabs.length > 0;
  const workspaceLayout = resolveWorkspaceLayout({
    chatOpen: state.chatOpen,
    hasDocument,
    compact: compactWorkspace,
  });
  // Mount the chat panel lazily on first open and then NEVER
  // unmount it — hiding the panel only collapses the column via CSS,
  // the underlying agent WebSocket sessions stay alive. Killing them
  // on every collapse would lose Claude Code's chat history and any
  // in-flight agent run. The titlebar's chat toggle shows/hides the
  // panel; the sidebar's New Chat split button starts a fresh session
  // (and also reopens the hidden panel).
  const [chatMounted, setChatMounted] = useState(state.chatOpen);
  useChatLayoutFollowUp(state, { hasDocument, compact: compactWorkspace }, dispatch);
  // Prime the agent registry once per window (always-mounted home: the
  // chat surfaces are lazy/conditional). Each AgentView refreshes the
  // catalog after every connection outcome so runtime failures and
  // retries stay visible; this initial fetch keeps runtime states
  // loading before any chat surface mounts.
  useEffect(() => {
    let cancelled = false;
    api.listAgents().then((r) => {
      if (!cancelled) dispatch({ type: 'AGENTS_LOADED', agents: r.clis });
    }).catch(() => { /* renderer falls back to local defaults */ });
    return () => { cancelled = true; };
  }, [dispatch]);
  useEffect(() => {
    let receivedWindowUpdate = false;
    const unsubscribe = subscribeToAppearance((preferences) => {
      receivedWindowUpdate = true;
      applyAppearance(preferences);
    });
    void api.appearance().then((preferences) => {
      if (!receivedWindowUpdate) applyAppearance(preferences);
    }).catch(() => {
      // The initial light/system-safe CSS remains usable if config is absent
      // or temporarily unreadable; Settings exposes the recoverable error.
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (state.chatOpen) setChatMounted(true);
  }, [state.chatOpen]);
  useEffect(() => {
    document.title = state.folder ? `${state.folder} — StashBase` : 'StashBase';
  }, [state.folder]);
  useEffect(() => {
    // createWindow registers its requested folder immediately so a second
    // "Open in New Window" click can focus the still-loading window. Preserve
    // that pending identity until bootstrap either opens it or settles
    // without a folder (open failure surfaces as a toast).
    if (initialFolderPending.current && !state.folderPath && !state.booted) return;
    initialFolderPending.current = false;
    void electronBridge()?.setWindowFolder?.(state.folderPath || null);
    // Boot has pushed its final window-folder registration (boot never
    // selects a folder on its own — only an explicit ?folder request or a
    // same-window restore does). The multi-window smoke keys off this
    // marker before assigning folders programmatically — without it, a
    // late boot push could clobber the harness's registration.
    if (state.booted) document.body.dataset.bootSettled = '1';
  }, [state.booted, state.folderPath]);
  useEffect(() => {
    const bridge = (window as { electron?: any }).electron;
    if (!bridge) return;
    bridge.notifyRendererReadyForNativeFiles?.();
    return bridge.onOpenExternalFiles?.((paths: string[]) => {
      void (async () => {
        for (const filePath of paths) {
          await actions.openExternalFilePath(filePath);
        }
      })();
    });
  }, [actions]);
  // macOS fullscreen toggles the `is-fullscreen` body class so the sidebar
  // can drop its traffic-light drag zone. That's owned entirely by the
  // preload (registered before page load, so it catches the initial state
  // push even when the window starts in fullscreen) — see preload.cjs.

  return (
    <>
      {/* No dedicated titlebar strip, Cursor-style: the folder identity
       *  lives in `document.title` (the OS titlebar / Mission Control),
       *  and on macOS Electron the traffic lights float over the
       *  sidebar's top drag zone (globals.css). The titlebar band hosts
       *  the shell-level sidebar-toggle + search controls
       *  (TitlebarControls) — they survive a sidebar collapse, so the
       *  toggle is always the way back in; the right edge still drags
       *  to resize/collapse, à la VSCode. */}
      <div
        className={
          'app'
          + (state.sidebarCollapsed ? ' sidebar-collapsed' : '')
          + (state.chatOpen ? ' chat-open' : '')
          + (workspaceLayout === 'chat-primary' ? ' chat-primary' : '')
        }
        style={{
          '--chat-width': `${state.chatWidth}px`,
          '--sidebar-width': `${state.sidebarWidth}px`,
        } as CSSProperties}
      >
        <TitlebarControls />
        <DocumentOutlineProvider>
          <Sidebar />
          <SidebarSplitter />
          <MainPane workspaceHidden={workspaceLayout === 'chat-primary'} />
        </DocumentOutlineProvider>
        {chatMounted && workspaceLayout === 'split' && <ChatSplitter />}
        {chatMounted && (
          <LazyLoadBoundary
            className="chat-pane-shell"
            label="Agent chat"
            resetKey={`${state.activeChatTabId ?? 'none'}:${state.chatOpen ? 'open' : 'closed'}`}
          >
            <Suspense fallback={<aside className="chat-pane-shell" aria-label="Agent chat" />}>
              <LazyChatPane />
            </Suspense>
          </LazyLoadBoundary>
        )}
      </div>
      <DropVeil
        hot={veilHot}
        activeZone={activeZone}
        sidebarWidth={state.sidebarWidth}
        sidebarCollapsed={state.sidebarCollapsed}
      />
      {state.ctxMenu && (
        <LazyLoadBoundary
          className="fixed z-1200 rounded-md bg-popover p-2 text-sm text-popover-foreground shadow-elevation"
          label="context menu"
          resetKey={`${state.ctxMenu.kind}:${state.ctxMenu.target}`}
        >
          <Suspense fallback={null}>
            <LazyContextMenu />
          </Suspense>
        </LazyLoadBoundary>
      )}
      <Hotkeys />
      <QuickOpen />
      <LibrarySearch />
      <EditorHistoryNavigator />
      {previewImage && (
        <LazyLoadBoundary
          className="quick-open-blocking fixed inset-0 z-90 bg-scrim text-white"
          label="image preview"
          resetKey={previewImage.src}
        >
          <Suspense fallback={<div className="quick-open-blocking fixed inset-0 z-90 grid place-items-center bg-scrim text-sm text-white/80">Opening image…</div>}>
            <LazyImageLightbox
              src={previewImage.src}
              alt={previewImage.alt}
              onClose={closePreviewImage}
            />
          </Suspense>
        </LazyLoadBoundary>
      )}
      {clipboardOffer && state.folder && (
        <ClipboardImportModal
          offer={clipboardOffer}
          onClose={dismissClipboardOffer}
          onAdd={() => { void saveClipboardOffer(clipboardOffer); }}
        />
      )}
      <CascadePromptModal />
      <Suspense fallback={null}>
        <LazyUnsupportedFilesModalGate />
      </Suspense>
      <AlertConfirmModal />
      <Toasts />
      <EmbedderRequireKeyGate />
      <SettingsPortal />
    </>
  );
}

function useCompactWorkspace() {
  const [compact, setCompact] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia(COMPACT_WORKSPACE_QUERY).matches
      : window.innerWidth <= 960);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      const onResize = () => setCompact(window.innerWidth <= 960);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    const query = window.matchMedia(COMPACT_WORKSPACE_QUERY);
    const onChange = (event: MediaQueryListEvent) => setCompact(event.matches);
    setCompact(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return compact;
}
