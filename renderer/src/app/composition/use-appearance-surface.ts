import { useEffect } from 'react';

import type { AppearancePort } from '@/features/settings/public';
import type { AppearanceSurface } from '@/shared/domain/appearance';
import {
  applyAppearanceSurface,
  connectNativeAppearance,
  subscribeToAppearanceSurface,
} from '@/shared/runtime/appearance-surface';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';

/**
 * Applies the saved appearance to this window, once at startup and thereafter
 * whenever another window saves a change.
 *
 * The subscription is established before the read so a save that lands
 * mid-request wins: the broadcast is newer than the snapshot in flight, and a
 * late read must never repaint the window with the appearance the reader just
 * changed away from.
 *
 * A failed read is deliberately silent. The appearance the desktop remembered
 * (or the stylesheet's own default) stays usable while the configuration is
 * absent or briefly unreadable, and Settings is the surface that reports it.
 *
 * Every applied appearance is also handed to the desktop, which styles native
 * chrome, sets the spellchecker, and paints the next window's first frame
 * from it.
 */
export function useAppearanceSurface(
  port: AppearancePort,
  setAppearance: (appearance: AppearanceSurface) => Promise<void>,
): void {
  const signalFor = useRequestSignals<'appearance'>();

  useEffect(
    () =>
      connectNativeAppearance((appearance) => {
        // swallowed: native chrome is a best effort beside the painted page.
        setAppearance(appearance).catch(() => undefined);
      }),
    [setAppearance],
  );

  useEffect(() => {
    let broadcast = false;
    const unsubscribe = subscribeToAppearanceSurface((surface) => {
      broadcast = true;
      applyAppearanceSurface(surface);
    });
    void port
      .load(signalFor('appearance'))
      .then((preferences) => {
        if (!broadcast) applyAppearanceSurface(preferences);
      })
      // swallowed: Settings is the surface that reports an unreadable configuration.
      .catch(() => undefined);
    return unsubscribe;
  }, [port, signalFor]);
}
