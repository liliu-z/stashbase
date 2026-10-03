import type {
  SpellcheckLanguagesResponse,
  SystemFontsResponse,
} from '@/protocols/electron/text-services';

export interface TextServicesBridge {
  listFonts(): Promise<SystemFontsResponse>;
  spellcheckLanguages(): Promise<SpellcheckLanguagesResponse>;
}
