import { SettingsError, type SystemTextPort } from '@/features/settings/application/ports';
import type { SystemFont } from '@/features/settings/domain/appearance';
import type { TextServicesBridge } from '@/platform/electron/text-services';

/** The operating systems disagree on how, or whether, they mark a font
 *  fixed-pitch, so the renderer measures instead: a monospaced family draws
 *  a run of narrow and a run of wide glyphs at the same width. A family the
 *  engine cannot load measures as the fallback, which is not monospaced. */
function monospaceTest(): (family: string) => boolean {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return () => false;
  const width = (family: string, text: string) => {
    context.font = `32px "${family}", sans-serif`;
    return context.measureText(text).width;
  };
  return (family) => Math.abs(width(family, 'iiiiiiii') - width(family, 'WWWWWWWW')) < 0.5;
}

export function createSystemTextAdapter(bridge: TextServicesBridge): SystemTextPort {
  let fonts: Promise<readonly SystemFont[]> | null = null;
  return {
    listFonts() {
      fonts ??= bridge.listFonts().then((response) => {
        if (!response.ok) {
          fonts = null;
          throw new SettingsError('unavailable', response.error);
        }
        const monospace = monospaceTest();
        return response.families.map((family) => ({ family, monospace: monospace(family) }));
      });
      return fonts;
    },
    async spellcheckLanguages() {
      const response = await bridge.spellcheckLanguages();
      return response.ok ? response.languages : [];
    },
  };
}
