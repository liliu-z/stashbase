import type { BrowserWindow, IpcMain } from 'electron';

import {
  EXTERNAL_NAVIGATION_CAPABILITY,
  EXTERNAL_NAVIGATION_OPEN_CHANNEL,
  type ExternalNavigationResponse,
  externalNavigationRequestSchema,
  externalNavigationResponseSchema,
} from '../../shared/protocols/electron/external-navigation.ts';
import { authorizeSender, type SenderAuthorization } from '../project/dialog.ts';

export { EXTERNAL_NAVIGATION_CAPABILITY };

export interface ExternalNavigationDependencies extends SenderAuthorization {
  ipcMain: Pick<IpcMain, 'handle'>;
  openExternal(url: string): Promise<unknown>;
}

const failure = (
  kind: Exclude<ExternalNavigationResponse, { ok: true }>['failure']['kind'],
  message: string,
): ExternalNavigationResponse =>
  externalNavigationResponseSchema.parse({ failure: { kind, message }, ok: false });

export function registerExternalNavigation(dependencies: ExternalNavigationDependencies): void {
  dependencies.ipcMain.handle(EXTERNAL_NAVIGATION_OPEN_CHANNEL, async (event, rawRequest) => {
    const sender = authorizeSender(event, dependencies, EXTERNAL_NAVIGATION_CAPABILITY);
    if (!sender) {
      return failure('unauthorized', 'This window cannot open external links.');
    }
    const request = externalNavigationRequestSchema.safeParse(rawRequest);
    if (!request.success) return failure('invalid-request', 'This link cannot be opened.');

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Revalidated immediately above: no renderer-controlled scheme reaches Electron shell.
      // The OS can stall while resolving the default browser. The request has
      // already been handed off; bound the acknowledgement and permit a retry.
      await Promise.race([
        dependencies.openExternal(request.data.url),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Browser launch timed out.')), 10_000);
        }),
      ]);
      return externalNavigationResponseSchema.parse({ ok: true });
    } catch {
      return failure('unavailable', 'The system browser could not open this link.');
    } finally {
      clearTimeout(timer);
    }
  });
}
