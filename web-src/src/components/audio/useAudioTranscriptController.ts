import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, type AudioTranscriptState } from '../../api';

interface AudioTarget {
  name: string;
  folder: string;
  version: string;
}

export function useAudioTranscriptController(input: AudioTarget & { conversionRevision: number }) {
  const { name, folder, version, conversionRevision } = input;
  const [state, setState] = useState<AudioTranscriptState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [retryLanguage, setRetryLanguage] = useState('');
  const [pollNonce, setPollNonce] = useState(0);
  const currentRef = useRef<AudioTarget>({ name, folder, version });
  currentRef.current = { name, folder, version };

  useEffect(() => {
    setRetryLanguage('');
    setRetryBusy(false);
    setCancelBusy(false);
  }, [name, folder, version]);

  useEffect(() => {
    setState(null);
    setError(null);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await api.audioTranscript(name);
        if (cancelled) return;
        setState(next);
        setError(null);
        if (next.status === 'pending' || next.status === 'blocked') {
          timer = setTimeout(poll, next.status === 'pending' ? 1200 : 3000);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        setError(errorMessage(err));
        timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [name, folder, version, conversionRevision, pollNonce]);

  async function reprocess() {
    const atStart = { ...currentRef.current };
    setRetryBusy(true);
    setError(null);
    try {
      await api.reprocessFile(name, {
        folder: folder || undefined,
        language: retryLanguage || undefined,
      });
      if (!sameTarget(atStart, currentRef.current)) return;
      setState({ status: 'pending' });
      setPollNonce((value) => value + 1);
    } catch (err: unknown) {
      if (sameTarget(atStart, currentRef.current)) setError(errorMessage(err));
    } finally {
      if (sameTarget(atStart, currentRef.current)) setRetryBusy(false);
    }
  }

  async function cancel() {
    const atStart = { ...currentRef.current };
    setCancelBusy(true);
    setError(null);
    try {
      const result = await api.cancelFilePreparation(name, { folder: folder || undefined });
      if (!sameTarget(atStart, currentRef.current)) return;
      if (result.cancelled) setState({ status: 'cancelled' });
      setPollNonce((value) => value + 1);
    } catch (err: unknown) {
      if (sameTarget(atStart, currentRef.current)) setError(errorMessage(err));
    } finally {
      if (sameTarget(atStart, currentRef.current)) setCancelBusy(false);
    }
  }

  return {
    state,
    error,
    retryBusy,
    cancelBusy,
    retryLanguage,
    setRetryLanguage,
    reprocess,
    cancel,
  };
}

function sameTarget(a: AudioTarget, b: AudioTarget): boolean {
  return a.name === b.name && a.folder === b.folder && a.version === b.version;
}
