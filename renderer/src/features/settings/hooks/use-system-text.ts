import { useQuery } from '@tanstack/react-query';

import { settingsFailure } from '@/features/settings/application/failure-messages';
import type { SystemTextPort } from '@/features/settings/application/ports';
import {
  spellcheckLanguagesQuery,
  systemFontsQuery,
} from '@/features/settings/application/queries';
import type { SystemFont } from '@/features/settings/domain/appearance';
import type { FailureView } from '@/shared/domain/feature-error';

export interface SystemTextViewModel {
  /** Null while loading, where the list failed, or where no port exists. */
  readonly fonts: readonly SystemFont[] | null;
  readonly fontsFailure: FailureView | null;
  readonly spellcheckLanguages: readonly string[];
}

const NO_PORT: SystemTextPort = {
  listFonts: async () => [],
  spellcheckLanguages: async () => [],
};

/** The fonts and spellcheck languages this computer offers. Without a port
 *  (outside the desktop app) both lists are empty and only bundled fonts show. */
export function useSystemText(port: SystemTextPort | undefined): SystemTextViewModel {
  const fonts = useQuery(systemFontsQuery(port ?? NO_PORT));
  const languages = useQuery(spellcheckLanguagesQuery(port ?? NO_PORT));
  return {
    fonts: fonts.data ?? null,
    fontsFailure: fonts.isError ? settingsFailure(fonts.error) : null,
    spellcheckLanguages: languages.data ?? [],
  };
}
