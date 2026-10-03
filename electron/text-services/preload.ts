import {
  type SpellcheckLanguagesResponse,
  type SystemFontsResponse,
  spellcheckLanguagesResponseSchema,
  systemFontsResponseSchema,
  TEXT_SERVICES_FONTS_CHANNEL,
  TEXT_SERVICES_SPELLCHECK_LANGUAGES_CHANNEL,
} from '../../shared/protocols/electron/text-services.ts';

export interface IpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

export interface TextServicesPreload {
  listFonts(): Promise<SystemFontsResponse>;
  spellcheckLanguages(): Promise<SpellcheckLanguagesResponse>;
}

export function createTextServicesPreload(ipcRenderer: IpcRenderer): TextServicesPreload {
  const preload: TextServicesPreload = {
    async listFonts() {
      const parsed = systemFontsResponseSchema.safeParse(
        await ipcRenderer.invoke(TEXT_SERVICES_FONTS_CHANNEL),
      );
      return parsed.success ? parsed.data : { ok: false, error: 'The font list was invalid.' };
    },
    async spellcheckLanguages() {
      const parsed = spellcheckLanguagesResponseSchema.safeParse(
        await ipcRenderer.invoke(TEXT_SERVICES_SPELLCHECK_LANGUAGES_CHANNEL),
      );
      return parsed.success
        ? parsed.data
        : { ok: false, error: 'The spellcheck language list was invalid.' };
    },
  };
  return Object.freeze(preload);
}
