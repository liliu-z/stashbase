/** The document font, from the reading fonts StashBase ships and the fonts
 *  installed on this computer. Settings' Font row and the reading menu's
 *  custom font open this one list, so a family chosen in either is the same
 *  write: it fills the custom font and puts it in use. The menu's list holds
 *  only installed fonts, its custom family first, since Serif and Sans sit
 *  beside it as samples of their own. */
import {
  customFontChange,
  isIncludedReadingFont,
  READING_FONT_CHOICES,
} from '@/features/settings/domain/appearance';
import type { AppearanceViewModel } from '@/features/settings/hooks/use-appearance';
import type { SystemTextViewModel } from '@/features/settings/hooks/use-system-text';

import { FontPicker, type FontPickerControl } from './font-picker';

export function DocumentFontPicker({
  appearance,
  control,
  system,
}: {
  appearance: AppearanceViewModel;
  control?: FontPickerControl;
  system: SystemTextViewModel;
}) {
  const preferences = appearance.preferences;
  const custom = preferences?.readingFont === 'custom';
  const family = preferences?.writingFont ?? null;
  return (
    <FontPicker
      {...(control ? { control } : {})}
      disabled={preferences === null}
      included={control ? [] : READING_FONT_CHOICES}
      includedValue={preferences && !custom ? preferences.readingFont : null}
      installed={system.fonts}
      installedFailure={system.fontsFailure?.message ?? null}
      label="Document font"
      onChooseIncluded={(value) => {
        if (isIncludedReadingFont(value)) appearance.change({ readingFont: value });
      }}
      onChooseInstalled={(chosen) => appearance.change(customFontChange(chosen))}
      value={control || custom ? family : null}
    />
  );
}
