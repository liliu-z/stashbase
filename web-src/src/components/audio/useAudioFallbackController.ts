import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, type AudioPreviewStatus } from '../../api';

export function useAudioFallbackController(input: {
  name: string;
  folder: string;
  directSrc: string;
  fallbackSrc: string;
}) {
  const { name, folder, directSrc, fallbackSrc } = input;
  const [playbackSrc, setPlaybackSrc] = useState(directSrc);
  const [usingFallback, setUsingFallback] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState<AudioPreviewStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPlaybackSrc(directSrc);
    setUsingFallback(false);
    setPreparing(false);
    setProgress(null);
    setError(null);
  }, [name, folder, directSrc, fallbackSrc]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    if (!preparing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await api.audioPreviewStatus(name);
        if (!cancelled) setProgress(next);
      } catch {
        // The preparation request owns the actionable error.
      }
      if (!cancelled) timer = setTimeout(poll, 500);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [preparing, name, folder]);

  async function prepare() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setUsingFallback(true);
    setPreparing(true);
    setProgress({ status: 'queued', tasksAhead: 0 });
    setError(null);
    try {
      await api.prepareAudioPreview(name, { signal: controller.signal });
      if (controller.signal.aborted || controllerRef.current !== controller) return;
      setProgress({ status: 'ready' });
      setPlaybackSrc(fallbackSrc);
    } catch (err: unknown) {
      if (controller.signal.aborted || controllerRef.current !== controller) return;
      setError(`Compatible preview could not be created: ${errorMessage(err)}`);
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setPreparing(false);
      }
    }
  }

  function cancel() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPreparing(false);
    setProgress(null);
    setError('Compatible preview generation was cancelled.');
  }

  function markUnplayable() {
    if (!usingFallback) {
      void prepare();
    } else if (!preparing) {
      setError('This audio file could not be played or converted for preview.');
    }
  }

  return {
    playbackSrc,
    usingFallback,
    preparing,
    progress,
    error,
    prepare,
    cancel,
    markUnplayable,
  };
}
