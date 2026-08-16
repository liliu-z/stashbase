import { useEffect, useMemo, useRef } from 'react';
import { versionedAssetUrl, versionedDerivedAssetUrl } from '../api';
import { useApp, type MatchInfo } from '../store/AppContext';
import { useIframeDropForward } from '../hooks/useIframeDropForward';
import { isTrustedFrameSource } from '../lib/previewMessages';

/**
 * Read-only HTML preview. Loads via `/asset/*` so the iframe's base
 * resolves relative references in the page (`<img src="X_files/foo.png">`)
 * to the sibling files inside the folder dir.
 *
 * Sandbox = `allow-scripts allow-same-origin` — `allow-scripts` lets
 * inline scripts run (Wikipedia snapshots, arxiv reports, self-contained
 * bundler apps); `allow-same-origin` gives the page a real localhost
 * origin so that `URL.createObjectURL` produces loadable `blob:http://`
 * URLs (without it, blob URLs are `blob:null/…` which Electron/Chromium
 * refuses to load as `<script src>`). For a local desktop app whose HTML
 * content is user-controlled, this tradeoff mirrors what Obsidian and
 * VS Code do. The server-injected scroll-bootstrap listens for
 * postMessage from the parent (anchor scroll + cross-file link
 * forwarding).
 *
 * Auto-reload on external edits (Claude Code edits the file from the
 * chat panel) is the reason for the cache-buster query string on
 * the iframe src — the URL would otherwise be identical between
 * versions and React would never re-set it, leaving the iframe
 * stuck on whatever the asset route served first. See the `src`
 * computation below.
 */
export function HtmlPreview({ name, derived = false }: { name: string; derived?: boolean }) {
  const { state, actions, activeTab } = useApp();
  const pendingAnchor = activeTab?.pendingAnchor ?? null;
  const pendingHighlight = activeTab?.pendingHighlight ?? null;
  const content = activeTab?.file?.content ?? '';
  // Out-of-folder tab: the asset URL must carry the file's own folder.
  const sourceFolder = activeTab?.file?.name === name ? activeTab.file.folder : undefined;
  const sourceGrantId = activeTab?.file?.name === name ? activeTab.file.grantId : undefined;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const chunkReqRef = useRef(0);
  // Tracks which `name` the iframe has finished loading. We only post
  // the scroll message when this matches the current `name` — otherwise
  // the message lands on the previous file's content and the pending
  // anchor gets consumed before the new content arrives.
  const loadedNameRef = useRef<string>('');
  // Snapshot find-bar state so the iframe re-apply path doesn't churn
  // the find effect on every find tick.
  const findAtMount = useRef(state.find);
  findAtMount.current = state.find;

  // Cheap content fingerprint used to bust the iframe cache when the
  // file changes on disk (e.g. Claude Code wrote to it via the
  // chat panel; `refreshActiveTabFromDisk` patched our local
  // state but the iframe is fed by `assetUrl(name)` which the server
  // re-reads from disk on every request — without a query-string
  // change React keeps the same `src`, so the iframe never refetches).
  // djb2 over the whole content; usable as a 32-bit base36 token.
  const derivedStateToken = derived
    ? `${state.pendingConversions.includes(name) ? 'pending' : 'settled'}:${state.preparationFailures.some((f) => f.path === name) ? 'failed' : 'ok'}:${state.conversionVersions[name] ?? 0}`
    : '';
  const fingerprint = useMemo(() => {
    let h = 5381;
    const seed = derived ? `${content}:${derivedStateToken}` : content;
    for (let i = 0; i < seed.length; i++) {
      h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }, [content, derived, derivedStateToken]);
  const src = derived
    ? versionedDerivedAssetUrl(name, fingerprint, sourceFolder)
    : versionedAssetUrl(name, fingerprint, sourceFolder, sourceGrantId);

  function postScroll() {
    if (!pendingAnchor) return;
    if (loadedNameRef.current !== name) return; // iframe still loading
    try {
      frameRef.current?.contentWindow?.postMessage(
        { type: 'stashbase-scroll', id: pendingAnchor },
        '*',
      );
    } catch { /* swallow */ }
    actions.consumePendingScroll();
  }

  function postChunkHighlight() {
    if (!pendingHighlight) return;
    if (loadedNameRef.current !== name) return;
    const reqId = ++chunkReqRef.current;
    try {
      frameRef.current?.contentWindow?.postMessage(
        { type: 'stashbase-chunk-highlight', reqId, text: pendingHighlight.chunkText },
        '*',
      );
    } catch { /* swallow */ }
  }

  function onLoad() {
    loadedNameRef.current = name;
    postScroll();
    postChunkHighlight();
    // Re-apply the current query if the bar is open across reload.
    const snap = findAtMount.current;
    if (snap.open && snap.query) {
      queueMicrotask(() => actions.setFindQuery(snap.query));
    }
  }

  // Same-file anchor jumps fire this; cross-file jumps wait for onLoad.
  useEffect(() => { postScroll(); /* eslint-disable-next-line */ }, [pendingAnchor, name]);
  useEffect(() => { postChunkHighlight(); /* eslint-disable-next-line */ }, [pendingHighlight, name]);

  // OS-file drops over the preview relay out to useGlobalDragDrop.
  useIframeDropForward(frameRef, src);

  // Register a postMessage-based find controller. The iframe runs the
  // walk-and-highlight algorithm itself (sandbox=allow-scripts blocks
  // same-origin DOM access) and replies with the count via reqId.
  useEffect(() => {
    let seq = 0;
    const pending = new Map<number, (info: MatchInfo) => void>();
    const TIMEOUT_MS = 2000;

    function send(op: 'set' | 'next' | 'prev' | 'close', extra?: Record<string, unknown>): Promise<MatchInfo> {
      const reqId = ++seq;
      const win = frameRef.current?.contentWindow;
      if (!win) return Promise.resolve({ current: 0, total: 0 });
      return new Promise<MatchInfo>((resolve) => {
        pending.set(reqId, resolve);
        try {
          win.postMessage({ type: 'stashbase-find', op, reqId, ...extra }, '*');
        } catch {
          pending.delete(reqId);
          resolve({ current: 0, total: 0 });
          return;
        }
        // Iframe may have unloaded / errored before responding —
        // resolve to empty after a short timeout so the bar's spinner
        // (if any) doesn't hang.
        setTimeout(() => {
          const r = pending.get(reqId);
          if (r) { pending.delete(reqId); r({ current: 0, total: 0 }); }
        }, TIMEOUT_MS);
      });
    }

    function onMessage(e: MessageEvent) {
      if (!isTrustedFrameSource(e.source, frameRef.current?.contentWindow ?? null)) return;
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'stashbase-find-result' && typeof d.reqId === 'number') {
        const r = pending.get(d.reqId);
        if (r) {
          pending.delete(d.reqId);
          r({ current: d.current ?? 0, total: d.total ?? 0 });
        }
      } else if (d.type === 'stashbase-chunk-highlight-result' && typeof d.reqId === 'number') {
        if (d.reqId === chunkReqRef.current && d.ok === true) {
          actions.consumePendingHighlight();
        }
      } else if (d.type === 'stashbase-open-find') {
        actions.openFind();
      } else if (d.type === 'stashbase-find-step') {
        // Bootstrap inside the iframe forwards Cmd+G / Shift+Cmd+G.
        if (d.dir === 'prev') actions.findPrev(); else actions.findNext();
      }
    }
    window.addEventListener('message', onMessage);

    actions.registerFindController({
      setQuery: (q, opts) => send('set', {
        query: q,
        wholeWord: opts.wholeWord,
        caseSensitive: opts.caseSensitive,
      }),
      next: () => send('next'),
      prev: () => send('prev'),
      close: () => { void send('close'); },
    });

    return () => {
      window.removeEventListener('message', onMessage);
      actions.registerFindController(null);
    };
  }, [actions]);

  return (
    /* The shell gives the iframe a definite box; the iframe fills the
     * viewer column — HTML imports control their own width via their own
     * CSS; MD keeps its ~820px reading column inside the MD iframe's own
     * body styles. */
    <div className="relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-white">
      <iframe
        ref={frameRef}
        id="previewFrame"
        className="absolute inset-0 block h-full w-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin"
        src={src}
        title="HTML preview"
        onLoad={onLoad}
      />
    </div>
  );
}
