import { useCallback, useEffect, useState } from 'react';
import { electronBridge, type DesktopUpdateState } from '../electronBridge';

export function useDesktopUpdate() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    const bridge = electronBridge();
    let cancelled = false;
    let receivedPush = false;
    void bridge?.getUpdateState?.().then((next) => {
      // IPC events can overtake the initial snapshot. Never let a late idle
      // response erase a newer available/downloading state from main.
      if (!cancelled && !receivedPush && next) setState(next);
    });
    const unsubscribe = bridge?.onUpdateState?.((next) => {
      receivedPush = true;
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const check = useCallback(async () => {
    const next = await electronBridge()?.checkForUpdates?.();
    if (next) setState(next);
    return next;
  }, []);

  const runPrimaryAction = useCallback(async () => {
    const next = await electronBridge()?.runUpdateAction?.();
    if (next) setState(next);
    return next;
  }, []);

  const openDownloadPage = useCallback(async () => {
    await electronBridge()?.openUpdateDownloadPage?.();
  }, []);

  const refreshPreference = useCallback(async () => {
    const next = await electronBridge()?.refreshUpdatePreference?.();
    if (next) setState(next);
    return next;
  }, []);

  return { state, check, runPrimaryAction, openDownloadPage, refreshPreference };
}
