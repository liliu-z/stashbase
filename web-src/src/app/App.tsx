import {
  useEffect,
  Suspense,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import '@/app/app-shell.css';
import { Sidebar } from '@/app/components/Sidebar';
import { TitlebarControls } from '@/app/components/TitlebarControls';
import { MainPane } from '@/app/components/MainPane';
import { DropVeil } from '@/common/components/DropVeil';
import { Hotkeys } from '@/app/components/Hotkeys';
import { ClipboardImportModal } from '@/common/components/ClipboardImportModal';
import { CascadePromptModal } from '@/app/components/CascadePromptModal';
import { AlertConfirmModal } from '@/app/components/AlertConfirmModal';
import { Toasts } from '@/common/components/Toasts';
import { ChatPane, useAgentCatalogPrime, useChatLayoutFollowUp } from '@/features/agent-panel';
import { GalleryOverlayGate } from '@/features/templates';
import { EditorHistoryNavigator, LinkFilePicker, usePreviewMessages } from '@/features/documents';
import { LibrarySearch, QuickOpen } from '@/features/search';
import { EmbedderRequireKeyGate, SettingsPortal, useAppliedAppearance } from '@/features/settings';
import { ChatSplitter, MoveFilePicker, SidebarSplitter, useGlobalDragDrop } from '@/features/workspace';
import { DocumentOutlineProvider } from '@/common/components/DocumentOutlineContext';
import { ErrorBoundary, LazyLoadBoundary, lazyWithRetry } from '@/common/components/ErrorBoundary';
import { OverlayStackProvider } from '@/common/components/OverlayStack';
import { AppProvider, useAppActions, useChat, useUiShell, useWorkspace } from '@/store/contexts/AppContext';
import { useClipboardImageOffer } from '@/app/hooks/useClipboardImageOffer';
import { electronBridge } from '@/common/lib/electronBridge';
import {
  COMPACT_WORKSPACE_QUERY,
  resolveWorkspaceLayout,
} from '@/common/lib/workspaceLayout';
import { cn } from '@/common/lib/utils';

const LazyContextMenu = lazyWithRetry(() => import('@/app/components/ContextMenu'));
const LazyImageLightbox = lazyWithRetry(() =>
  import('@/common/components/ImageLightbox').then((mod) => ({ default: mod.ImageLightbox })),
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
  const veilHot = useGlobalDragDrop();
  // The root shell legitimately reads all three slices (layout classes,
  // document title, and the chat panel all key off workspace + chat state;
  // the floating context menu keys off ui-shell) — merge locally rather
  // than rewrite every `state.` reference in this file. As with AgentView,
  // this merge is local: it doesn't change which slice's change triggers
  // AppBody's own re-render, and nothing downstream reads this object.
  const workspace = useWorkspace();
  const chat = useChat();
  const uiShell = useUiShell();
  const state = { ...workspace, ...chat, ...uiShell };
  const { dispatch } = useAppActions();
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
  useAgentCatalogPrime(dispatch);
  useAppliedAppearance();
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
        className={cn(
          'app',
          state.sidebarCollapsed && 'sidebar-collapsed',
          state.chatOpen && 'chat-open',
          workspaceLayout === 'chat-primary' && 'chat-primary',
        )}
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
              <ChatPane />
            </Suspense>
          </LazyLoadBoundary>
        )}
      </div>
      <DropVeil hot={veilHot} />
      {state.ctxMenu && (
        <LazyLoadBoundary
          className="fixed z-menu rounded-md bg-popover p-2 text-sm text-popover-foreground shadow-elevation"
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
      <LinkFilePicker />
      <MoveFilePicker />
      {previewImage && (
        <LazyLoadBoundary
          className="quick-open-blocking fixed inset-0 z-modal bg-scrim text-white"
          label="image preview"
          resetKey={previewImage.src}
        >
          <Suspense fallback={<div className="quick-open-blocking fixed inset-0 z-modal grid place-items-center bg-scrim text-sm text-white/80">Opening image…</div>}>
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
      <AlertConfirmModal />
      <Toasts />
      <EmbedderRequireKeyGate />
      <GalleryOverlayGate />
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
