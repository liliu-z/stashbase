import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ClipboardOffer } from '../components/ClipboardImportModal';
import { electronBridge } from '../electronBridge';
import { useApp } from '../store/AppContext';

/**
 * Clipboard-image offer lifecycle. Main pushes de-duped clipboard image
 * offers over the preload bridge; this hook holds the current offer for the
 * shell's import modal and settles it — save into the active folder, or
 * dismiss and mark the hash handled so main stops re-offering it.
 *
 * Returns the offer to render (null when there is nothing to show) plus the
 * two ways the modal can settle it.
 */
export function useClipboardImageOffer(): {
  clipboardOffer: ClipboardOffer | null;
  saveClipboardOffer: (offer: ClipboardOffer) => Promise<void>;
  dismissClipboardOffer: () => void;
} {
  const { state, actions } = useApp();
  const [clipboardOffer, setClipboardOffer] = useState<ClipboardOffer | null>(null);
  const [pendingClipboardOffer, setPendingClipboardOffer] = useState<ClipboardOffer | null>(null);

  useEffect(() => {
    const refreshClipboardWatch = electronBridge()?.refreshClipboardWatch;
    if (!refreshClipboardWatch) return;
    let cancelled = false;
    void api.capturePreferences()
      .then(() => {
        if (!cancelled) void refreshClipboardWatch().catch(() => undefined);
      })
      .catch(() => {
        // A missing or unreadable preference must never leave ambient capture
        // enabled from stale main-process state.
        if (!cancelled) void refreshClipboardWatch().catch(() => undefined);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return electronBridge()?.onClipboardImage?.((offer) => {
      if (!offer.dataUrl || !offer.mime?.startsWith('image/')) return;
      // If no folder is open yet, keep the offer in renderer memory.
      // Main has already de-duped this hash, so dropping it here would
      // make a screenshot copied just before opening a folder vanish
      // until the user copies it again.
      if (!state.folder) {
        setPendingClipboardOffer(offer);
        return;
      }
      setClipboardOffer(offer);
    });
  }, [state.folder]);

  useEffect(() => {
    if (!state.folder || !pendingClipboardOffer || clipboardOffer) return;
    setClipboardOffer(pendingClipboardOffer);
    setPendingClipboardOffer(null);
  }, [clipboardOffer, pendingClipboardOffer, state.folder]);

  async function saveClipboardOffer(offer: ClipboardOffer) {
    try {
      const file = dataUrlToFile(offer.dataUrl, offer.filename, offer.mime);
      const saved = await actions.upload([{ file, relPath: file.name }], state.activeFolder);
      if (!saved) return;
      electronBridge()?.markClipboardHandled?.(offer.hash);
      setClipboardOffer(null);
      const suffix = state.activeFolder ? ` to ${state.activeFolder}` : '';
      actions.toast(`Saved ${file.name}${suffix}.`, { level: 'success' });
    } catch (err) {
      console.warn('[clipboard] save failed:', err);
      actions.toast('Could not save the clipboard image.', { level: 'error' });
    }
  }

  function dismissClipboardOffer() {
    if (!clipboardOffer) return;
    electronBridge()?.markClipboardHandled?.(clipboardOffer.hash);
    setClipboardOffer(null);
  }

  return { clipboardOffer, saveClipboardOffer, dismissClipboardOffer };
}

/** Decode a `data:` URL into a File. Decodes the base64 (or percent-
 *  encoded) payload directly rather than `fetch(dataUrl)` — the app's CSP
 *  `connect-src 'self'` blocks data: fetches, which made every capture /
 *  clipboard import throw "Could not save". */
function dataUrlToFile(dataUrl: string, filename: string, mime: string): File {
  const comma = dataUrl.indexOf(',');
  const header = comma >= 0 ? dataUrl.slice(0, comma) : '';
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  if (header.includes(';base64')) {
    const bin = atob(payload);
    const buf = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return new File([buf], filename, { type: mime });
  }
  // Non-base64 data URL: hand the decoded text straight to File (UTF-8
  // encoded by the Blob constructor).
  return new File([decodeURIComponent(payload)], filename, { type: mime });
}
