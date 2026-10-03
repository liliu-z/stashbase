import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import {
  type SpellcheckLanguagesResponse,
  type SystemFontsResponse,
  spellcheckLanguagesResponseSchema,
  systemFontsResponseSchema,
  TEXT_SERVICES_CAPABILITY,
  TEXT_SERVICES_FONTS_CHANNEL,
  TEXT_SERVICES_SPELLCHECK_LANGUAGES_CHANNEL,
} from '../../shared/protocols/electron/text-services.ts';
import { spellcheckLanguageSchema } from '../../shared/protocols/http/appearance.ts';
import { authorizeSender, type SenderAuthorization } from '../project/dialog.ts';

export { TEXT_SERVICES_CAPABILITY };

export interface TextServicesDependencies extends SenderAuthorization {
  ipcMain: Pick<IpcMain, 'handle'>;
  listFonts(): Promise<string[]>;
  spellcheckLanguages(): readonly string[];
}

export function registerTextServices(dependencies: TextServicesDependencies): void {
  // One enumeration per session: the list only changes when fonts are
  // installed, and a restart picks that up. A failure is not remembered.
  let fonts: Promise<string[]> | null = null;

  dependencies.ipcMain.handle(
    TEXT_SERVICES_FONTS_CHANNEL,
    async (event: IpcMainInvokeEvent): Promise<SystemFontsResponse> => {
      if (!authorizeSender(event, dependencies, TEXT_SERVICES_CAPABILITY)) {
        return { ok: false, error: 'This window cannot list fonts.' };
      }
      fonts ??= dependencies.listFonts();
      try {
        return systemFontsResponseSchema.parse({ ok: true, families: await fonts });
      } catch {
        fonts = null;
        return { ok: false, error: 'The installed fonts could not be listed.' };
      }
    },
  );

  dependencies.ipcMain.handle(
    TEXT_SERVICES_SPELLCHECK_LANGUAGES_CHANNEL,
    (event: IpcMainInvokeEvent): SpellcheckLanguagesResponse => {
      if (!authorizeSender(event, dependencies, TEXT_SERVICES_CAPABILITY)) {
        return { ok: false, error: 'This window cannot list spellcheck languages.' };
      }
      const languages = dependencies
        .spellcheckLanguages()
        .filter((language) => spellcheckLanguageSchema.safeParse(language).success);
      return spellcheckLanguagesResponseSchema.parse({ ok: true, languages });
    },
  );
}
