import { useCallback, useEffect, useState } from 'react';
import { api, type EmbedderState } from '@/common/api/api';
import { useLatestRef } from '@/common/hooks/useLatestRef';
import { ACCOUNT_CHANGED_EVENT } from '@/common/lib/accountEvents';

export interface EmbedderStateRead {
  /** Null until the first read lands, and after a read that failed. */
  embedder: EmbedderState | null;
  /** Apply what a save just returned without waiting for a re-read. */
  patchEmbedder: (patch: (current: EmbedderState) => EmbedderState) => void;
}

/**
 * Whether a Similarity Search provider is authorized, read from the server.
 *
 * This is in `common/` because two features ask the same question from
 * opposite sides: Settings gates the setup dialog on it, and the Files
 * panel's callout offers to open that dialog. Neither may import the other,
 * and both need the same answer, including the same silent failure — the
 * read races the local server's boot, and a bare window that has not
 * answered yet must show no callout rather than an error.
 *
 * `refreshKey` is the caller's own identity for the answer: a change
 * re-reads. Sign-in and sign-out re-read on their own, from the shared
 * account event, since either can happen in a window that owns neither
 * surface.
 */
export function useEmbedderState(options: {
  refreshKey?: string;
  /** Called only when a read completes — not when `patchEmbedder` runs. */
  onLoaded?: (embedder: EmbedderState) => void;
} = {}): EmbedderStateRead {
  const { refreshKey = '' } = options;
  const [embedder, setEmbedder] = useState<EmbedderState | null>(null);
  const [authRevision, setAuthRevision] = useState(0);
  const onLoadedRef = useLatestRef(options.onLoaded);

  useEffect(() => {
    let cancelled = false;
    api.getEmbedder()
      .then((next) => {
        if (cancelled) return;
        setEmbedder(next);
        onLoadedRef.current?.(next);
      })
      .catch(() => { /* startup race with server boot — silent */ });
    return () => { cancelled = true; };
  }, [refreshKey, authRevision, onLoadedRef]);

  useEffect(() => {
    const onChanged = () => setAuthRevision((value) => value + 1);
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, onChanged);
  }, []);

  const patchEmbedder = useCallback((patch: (current: EmbedderState) => EmbedderState) => {
    setEmbedder((current) => (current ? patch(current) : current));
  }, []);

  return { embedder, patchEmbedder };
}
