import { useEffect } from 'react';

/** Desktop app switching can focus a window without changing its visibility. */
export function useWindowFocus(callback: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('focus', callback);
    return () => window.removeEventListener('focus', callback);
  }, [callback, enabled]);
}
