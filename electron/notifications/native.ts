import type { App, Notification, NotificationConstructorOptions } from 'electron';
import type { NativeNotice, NotificationContent } from './center.ts';
import { createNotificationSettings } from './system-settings.ts';

// Must match the packaged NSIS shortcut's AUMID (package.json build.appId).
export const NOTIFICATION_APP_ID = 'com.stashbase.app';
interface Dependencies {
  platform: NodeJS.Platform;
  windowsStore?: boolean;
  app: Pick<App, 'setAppUserModelId'>;
  desktop: string;
  openExternal(url: string): Promise<void>;
  Notification: {
    new(options: NotificationConstructorOptions): Pick<Notification, 'on' | 'show' | 'close'>;
    isSupported(): boolean;
  };
}

/** Only common Notification APIs are used. Buttons, replies, timeout control
 * and custom toast XML differ by desktop and do not form our app contract. */
export function createNativeNotifications({ platform, windowsStore = process.windowsStore === true, app, Notification, desktop, openExternal }: Dependencies) {
  // MSIX activation supplies its package AUMID. Do not replace it with the
  // unrelated NSIS shortcut identity.
  if (platform === 'win32' && !windowsStore) app.setAppUserModelId(NOTIFICATION_APP_ID);
  return {
    ...createNotificationSettings({ platform, desktop, openExternal }),
    supported(): boolean {
      try { return Notification.isSupported(); } catch { return false; }
    },
    create(content: NotificationContent): NativeNotice {
      return new Notification({ title: content.title, body: content.body });
    },
  };
}
